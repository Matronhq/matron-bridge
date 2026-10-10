// Structured markers on bridge-posted journal events, so a client can tell a
// bridge notice line from the agent's own words, and an injected turn from
// the turn before it, without matching on notice text.
//
// Two optional, additive payload keys (older clients ignore unknown keys and
// the text body is unchanged):
//
// - payload.notice: string — the class of a bridge-authored status line
//   (NOTICE below). Set at the emit site, never inferred from the text.
//
// - payload.turn_start: { origin: string } — set on the FIRST event the
//   bridge publishes for a turn that a journal user message did not start
//   (an injected turn: a routine, a reminder, a Coordinator carry-on, a room
//   message, ...). A user-started turn already opens on the user's own event,
//   so it never carries one.
//
// How turn_start finds that first event: the injecting site ARMS the session
// (announceTurnStart when it posts a notice line ahead of the turn, or
// sendToSession's turnOrigin option once the backend accepts the turn), and
// every row index.js publishes for that session (journalPublish,
// journalPublishNotice, the Codex wiring's publisher view, a tool output's
// finalize) TAKES the arm through withTurnStart, so exactly one event per
// turn carries it. Every dispatch re-decides the arm: a turn dispatched
// without an origin (a user message) or a refused send clears it, and every
// turn end drops whatever its turn left unused (noteTurnEnd), so an arm
// cannot leak into a later turn.

export const NOTICE = Object.freeze({
  COMPACTION: 'compaction',
  RESTART: 'restart',
  CRASH_RESTART: 'crash_restart',
  DELIVERY_FAILED: 'delivery_failed',
  SLOW_TOOL: 'slow_tool',
  CONTROL: 'control',
});

export const TURN_ORIGIN = Object.freeze({
  ROUTINE: 'routine',
  REMINDER: 'reminder',
  // An unseen-items nudge handed to the Coordinator.
  NUDGE: 'nudge',
  ALERT: 'alert',
  CARRY_ON: 'carry_on',
  // A room message, chat request or room lifecycle line delivered as a turn.
  PEER: 'peer',
  // A consent request handed to the Coordinator.
  CONSENT: 'consent',
  // The automatic carry-on once a usage limit resets. A Coordinator
  // carry_on sent with when: after_limit_reset rides that same reset slot,
  // so it arrives as usage_limit too, not carry_on.
  USAGE_LIMIT: 'usage_limit',
  // A Coordinator-requested /compact (session control `compact`).
  COMPACT: 'compact',
  // The turn that tells a session it was made (or stopped being) Coordinator.
  COORDINATOR: 'coordinator',
  // A tracker item reply/comment delivered as a turn.
  ITEM: 'item',
  // A submitted secret request delivered as a turn.
  SECRET: 'secret',
  // The opening turn of a spawned session, and a spawn outcome delivered to
  // the session that asked for it.
  SPAWN: 'spawn',
});

// Session-control action -> the origin of the turn it injects (null: the
// action starts no turn of its own, e.g. a model switch).
export function controlTurnOrigin(action) {
  switch (action) {
    case 'carry_on': return TURN_ORIGIN.CARRY_ON;
    case 'alert': return TURN_ORIGIN.ALERT;
    case 'routine': return TURN_ORIGIN.ROUTINE;
    case 'compact': return TURN_ORIGIN.COMPACT;
    default: return null;
  }
}

// Whether a notice line posted now would be the first line of the injected
// turn rather than a line inside a turn that is still running, AND the
// session would accept that turn. A resume hold does not count as running:
// the held text is the next turn. The refusals mirror sendToSession's own
// up-front ones (a dead or auto-stopped session, a Codex sign-in in
// progress), so an announced line is not followed by a refused send; only a
// transport failure at the moment of sending can still refuse it.
export function canAnnounceTurn(session) {
  if (!session || !session.alive || session._autoStopped) return false;
  if (session.busy || session.waitingForAnswer || session.pendingInteractivePrompt || session.pendingUnclassifiedPrompt) return false;
  if (session.codex?.transport === 'app-server' && (session._codexAccountCommandPending || session._codexLoginId)) return false;
  return true;
}

// Arm the session so the next published event (the notice line the caller is
// about to post) carries turn_start. The dispatch that follows with the same
// origin keeps the arm as published instead of re-arming it.
export function announceTurnStart(session, origin) {
  if (!session || typeof origin !== 'string' || !origin) return false;
  session._journalTurnStart = { origin, published: false, dispatched: false };
  // A newer turn now opens on this line: a late row of the previous turn
  // landing after it must not reopen that turn.
  session._journalHeldTurnStart = null;
  return true;
}

// Called at the one point a turn is actually dispatched. origin null = a turn
// the journal already shows a user event for (or that the bridge mirrors as
// one), which clears any arm.
export function noteTurnDispatch(session, origin) {
  if (!session) return;
  session._journalTurnSeq = turnSeq(session) + 1;
  session._journalHeldTurnStart = null;
  if (typeof origin !== 'string' || !origin) {
    session._journalTurnStart = null;
    return;
  }
  const cur = session._journalTurnStart;
  if (cur && !cur.dispatched && cur.origin === origin) {
    cur.dispatched = true;
    return;
  }
  session._journalTurnStart = { origin, published: false, dispatched: true };
}

// Called at each turn-end seam (iv onTurnEnd, the print-mode result,
// finishCodexTurn) before anything there dispatches the next turn. A turn
// that published no row (a silent tool call, an answer given only through
// agent_chat_send) would otherwise hand its arm to whatever is published next
// for the session; an announced line whose turn never dispatched would make
// the next dispatch of the same origin reuse it and arm nothing.
//
// A row of the turn that is still being produced (a tool output finalizing
// after an async upload, holdTurnRow) may still be the turn's first: its
// unpublished marker moves aside for that row alone (withTurnRowStart), so
// no other line published in the meantime can take it.
export function noteTurnEnd(session) {
  if (!session) return;
  const cur = session._journalTurnStart;
  session._journalTurnStart = null;
  const seq = turnSeq(session);
  if (cur && !cur.published && cur.dispatched && session._journalTurnRowsHeld?.get(seq)) {
    session._journalHeldTurnStart = { seq, origin: cur.origin };
  }
}

// Marks a row of the current turn as still on its way; returns the release,
// called once that row is published (or has failed). The last release of a
// turn drops a marker set aside for it that no row took.
export function holdTurnRow(session) {
  if (!session) return () => {};
  const seq = turnSeq(session);
  const held = (session._journalTurnRowsHeld ||= new Map());
  held.set(seq, (held.get(seq) || 0) + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const left = (held.get(seq) || 1) - 1;
    if (left > 0) { held.set(seq, left); return; }
    held.delete(seq);
    if (session._journalHeldTurnStart?.seq === seq) session._journalHeldTurnStart = null;
  };
}

// withTurnStart for a row produced late by the turn numbered `seq`: nothing
// once a later turn has been dispatched; the marker set aside at turn end if
// there is one; otherwise the live arm, as for any row of the current turn.
export function withTurnRowStart(session, seq, method, payload) {
  if (seq !== turnSeq(session)) return payload;
  const held = session._journalHeldTurnStart;
  if (held && held.seq === seq && TURN_EVENT_METHODS.has(method) && payload && typeof payload === 'object' && payload.from !== 'user') {
    session._journalHeldTurnStart = null;
    return { ...payload, turn_start: { origin: held.origin } };
  }
  return withTurnStart(session, method, payload);
}

// A counter bumped by every dispatch decision, so a row produced late (a tool
// output finalized asynchronously) can tell whether the turn it belongs to is
// still the current one before it takes that turn's marker.
export function turnSeq(session) {
  return Number.isInteger(session?._journalTurnSeq) ? session._journalTurnSeq : 0;
}

// One-shot read: the marker for the event being published now, or null.
export function takeTurnStart(session) {
  const cur = session?._journalTurnStart;
  if (!cur || cur.published) return null;
  cur.published = true;
  return { origin: cur.origin };
}

// The publisher methods whose events open a turn in a client: anything the
// user sees as a row, published synchronously within the turn. Not convo
// upserts, read markers or ephemerals, and not the turn-end summary: it is
// produced asynchronously after its turn and can land after the next turn
// has been dispatched.
export const TURN_EVENT_METHODS = new Set([
  'publishText', 'publishPrompt', 'publishDiff',
  'publishToolOutput', 'publishFile', 'publishImage',
]);

// The payload to publish for (method, payload) on this session: unchanged
// unless this is the turn's first event, then a copy carrying turn_start.
// A user-mirrored row never takes the arm (it is not the agent's turn).
export function withTurnStart(session, method, payload) {
  if (!TURN_EVENT_METHODS.has(method)) return payload;
  if (!payload || typeof payload !== 'object' || payload.from === 'user') return payload;
  const ts = takeTurnStart(session);
  return ts ? { ...payload, turn_start: ts } : payload;
}

// The origin of a queued or held message travels with its blocks array, the
// way lib/queue-flush.js's journal-origin tag does: non-enumerable, so it
// never reaches JSON.stringify or block iteration.
const TURN_ORIGIN_KEY = '_turnOrigin';

export function markTurnOrigin(blocks, origin) {
  if (!Array.isArray(blocks) || typeof origin !== 'string' || !origin) return blocks;
  try {
    Object.defineProperty(blocks, TURN_ORIGIN_KEY, { value: origin, enumerable: false, configurable: true });
  } catch { /* frozen array: treat as untagged */ }
  return blocks;
}

export function turnOriginOf(blocks) {
  const o = blocks ? blocks[TURN_ORIGIN_KEY] : null;
  return typeof o === 'string' && o ? o : null;
}

// A merged flush is an injected turn only when EVERY entry in it was
// injected; one user message in the batch makes it the user's turn. The
// first entry names the origin.
export function mergedTurnOrigin(entries) {
  if (!Array.isArray(entries) || entries.length === 0) return null;
  const origins = entries.map(turnOriginOf);
  return origins.every(Boolean) ? origins[0] : null;
}
