// Journal return-path routing: turns inbound journal frames (client `send` /
// `prompt_reply` ops, fanned back to the bridge's agent socket by the
// journal server) into bridge input. Pure filter/dispatch logic, no I/O — the
// caller (index.js) supplies session lookup, pending-prompt resolution, and
// reply/notice delivery as small injectable functions, so this module is
// unit-testable without booting the Matrix client or a real Claude session.
// See lib/journal-publisher.js's `onEvent` for how frames arrive here: every
// kind:'journal' frame, undiscriminated by sender — the loop-prevention
// filter (sender must start with `user:`) lives HERE, not in the publisher.

const INPUT_TYPES = new Set(['text', 'prompt_reply']);

// Issue #98: the bridge publishes a `prompt` event for EVERY button message
// it sends — including the no-arg /model, /effort and /mode pickers and the
// queued-while-busy "📨 Queued" notification. None of those create
// pending-answer state in the bridge (they're answered — if at all — via
// Matrix button values like `model:<alias>`, never via a journal
// prompt_reply), so they must not advance the reply staleness guard below:
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
  const options = Array.isArray(payload?.options) ? payload.options : [];
  if (options.length === 0) return true;
  return !options.every(o => o && typeof o.id === 'string'
    && (PICKER_OPTION_ID.test(o.id) || QUEUE_ACTION_OPTION_IDS.has(o.id)));
}

// Resolve a prompt_reply's `choice` against a pending prompt's option list.
// `options` is the same `[{id, label, ...}]` shape journaled as a `prompt`
// event's `options` field (see lib/prompt-buttons.js promptButtons() and
// index.js's sendAllQuestions button-building — both already produce this
// shape). Liberal per the brief: accepts a 1-based number, an option id, or
// a case-insensitive label match, in that order. Returns
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
//   routePromptReply(session, {target_seq, choice, text}, {username}) -> void
//   resumeSessionForConvo(convoId, {username}) -> session-like object | null (optional)
//   noticeUnknownConvo(convoId, {type, username}) -> void (optional)
//   noticeStalePromptReply(convoId, {username, targetSeq, latestSeq}) -> void (optional)
export function createJournalInputConsumer({
  isControlConvo,
  handleControlCommand,
  findSessionByConvoId,
  routeTextToSession,
  routePromptReply,
  resumeSessionForConvo,
  noticeUnknownConvo,
  noticeStalePromptReply,
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

  function onJournalEvent(frame) {
    try {
      if (!frame || typeof frame !== 'object') return;
      const { sender, type, convo_id: convoId, payload } = frame;

      if (type === 'prompt' && Number.isInteger(frame.seq) && promptExpectsReply(payload)) {
        latestPromptSeqByConvo.set(convoId, frame.seq);
      }

      // Loop-prevention filter: only genuine client-origin events are input.
      // The bridge's own publishes (and every echo of them) come back with
      // sender `agent:<device>` and must never be treated as input, or a
      // bridge notice/echo would re-trigger itself.
      if (typeof sender !== 'string' || !sender.startsWith('user:')) return;
      if (!INPUT_TYPES.has(type)) return;

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

      let session = findSessionByConvoId(convoId);
      if (!session && type === 'text' && resumeSessionForConvo) {
        // Reaped-but-resumable convo: the idle reaper kills sessions on the
        // assumption that "the next user message auto-resumes" — give the
        // caller the same chance the Matrix room path gets before declaring
        // the convo dead. Only for a text event with a usable body: a blank
        // message must not respawn a session, and a prompt_reply's pending
        // prompt died with the process, so there's nothing valid to answer.
        const body = typeof payload?.body === 'string' ? payload.body.trim() : '';
        if (body) {
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

      // type === 'prompt_reply'. Staleness check first: a target_seq that
      // doesn't reference the latest prompt we published into this convo
      // means the prompt the user answered has been superseded — refuse
      // rather than mis-answer the newer one. No recorded seq (restart,
      // live-only reconnect) or no target_seq -> nothing to check, accept.
      const targetSeq = payload?.target_seq;
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

  // Session-teardown eviction for the staleness guard (issue #98 nit): the
  // map above otherwise grows one entry per convo for the life of the
  // process. Callers (index.js) invoke this wherever a session is TERMINALLY
  // torn down — the exit handlers' non-restart branches and !stop — and
  // deliberately NOT on auto-restart/recreateSession, where the same convo
  // (same claudeSessionId) lives on and its guard record is still meaningful.
  // Attached as a property (rather than changing the return shape) so
  // existing wiring that treats the consumer as a plain function keeps
  // working. Post-eviction replies fail open, the same contract as a bridge
  // restart.
  onJournalEvent.evictConvo = function evictConvo(convoId) {
    latestPromptSeqByConvo.delete(convoId);
  };

  return onJournalEvent;
}
