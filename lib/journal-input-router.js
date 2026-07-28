// Journal return-path routing: turns inbound journal frames (client `send` /
// `prompt_reply` ops, fanned back to the bridge's agent socket by the
// journal server) into bridge input. Pure filter/dispatch logic, no I/O — the
// caller (index.js) supplies session lookup, pending-prompt resolution, and
// reply/notice delivery as small injectable functions, so this module is
// unit-testable without booting the Matrix client or a real Claude session.
// See lib/journal-publisher.js's `onEvent` for how frames arrive here: every
// kind:'journal' frame, undiscriminated by sender — the loop-prevention
// filter (sender must start with `user:`) lives HERE, not in the publisher.

import { createConvoSeqRegistry } from './convo-seq-registry.js';

const QUEUED_RELEASE_SEQ_RETENTION = 512;

// Bound on how many recent picker frames stay dispatchable per convo. A long
// conversation that repeatedly opens pickers must not grow the record without
// limit (only the recent ones can plausibly be the frame a reply targets); the
// oldest are dropped past this window.
const PICKER_FRAME_RETENTION = 16;

const INPUT_TYPES = new Set(['text', 'prompt_reply']);
const QUEUED_RELEASE_ACTIONS = new Set(['send', 'cancel']);
// Client-sent media events (a Matron file/image/voice-note send). Routed only
// when a routeMediaToSession seam is supplied; without it, file/image frames
// fall through untouched exactly as they always have (publish-only). The
// blob itself is NOT in the frame — the payload carries a blob_ref the caller
// fetches out of the journal blob store.
const MEDIA_TYPES = new Set(['file', 'image']);

// Issue #98: the bridge publishes a `prompt` event for EVERY button message
// it sends — including the no-arg /model, /effort and /mode pickers and the
// queued-while-busy "📨 Queued" notification. None of those create
// pending-answer state in the bridge (pickers are answered — if at all —
// via Matrix button values like `model:<alias>`; queued-release taps DO arrive
// as journal prompt_replies now, classified by target_seq membership and
// intercepted before the guard in onJournalEvent below), so they must not
// advance the reply staleness guard:
// recording them made the guard falsely refuse a valid reply to the prompt
// the user was actually looking at, just because a picker was mirrored
// between the prompt and the reply.
//
// Classified by option ID shape — ids are bridge-controlled constants
// (never user or model text), which is what makes shape-matching safe:
//   answerable:     prompt-opt-<n>  (iv TUI prompts, lib/prompt-buttons.js)
//                   opt_<letter>    (AskUserQuestion sets, sendAllQuestions)
//   non-answerable: model-* / effort-* / mode-*  (pickers)
//                   cancel / interrupt           (queue-notification actions)
// Defaults to TRUE (guard stays active) for anything unrecognized, so a
// future answerable prompt kind fails safe — worst case a refusal notice —
// rather than silently unguarded.
const PICKER_OPTION_ID = /^(?:model|effort|mode)-/;
const QUEUE_ACTION_OPTION_IDS = new Set(['cancel', 'interrupt']);

export function promptExpectsReply(payload) {
  if (payload?.kind === 'queued_release') return false;
  const options = Array.isArray(payload?.options) ? payload.options : [];
  if (options.length === 0) return true;
  return !options.every(o => o && typeof o.id === 'string'
    && (PICKER_OPTION_ID.test(o.id) || QUEUE_ACTION_OPTION_IDS.has(o.id)));
}

// A /model, /effort or /mode picker frame: every option id is a picker id
// (model-* / effort-* / mode-*). Distinct from a queue-notification frame
// (cancel / interrupt ids). Used to record picker frames so a reply can be
// dispatched as a picker command ONLY when its target_seq names one of these
// frames AND its choice is one of THAT frame's own offered values — value shape
// alone can't prove picker origin (an AskUserQuestion option's value is its raw
// model-generated label), and a frame must not authorize a value it never
// offered (e.g. a mode picker must not honour a model: value).
export function isPickerFrame(payload) {
  const options = Array.isArray(payload?.options) ? payload.options : [];
  return options.length > 0
    && options.every(o => o && typeof o.id === 'string' && PICKER_OPTION_ID.test(o.id));
}

// The set of option VALUES a picker frame offered (e.g. {'model:sonnet',
// 'model:opus'}). A reply's choice must be a member to be dispatched as a
// command against that frame.
export function pickerFrameValues(payload) {
  const options = Array.isArray(payload?.options) ? payload.options : [];
  const values = new Set();
  for (const o of options) {
    if (o && typeof o.value === 'string') values.add(o.value);
  }
  return values;
}

// Resolve a prompt_reply's `choice` against a pending prompt's option list.
// `options` is the same `[{id, label, ...}]` shape journaled as a `prompt`
// event's `options` field (see lib/prompt-buttons.js promptButtons() and
// index.js's sendAllQuestions button-building — both already produce this
// shape). Liberal per the brief: accepts a 1-based number, an option id, an
// option value, or a case-insensitive label match, in that order. Value
// matching matters because a Matron card tap sends the button's VALUE as
// `choice` (the app's .buttonResponse channel sends values — same channel
// the queue-tile actions arrive on): iv TUI prompt buttons carry
// value `prompt-opt:<i>` alongside id `prompt-opt-<i>`, so without it every
// tap on a TUI prompt (login picker, permission confirms) failed to resolve
// and the user got "Nothing to answer right now". Returns
// `{ option, index }` on a match, or null (never throws, tolerates a
// missing/non-array options list). Free-text fallback (when `choice` doesn't
// resolve, or a prompt has no fixed options at all) is the caller's job —
// this function only ever answers "does `choice` name one of `options`?".
export function resolvePromptChoice(options, choice) {
  const list = Array.isArray(options) ? options : [];
  if (choice == null) return null;
  const choiceStr = String(choice).trim();
  if (!choiceStr) return null;

  if (/^\d+$/.test(choiceStr)) {
    const idx = parseInt(choiceStr, 10) - 1;
    if (idx >= 0 && idx < list.length) return { option: list[idx], index: idx };
  }

  let idx = list.findIndex(o => o && String(o.id) === choiceStr);
  if (idx !== -1) return { option: list[idx], index: idx };

  idx = list.findIndex(o => o && o.value != null && String(o.value) === choiceStr);
  if (idx !== -1) return { option: list[idx], index: idx };

  idx = list.findIndex(o => o && typeof o.label === 'string' && o.label.toLowerCase() === choiceStr.toLowerCase());
  if (idx !== -1) return { option: list[idx], index: idx };

  return null;
}

// Build the routing function index.js wires as journal-publisher's `onEvent`.
// Every argument is an injectable seam:
//   isControlConvo(convoId) -> bool
//   handleControlCommand(commandBody, {username}) -> void (may be async; not awaited)
//   findSessionByConvoId(convoId) -> session-like object | null
//   routeTextToSession(session, body, {username}) -> void
//   routeMediaToSession(session, {type, blobRef, contentType, name, size, dims}, {username}) -> void (optional)
//   routePromptReply(session, {target_seq, choice, text}, {username}) -> void
//   resumeSessionForConvo(convoId, {username}) -> session-like object | null (optional)
//   noticeUnknownConvo(convoId, {type, username}) -> void (optional)
//   noticeStalePromptReply(convoId, {username, targetSeq, latestSeq}) -> void (optional)
//   noticeQueuedReleaseIgnored(convoId, {reason, username}) -> void (optional)
//   noticeGhostPromptReply(convoId, {username, targetSeq}) -> void (optional)
//   emitRelease(convoId, {promptId, action, releasedIds}) -> void (optional)
//   processStartSeq: number | null — journal high-water at process start; a
//     prompt_reply whose target_seq is <= this predates this bridge process
//     and is refused (the ghost-answer window). Null disables the check.
export function createJournalInputConsumer({
  isControlConvo,
  handleControlCommand,
  findSessionByConvoId,
  routeTextToSession,
  routeMediaToSession,
  routePromptReply,
  resumeSessionForConvo,
  noticeUnknownConvo,
  noticeStalePromptReply,
  noticeQueuedReleaseIgnored,
  noticeGhostPromptReply,
  processStartSeq = null,
  emitRelease,
  log = console,
} = {}) {
  function warn(msg) {
    try { log.warn(msg); } catch { /* logging must never throw */ }
  }

  // Staleness-guard state: the journal seq of the latest ANSWERABLE `prompt`
  // event seen per convo (promptExpectsReply above — pickers and queue
  // notifications never advance it, issue #98). Recorded from prompt frames
  // — which in practice means the bridge's OWN published prompts echoing
  // back with sender agent:*, so this bookkeeping happens BEFORE the user:*
  // input filter below. Used to refuse a prompt_reply whose target_seq
  // references a prompt that has since been superseded by a newer one:
  // without it, a delayed reply resolves against whatever prompt is
  // CURRENTLY pending and can mis-answer it. In-memory only — after a bridge
  // restart there's no record for a convo, and its replies are accepted
  // exactly as before (fails open). Evicted on session teardown via
  // evictConvo (attached to the returned function below) so entries for dead
  // convos don't accumulate for the life of the process.
  const latestPromptSeqByConvo = new Map();
  // Picker frames (/model, /effort, /mode) the bridge published per convo, as
  // seq -> {the exact option VALUES that frame offered}. A picker reply is
  // dispatched as a command ONLY when its target_seq names one of these frames
  // AND its choice is one of that frame's values — binding the dispatch to the
  // originating frame (not the reply's value shape), so neither a genuine
  // answer that merely looks like a picker value nor a value the frame never
  // offered can trigger an unintended switch. Bounded per convo, and each frame
  // is single-use (consumed on dispatch, below). Same in-memory / evict-on-
  // teardown contract as latestPromptSeqByConvo. KNOWN LIMITATION: this record
  // is process-local, so after a bridge restart a picker card published before
  // the restart is no longer dispatchable (its reply falls through to ordinary
  // prompt handling). That is acceptable here because a journal-bridge restart
  // does not carry live sessions across anyway — the card's session is gone, so
  // the switch has nothing to act on. A durable design (validating target_seq
  // against the canonical journal event) is deferred.
  const pickerFrames = createConvoSeqRegistry({ retention: PICKER_FRAME_RETENTION });
  // Stable queue-card identity is owned here rather than on a session because
  // prompt echoes arrive before session lookup. `queuedReleaseSeqs` is a
  // bounded classification tombstone (seq -> true): resolving a card removes
  // its live prompt entry from `queuedPrompts`, but its echoed seq stays
  // recognizable until retention eviction or terminal convo eviction.
  // `queuedPrompts` maps prompt_id -> { prompt_id, itemIds, seq }. Both share
  // the same per-convo-registry primitive as the picker frames above.
  const queuedReleaseSeqs = createConvoSeqRegistry();
  const queuedPrompts = createConvoSeqRegistry();

  // Drop resolved release seqs past the retention window, keeping every seq
  // still bound to a live queued prompt. Recomputed from `queuedPrompts` so the
  // "is this seq still live?" test never drifts from the source of truth.
  function pruneReleaseSeqs(convoId) {
    const liveSeqs = new Set();
    for (const entry of queuedPrompts.values(convoId)) {
      if (Number.isInteger(entry.seq)) liveSeqs.add(entry.seq);
    }
    queuedReleaseSeqs.pruneWhere(convoId, QUEUED_RELEASE_SEQ_RETENTION, seq => liveSeqs.has(seq));
  }

  function noteQueued(convoId, { promptId, itemId } = {}) {
    if (typeof convoId !== 'string' || !convoId
      || typeof promptId !== 'string' || !promptId
      || typeof itemId !== 'string' || !itemId) return;
    const existing = queuedPrompts.get(convoId, promptId);
    if (existing) {
      if (!existing.itemIds.includes(itemId)) existing.itemIds.push(itemId);
      return;
    }
    queuedPrompts.set(convoId, promptId, { prompt_id: promptId, itemIds: [itemId], seq: null });
  }

  function annotateSeq(convoId, seq, promptId) {
    if (typeof convoId !== 'string' || !convoId || !Number.isInteger(seq)) return;
    queuedReleaseSeqs.set(convoId, seq, true);
    const entry = queuedPrompts.get(convoId, promptId);
    if (entry) entry.seq = seq;
    pruneReleaseSeqs(convoId);
  }

  function classifyBySeq(convoId, targetSeq) {
    if (!queuedReleaseSeqs.has(convoId, targetSeq)) {
      return { state: 'unknown' };
    }
    for (const entry of queuedPrompts.values(convoId)) {
      if (entry.seq === targetSeq) {
        return {
          state: 'live',
          entry: { ...entry, itemIds: [...entry.itemIds] },
        };
      }
    }
    return { state: 'tombstoned' };
  }

  function dropItem(convoId, itemId) {
    for (const [promptId, entry] of queuedPrompts.entries(convoId)) {
      const index = entry.itemIds.indexOf(itemId);
      if (index === -1) continue;
      entry.itemIds.splice(index, 1);
      if (entry.itemIds.length === 0) queuedPrompts.delete(convoId, promptId);
      pruneReleaseSeqs(convoId);
      return;
    }
  }

  function listLive(convoId) {
    const live = [];
    for (const [promptId, entry] of queuedPrompts.entries(convoId)) {
      for (const itemId of entry.itemIds) live.push({ promptId, itemId });
    }
    return live;
  }

  function carryForward(fromConvoId, toConvoId) {
    if (typeof fromConvoId !== 'string' || !fromConvoId
      || typeof toConvoId !== 'string' || !toConvoId
      || fromConvoId === toConvoId) return;
    // Seqs: source ordered first, presence-only so collisions are harmless.
    queuedReleaseSeqs.merge(fromConvoId, toConvoId, { fromFirst: true });
    // Prompts: target ordered first, source wins a prompt_id collision (its
    // entry is the more recent one being carried forward).
    queuedPrompts.merge(fromConvoId, toConvoId, { fromFirst: false });
    pruneReleaseSeqs(toConvoId);
  }

  const queueRelease = Object.freeze({
    noteQueued,
    annotateSeq,
    classifyBySeq,
    dropItem,
    listLive,
    carryForward,
  });

  function onJournalEvent(frame) {
    try {
      if (!frame || typeof frame !== 'object') return;
      const { sender, type, convo_id: convoId, payload } = frame;

      if (type === 'prompt' && Number.isInteger(frame.seq)) {
        if (promptExpectsReply(payload)) {
          latestPromptSeqByConvo.set(convoId, frame.seq);
        } else if (isPickerFrame(payload)) {
          // The registry bounds growth by insertion order (drops the oldest
          // frame past PICKER_FRAME_RETENTION) on set.
          pickerFrames.set(convoId, frame.seq, pickerFrameValues(payload));
        } else if (typeof sender === 'string' && sender.startsWith('agent:')
          && payload?.kind === 'queued_release') {
          queueRelease.annotateSeq(convoId, frame.seq, payload?.prompt_id);
        }
      }

      // Loop-prevention filter: only genuine client-origin events are input.
      // The bridge's own publishes (and every echo of them) come back with
      // sender `agent:<device>` and must never be treated as input, or a
      // bridge notice/echo would re-trigger itself.
      if (typeof sender !== 'string' || !sender.startsWith('user:')) return;
      // Media (file/image) is only an input type when the caller wired a
      // routeMediaToSession seam; otherwise it stays a pass-through publish,
      // exactly as before this feature existed.
      const isMedia = MEDIA_TYPES.has(type) && typeof routeMediaToSession === 'function';
      if (!INPUT_TYPES.has(type) && !isMedia) return;

      const username = sender.slice('user:'.length);
      const ctx = { username };

      if (isControlConvo(convoId)) {
        // The control convo only understands commands, which arrive as text.
        // A prompt_reply there has nothing to answer — ignore.
        if (type !== 'text') return;
        const body = typeof payload?.body === 'string' ? payload.body.trim() : '';
        if (!body) return;
        handleControlCommand(body, ctx);
        return;
      }

      // A media frame's blob_ref, resolved up front because it gates BOTH the
      // auto-resume below (a frame with nothing to fetch must not respawn a
      // session) and the media routing itself (falling back to a top-level
      // blob_ref if that's the shape the server delivers).
      const blobRef = !isMedia ? null
        : (typeof payload?.blob_ref === 'string' && payload.blob_ref)
          ? payload.blob_ref
          : (typeof frame.blob_ref === 'string' && frame.blob_ref ? frame.blob_ref : null);

      let session = findSessionByConvoId(convoId);
      if (!session && (type === 'text' || isMedia) && resumeSessionForConvo) {
        // Reaped-but-resumable convo: the idle reaper kills sessions on the
        // assumption that "the next user message auto-resumes" — give the
        // caller the same chance the Matrix room path gets before declaring
        // the convo dead. Text and media both qualify (delivery after the
        // wake is safe: print mode's stdin buffers, iv mode's resume hold
        // parks input until the TUI is ready), but only with something to
        // deliver — a blank message or a blob_ref-less media frame must not
        // respawn a session. A prompt_reply never resumes: its pending
        // prompt died with the process, so there's nothing valid to answer.
        const body = typeof payload?.body === 'string' ? payload.body.trim() : '';
        if (type === 'text' ? body : blobRef) {
          try {
            session = resumeSessionForConvo(convoId, ctx) || null;
          } catch (e) {
            warn(`[journal-input] resumeSessionForConvo failed for convo=${convoId}: ${e.message}`);
          }
        }
      }
      if (!session) {
        // Replay after a restart, or the session died in the meantime —
        // tolerate it: log and notice, never crash.
        warn(`[journal-input] ${type} event for unknown/dead session convo=${convoId} — ignoring`);
        if (noticeUnknownConvo) {
          try { noticeUnknownConvo(convoId, { type, username }); } catch (e) { warn(`[journal-input] noticeUnknownConvo failed: ${e.message}`); }
        }
        return;
      }

      if (type === 'text') {
        const body = typeof payload?.body === 'string' ? payload.body.trim() : '';
        if (!body) {
          warn(`[journal-input] text event with no usable body, convo=${convoId} — skipping`);
          return;
        }
        routeTextToSession(session, body, ctx);
        return;
      }

      if (isMedia) {
        // A client-sent file/image/voice-note. The bytes aren't in the frame;
        // the payload names a blob_ref (resolved above) the caller fetches out
        // of the journal blob store. A frame with no usable blob_ref is
        // dropped — there's nothing to fetch, and (per the brief) an
        // unresolvable media event must never inject a placeholder into the
        // prompt.
        if (!blobRef) {
          warn(`[journal-input] ${type} event with no blob_ref, convo=${convoId} — skipping`);
          return;
        }
        routeMediaToSession(session, {
          type,
          blobRef,
          contentType: typeof payload?.content_type === 'string' ? payload.content_type : null,
          name: typeof payload?.name === 'string' ? payload.name : null,
          size: payload?.size ?? null,
          dims: payload?.dims ?? null,
          // What the user typed alongside the attachment. Carrying it here
          // is what lets claude see the picture and the sentence about it as
          // one prompt, instead of the picture arriving alone and the
          // explanation following as a separate turn it may already have
          // started answering.
          caption: typeof payload?.caption === 'string' && payload.caption.trim()
            ? payload.caption
            : null,
        }, ctx);
        return;
      }

      // type === 'prompt_reply'.
      const targetSeq = payload?.target_seq;

      // Ghost-answer window: a reply whose target_seq predates this bridge
      // process targets a prompt published by a PREVIOUS process — its asking
      // session is gone. resolvePromptChoice matches options by case-insensitive
      // label, and this feature's queued-release wire values (send / cancel)
      // are common real-prompt labels, so routing such a reply to whatever
      // prompt is currently pending could silently answer the WRONG one. Refuse
      // it (with a notice, never a silent no-op). Cards this process published
      // always carry seq > processStartSeq, so a live tap is never caught here.
      if (Number.isInteger(processStartSeq)
        && Number.isInteger(targetSeq)
        && targetSeq <= processStartSeq) {
        warn(`[journal-input] ghost prompt_reply for convo=${convoId}: target_seq=${targetSeq} predates process start seq=${processStartSeq} — refusing`);
        if (noticeGhostPromptReply) {
          try { noticeGhostPromptReply(convoId, { username, targetSeq }); } catch (e) { warn(`[journal-input] noticeGhostPromptReply failed: ${e.message}`); }
        }
        return;
      }

      // A queued-release tap is proven by the target seq of the bridge-authored
      // card, never by the reply value: ordinary prompts are allowed to offer
      // choices literally named "send" or "cancel". Intercept before the
      // staleness guard because a queued-release card is deliberately
      // non-answerable and therefore never advances latestPromptSeqByConvo.
      const queuedRelease = queueRelease.classifyBySeq(convoId, targetSeq);
      if (queuedRelease.state !== 'unknown') {
        if (!QUEUED_RELEASE_ACTIONS.has(payload?.choice)) {
          // A tap the card can't action (unknown wire value). Never silently
          // no-op — mirror the staleness guard and tell the user, since they
          // pressed a button and expect a result.
          warn(`[journal-input] invalid queued_release action for convo=${convoId}: target_seq=${String(targetSeq)} — ignoring`);
          noticeQueuedReleaseIgnored?.(convoId, { reason: 'invalid-action', username });
          return;
        }
        // The tombstone outlives the live entry so duplicate and late taps
        // remain classified as queue actions instead of falling through to
        // the ordinary answer path. Surface it — a tap on an already-resolved
        // card should confirm "already handled", not vanish.
        if (queuedRelease.state === 'tombstoned') {
          noticeQueuedReleaseIgnored?.(convoId, { reason: 'tombstoned', username });
          return;
        }
        routePromptReply(session, {
          target_seq: targetSeq ?? null,
          choice: payload.choice,
          text: payload?.text ?? null,
        }, ctx);
        return;
      }

      // NOTE: value-shape classification of queue taps ("interrupt" / "cancel:N")
      // is retired (issue #165). A queue tap is proven ONLY by target_seq
      // membership above; a genuine prompt answer whose label merely looks like
      // a queue action ("interrupt", "cancel:2") therefore flows through the
      // ordinary staleness + answer path below like any other answer, and a
      // stale pre-deploy positional tap surfaces as a stale / nothing-to-answer
      // notice there rather than being silently swallowed.

      // Picker taps (/model, /effort, /mode): a picker frame never advances the
      // staleness guard (non-answerable, issue #98), so a genuine tap would be
      // wrongly refused as stale. Dispatch it as a command — with explicit
      // provenance (`picker: true`) — ONLY when target_seq names a picker frame
      // the bridge actually published AND the choice is one of THAT frame's own
      // offered values. This is the single source of truth for picker-vs-answer:
      // the receiver trusts the flag and never re-guesses by value shape, so a
      // genuine answer whose label merely looks like a picker value (an
      // AskUserQuestion option can be labeled literally `model:sonnet`) is never
      // dispatched as a command, and a verified picker tap is never swallowed as
      // a prompt answer.
      const offeredValues = payload?.target_seq != null
        ? pickerFrames.get(convoId, payload.target_seq)
        : null;
      if (offeredValues && offeredValues.has(payload?.choice)) {
        // Single-use: consume the frame before dispatch so a double-tap or
        // client retry (a second prompt_reply for the same target_seq) doesn't
        // fire the switch twice — which would restart a print session twice or
        // write effort into the PTY twice. Reopening the picker publishes a
        // fresh frame with a new seq.
        pickerFrames.delete(convoId, payload.target_seq);
        routePromptReply(session, {
          target_seq: payload.target_seq,
          choice: payload.choice,
          text: payload?.text ?? null,
          picker: true,
        }, ctx);
        return;
      }

      // Staleness check: a target_seq that
      // doesn't reference the latest prompt we published into this convo
      // means the prompt the user answered has been superseded — refuse
      // rather than mis-answer the newer one. No recorded seq (restart,
      // live-only reconnect) or no target_seq -> nothing to check, accept.
      const latestSeq = latestPromptSeqByConvo.get(convoId);
      if (targetSeq != null && latestSeq !== undefined && targetSeq !== latestSeq) {
        warn(`[journal-input] stale prompt_reply for convo=${convoId}: target_seq=${targetSeq} but latest prompt is seq=${latestSeq} — refusing`);
        if (noticeStalePromptReply) {
          try { noticeStalePromptReply(convoId, { username, targetSeq, latestSeq }); } catch (e) { warn(`[journal-input] noticeStalePromptReply failed: ${e.message}`); }
        }
        return;
      }
      routePromptReply(session, {
        target_seq: targetSeq,
        choice: payload?.choice ?? null,
        text: payload?.text ?? null,
      }, ctx);
    } catch (e) {
      warn(`[journal-input] consumer threw: ${e.message}`);
    }
  }

  // Session-teardown eviction for all per-convo input state. Resolve every
  // still-live queue card before its registry is removed, then let the caller
  // clear the session queue between that release commitment and eviction.
  // This ordering prevents terminal stop/exit/reap from leaving apparently
  // actionable cards behind. Repeated eviction is idempotent because the
  // first call removes the live registry entries.
  onJournalEvent.evictConvo = function evictConvo(convoId, { clearQueue } = {}) {
    if (typeof emitRelease === 'function') {
      for (const { promptId, itemId } of queueRelease.listLive(convoId)) {
        emitRelease(convoId, {
          promptId,
          action: 'cancel',
          releasedIds: [itemId],
        });
      }
    }
    if (typeof clearQueue === 'function') clearQueue();
    latestPromptSeqByConvo.delete(convoId);
    pickerFrames.evict(convoId);
    queuedReleaseSeqs.evict(convoId);
    queuedPrompts.evict(convoId);
  };
  onJournalEvent.queueRelease = queueRelease;

  return onJournalEvent;
}
