// Agent-initiated compaction — the decision half of the `compact_self` MCP
// tool. A session asks the bridge to compact its OWN context; the Coordinator
// is the one that needs it most (it never ends, and the journal's
// context-over routine now lists it like any other session), but any session
// may. The compact is parked in the same `compact` control slot a
// Coordinator-sent `session_compact` uses (lib/session-control.js), so it is
// persisted, drained at the shared free gate ahead of anything else, and
// never interrupts a turn: the tool is called mid-turn, the compaction runs
// when that turn ends.
//
// Nothing here touches the session beyond the flags it reads: index.js
// supplies park/apply/notify, and every rule below is unit-testable without
// a live session (the split lib/self-restart.js makes for restart_session).
import { AGENT_CODEX } from './agent-backend.js';
import { peerField } from './peer-text.js';

// A second self-compact this soon after the last one is refused. The loop
// it guards: a compact that leaves the gauge over the threshold, a routine
// that lists the session again, a compact, … The journal's trigger already
// fires once per crossing; this is the bridge's own backstop.
export function parseSelfCompactCooldownMs(value, fallback = 30 * 60 * 1000) {
  const n = Number.parseInt(value, 10);
  return Number.isSafeInteger(n) && n >= 0 ? n : fallback;
}
export const SELF_COMPACT_COOLDOWN_MS = parseSelfCompactCooldownMs(process.env.MATRON_SELF_COMPACT_COOLDOWN_MS);

// The whole /compact line stays under this. An interactive session gets it
// pasted into its TUI, and Claude Code collapses a paste of about 800
// characters or more into a "[Pasted text]" placeholder that is sent as an
// ordinary message, not run as /compact (measured on 2.1.291, 8 Oct 2026:
// 790 compacted, 820 did not). Print mode has no such limit; one budget
// keeps both alike.
export const COMMAND_MAX_CHARS = 760;
export const FOCUS_MAX_CHARS = 300;
export const REASON_MAX_CHARS = 200;

// What every self-compact's summary keeps. One line: a newline in the TUI
// would submit early.
export const BASE_INSTRUCTIONS = 'Keep the working state: goal and mission number; what is done, in progress and the exact next step; PRs, branches and worktree paths; item numbers filed or awaited; promises to the user not yet kept.';

// The Coordinator never finishes a task, so its state is a set of open
// threads rather than a next step.
export const COORDINATOR_INSTRUCTIONS = 'As Coordinator also keep every open thread with its ids: rooms and what each awaits; sessions started, carried on or switched in the last hour still to check; waiting consent cards and control outcomes; the user\'s latest asks and their items; your reminders; routines handled today.';

// The /compact text. Codex's native compaction takes no instructions
// (index.js refuses `/compact <text>` for it), so it gets the bare command.
// The focus is cut to whatever room the briefs leave under COMMAND_MAX_CHARS.
export function compactCommandFor({ agent, coordinator = false, focus = '' } = {}) {
  if (agent === AGENT_CODEX) return '/compact';
  let text = `/compact ${BASE_INSTRUCTIONS}`;
  if (coordinator) text += ` ${COORDINATOR_INSTRUCTIONS}`;
  const room = COMMAND_MAX_CHARS - text.length - ' Also keep: '.length;
  const f = room > 1 ? oneLine(focus, Math.min(room, FOCUS_MAX_CHARS)) : '';
  return f ? `${text} Also keep: ${f}` : text;
}

function oneLine(text, max) {
  return typeof text === 'string' ? peerField(text.replace(/\s+/g, ' '), max) : '';
}

// The /compact-self endpoint body, in the same injected-deps shape as
// createSelfRestartHandler:
//
//   getSession(roomId)       -> the live session, or null
//   isOccupied(session)      -> mid-turn / prompt open (lib/session-control.js occupied)
//   park(session, params)    -> stash in the `compact` control slot (persisted)
//   apply(session, params)   -> run it now (session already free)
//   notify(session, text)    -> tell the user what is about to happen
//   now()                    -> clock, for the cooldown
export function createSelfCompactHandler({ getSession, isOccupied, park, apply, notify, now = Date.now, cooldownMs = SELF_COMPACT_COOLDOWN_MS }) {
  return async function compactSelf(data) {
    const { roomId, focus, reason } = data || {};
    const session = getSession(roomId);
    if (!session || !session.alive) {
      return { status: 404, body: { error: 'No active session for this room' } };
    }
    if (focus != null && (typeof focus !== 'string' || focus.length > FOCUS_MAX_CHARS)) {
      return { status: 400, body: { error: `focus must be text of at most ${FOCUS_MAX_CHARS} characters` } };
    }
    if (reason != null && (typeof reason !== 'string' || reason.length > REASON_MAX_CHARS)) {
      return { status: 400, body: { error: `reason must be text of at most ${REASON_MAX_CHARS} characters` } };
    }
    // One per turn: a parked self-compact already has everything it needs,
    // and a second call would only replace it. A Coordinator-sent compact
    // parked here is simply superseded (same slot, latest wins) — this one
    // carries the session's own instructions.
    if (session._deferredControls?.compact?.params?.self) {
      return { status: 409, body: { error: 'A compact is already parked for this session and runs when this turn ends. Do not call compact_self again.' } };
    }
    const last = session._lastSelfCompactAt || 0;
    if (cooldownMs > 0 && last && now() - last < cooldownMs) {
      const mins = Math.ceil((cooldownMs - (now() - last)) / 60000);
      return { status: 429, body: { error: `This session compacted itself less than ${Math.round(cooldownMs / 60000)} minutes ago. Try again in ${mins} min, or ask the user.` } };
    }

    const params = {
      convoId: roomId,
      action: 'compact',
      self: true,
      command: compactCommandFor({ agent: session.agent, coordinator: session.coordinator === true, focus }),
      ...(oneLine(reason, REASON_MAX_CHARS) ? { reason: oneLine(reason, REASON_MAX_CHARS) } : {}),
    };
    const parked = !!isOccupied(session);
    try {
      if (parked) park(session, params);
      else await apply(session, params);
    } catch (e) {
      return { status: 500, body: { error: `Could not start the compact: ${e?.message || e}` } };
    }
    session._lastSelfCompactAt = now();
    try {
      notify(session, `🗜️ Compacting this session${parked ? ' once this turn finishes' : ' now'}${params.reason ? ` — ${params.reason}` : ''}.`);
    } catch { /* a notice that can't be posted must not fail the compact */ }
    return { status: 200, body: { ok: true, parked } };
  };
}
