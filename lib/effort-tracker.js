// Optimistic tracking of a Claude session's effort level, for the status
// frame's `effort` field (lib/session-status.js).
//
// CONTRACT — the bridge cannot READ the effort level back. No stream-json or
// transcript event carries it and no config file holds it. What is published
// here is a record of what the bridge itself successfully WROTE — an
// `--effort` spawn flag or an `/effort` command — never an observation, and
// it is UNKNOWN until a write settles. Unknown publishes as an ABSENT field —
// never a guess.
//
// The rules, one per test in test/effort-tracker.test.js:
//   - writing `/effort <level>` into the PTY only makes the level PENDING;
//   - a CONFIRMED change commits it. Mid-conversation the TUI raises a
//     "Change effort level?" menu (the prompt detector classifies it; see the
//     fixture in test/prompt-detector.test.js), and the user's accept answer
//     is the commit signal;
//   - when NO confirmation appears before the session goes idle again, the
//     write stands — a fresh/uncached session applies `/effort` silently;
//   - a DECLINED confirmation discards the pending write, leaving the
//     previous value (including unknown) standing;
//   - once a confirmation is armed, ONLY its answer settles the write: the
//     idle path stops applying, so an unanswered menu never commits;
//   - session start, restart, and resume reset to the level the spawn
//     passed as `--effort` (createSession seeds it), or to unknown when it
//     passed none: that session's effort comes from Claude Code's own
//     default, so carrying a value across would publish something false;
//   - a Coordinator-driven write (session_set_model with effort) may arm an
//     automatic accept of its own confirmation (armEffortAutoConfirm): the
//     Coordinator has no hand on the TUI, and the user did not ask.
//
// ACCEPTED GAP: `/effort` typed straight into the host terminal — not through
// the bridge — is invisible here. Its confirmation has no pending write to
// settle, so the tracked value keeps whatever the bridge last wrote until the
// next restart clears it.
//
// State lives on the session object (`session._effort`), so a fresh session
// object IS the reset; createSession seeds it from the flag it passed, and
// recreateSession hands the live level to the replacement as its `effort`
// option rather than copying the state across.

import { isValidEffortArg, normalizeEffortArg } from './effort-command.js';

// The TUI's mid-conversation confirmation. Matched on the question rather
// than the option labels: the labels name the level ("Yes, switch to xhigh"),
// the question is the stable part.
const EFFORT_CONFIRM_RE = /change\s+effort\s+level/i;

// An accepted confirmation. The menu is "Yes, switch to <level>" /
// "No, go back" — anything that is not an affirmative reads as a decline,
// which is the conservative direction (a decline only discards).
const CONFIRM_ACCEPTED_RE = /^\s*yes\b/i;

export function isEffortConfirmationPrompt(prompt) {
  return EFFORT_CONFIRM_RE.test(String(prompt?.question ?? ''));
}

function stateOf(session) {
  if (!session._effort) session._effort = { level: null, pending: null, awaitingConfirm: false };
  return session._effort;
}

// Record that `/effort <level>` reached the PTY. Callers pass the raw arg;
// a level outside EFFORT_LEVELS is refused outright so the frame can never
// publish a value the client's effort_levels list doesn't contain.
export function noteEffortWrite(session, level) {
  if (!session) return;
  if (!isValidEffortArg(level)) return;
  const state = stateOf(session);
  state.pending = normalizeEffortArg(level);
  state.awaitingConfirm = false;
  state.autoConfirm = null;
}

// The TUI asked the user to confirm the pending change. Arms the pending
// write so only the answer can settle it — see noteEffortIdle.
export function noteEffortConfirmationPrompt(session, prompt) {
  if (!session) return;
  const state = stateOf(session);
  if (!state.pending) return;
  if (!isEffortConfirmationPrompt(prompt)) return;
  state.awaitingConfirm = true;
}

// The user answered the confirmation. Accept commits the pending write;
// anything else discards it and leaves the previous value standing.
export function noteEffortConfirmationAnswer(session, prompt, optionLabel) {
  if (!session) return false;
  const state = stateOf(session);
  if (!state.awaitingConfirm) return false;
  if (!isEffortConfirmationPrompt(prompt)) return false;
  const accepted = CONFIRM_ACCEPTED_RE.test(String(optionLabel ?? ''));
  if (accepted) state.level = state.pending;
  state.pending = null;
  state.awaitingConfirm = false;
  state.autoConfirm = null;
  return accepted;
}

// The session went idle again with no confirmation in sight: the write stands.
// Returns true when a write was committed (the caller persists the level).
export function noteEffortIdle(session) {
  if (!session) return false;
  const state = stateOf(session);
  if (!state.pending || state.awaitingConfirm) return false;
  state.level = state.pending;
  state.pending = null;
  state.autoConfirm = null;
  return true;
}

// Session start / restart / resume: back to unknown, dropping any write still
// in flight.
export function resetEffortTracking(session) {
  if (!session) return;
  session._effort = { level: null, pending: null, awaitingConfirm: false };
}

// The Coordinator's effort switch: the confirmation its own write raises is
// accepted on its behalf. Armed for exactly that pending level, so a later
// write by the user (which replaces the pending level) is asked as usual.
export function armEffortAutoConfirm(session, level) {
  if (!session || !isValidEffortArg(level)) return;
  const state = stateOf(session);
  if (state.pending !== normalizeEffortArg(level)) return;
  state.autoConfirm = state.pending;
}

// The answer to send for an armed confirmation, or null when this prompt
// is for the user: {response, label} in the shape iv.respondToPrompt takes.
export function effortAutoConfirmResponse(session, prompt) {
  const state = session?._effort;
  if (!state || !state.autoConfirm || state.autoConfirm !== state.pending) return null;
  if (!isEffortConfirmationPrompt(prompt)) return null;
  const options = Array.isArray(prompt.options) ? prompt.options : [];
  const idx = options.findIndex(o => CONFIRM_ACCEPTED_RE.test(String(o?.label ?? '')));
  if (idx < 0) return null;
  const opt = options[idx];
  const response = prompt.kind === 'arrow-menu'
    ? { kind: 'arrow-menu', key: String(idx) }
    : { kind: prompt.kind, key: opt.key };
  return { response, label: opt.label };
}

// The current level, or null while it is unknown (the frame then omits the
// field entirely).
export function trackedEffort(session) {
  return session?._effort?.level ?? null;
}
