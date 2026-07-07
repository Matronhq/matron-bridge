// Pure per-room mode/model helpers. No side effects, no I/O — the caller in
// index.js performs the actual session restart. Kept in lib/ so the precedence
// and decision logic is unit-testable without spawning a claude process.

// Precedence: explicit call option -> persisted per-room value -> global default.
export function resolveInteractive({ option, persisted, fallback }) {
  if (typeof option === 'boolean') return option;
  if (typeof persisted === 'boolean') return persisted;
  return !!fallback;
}

// Precedence: explicit option -> persisted -> undefined (CLI default).
export function resolveModel({ option, persisted }) {
  return option ?? persisted ?? undefined;
}

const INTERACTIVE_WORDS = new Set(['interactive', 'iv', 'tui', 'on']);
const PRINT_WORDS = new Set(['print', 'noniv', 'non-interactive', 'p', 'off']);

// Parse a /mode argument to a canonical target, or null if unrecognized.
export function normalizeModeArg(arg) {
  const a = String(arg ?? '').trim().toLowerCase();
  if (INTERACTIVE_WORDS.has(a)) return 'interactive';
  if (PRINT_WORDS.has(a)) return 'print';
  return null;
}

export function modeLabel(interactive) {
  return interactive ? 'interactive' : 'non-interactive';
}

// A single button that flips to the opposite of the current mode. Value is
// namespaced `mode:<target>` so the button-response handler can dispatch it.
export function modeButtons(currentInteractive) {
  const target = currentInteractive ? 'print' : 'interactive';
  const label = currentInteractive ? 'Switch to non-interactive' : 'Switch to interactive';
  return [{ id: `mode-${target}`, label, value: `mode:${target}` }];
}

// Decide whether a /mode switch can proceed. `session.iv` truthy means the room
// is currently interactive. Returns a decision the caller acts on.
export function planModeSwitch(session, wantInteractive) {
  const currentInteractive = !!session.iv;
  if (currentInteractive === wantInteractive) {
    return { ok: false, noop: true, message: `Already in ${modeLabel(wantInteractive)} mode.` };
  }
  if (session.busy) {
    return { ok: false, message: 'Finish or interrupt the current turn before switching modes.' };
  }
  if (currentInteractive && !wantInteractive && session.pendingInteractivePrompt) {
    return { ok: false, message: 'Answer the pending question before switching to non-interactive mode.' };
  }
  return {
    ok: true,
    message: `Switching to ${modeLabel(wantInteractive)} mode — restarting (history preserved)…`,
  };
}
