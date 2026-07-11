// Pure helpers for activity-ephemeral wiring (index.js -> journalPublisher.
// publishActivity). No session, no I/O — kept here, in the style of
// lib/session-mode.js and lib/model-aliases.js, so the state-change dedup
// and the detail truncation are unit-testable without a live session or a
// journal connection. index.js owns the per-session last-sent-state field
// (session._journalActivityState) and calls these two functions around it,
// exactly the way journalSessionState owns session._journalState.

// Send only on an actual change from the last state recorded for this
// session — the same decision journalSessionState makes for session_status,
// applied to activity instead. `lastState` is `undefined`/`null` on a
// session's first-ever activity send, which always counts as a change.
export function activityStateChanged(lastState, nextState) {
  return lastState !== nextState;
}

// Display-oriented trim for the 'tool' activity detail (a command string).
// The journal server itself hard-truncates at 200 chars (matron-journal
// src/ws.js ACTIVITY_DETAIL_MAX_CHARS) — this is a tighter, client-side trim
// so a typing indicator never carries a near-200-char command; it also
// matches the truncation length sendLiveOutputEvent already uses for the
// equivalent Matrix indicator/live-output body, so the two surfaces show the
// same command text.
const ACTIVITY_DETAIL_MAX_CHARS = 100;

export function truncateActivityDetail(command) {
  if (typeof command !== 'string') return undefined;
  return command.length > ACTIVITY_DETAIL_MAX_CHARS
    ? command.slice(0, ACTIVITY_DETAIL_MAX_CHARS) + '…'
    : command;
}
