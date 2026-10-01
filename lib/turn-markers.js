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
// without an origin (a user message) or a refused send clears it, so an arm
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
  // The automatic carry-on once a usage limit resets.
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
  if (session.busy || session.waitingForAnswer || session.pendingInteractivePrompt) return false;
  if (session.codex?.transport === 'app-server' && (session._codexAccountCommandPending || session._codexLoginId)) return false;
  return true;
}

// Arm the session so the next published event (the notice line the caller is
// about to post) carries turn_start. The dispatch that follows with the same
// origin keeps the arm as published instead of re-arming it.
export function announceTurnStart(session, origin) {
  if (!session || typeof origin !== 'string' || !origin) return false;
  session._journalTurnStart = { origin, published: false, dispatched: false };
  return true;
}

// Called at the one point a turn is actually dispatched. origin null = a turn
// the journal already shows a user event for (or that the bridge mirrors as
// one), which clears any arm.
export function noteTurnDispatch(session, origin) {
  if (!session) return;
  session._journalTurnSeq = turnSeq(session) + 1;
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
