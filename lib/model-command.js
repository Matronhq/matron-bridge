// /model command behaviors that operate on an injected session object and a
// `send(message)` callback, so they are unit-testable without the Matrix
// client. switchModelInSession drives the in-TUI /model command; modelButtons
// builds the no-arg picker buttons.

import {
  SWITCHABLE_ALIASES,
  VALID_ALIAS_HINT,
  isValidModelArg,
  normalizeModelArg,
  aliasLabel,
} from './model-aliases.js';

// Validate, then write `/model <alias>` into the live PTY. Returns true when a
// switch was driven. `send` is called with a human-readable status string.
export function switchModelInSession(session, arg, send) {
  if (!isValidModelArg(arg)) {
    send(`Unknown model "${arg}". Try: ${VALID_ALIAS_HINT} (or a full claude-* name).`);
    return false;
  }
  if (!session.iv || typeof session.iv.sendText !== 'function') {
    send(`Switching models needs interactive mode. Current model: ${session.currentModel || '(unknown)'}`);
    return false;
  }
  const normalized = normalizeModelArg(arg);
  session.iv.sendText(`/model ${normalized}`);
  send(`Switching to ${aliasLabel(arg)}… (takes effect on your next message)`);
  return true;
}

// One Matrix button per switchable alias. value is namespaced `model:<alias>`
// so the button-response handler can dispatch it explicitly.
export function modelButtons() {
  return SWITCHABLE_ALIASES.map(m => ({
    id: `model-${m.alias}`,
    label: m.label,
    value: `model:${m.alias}`,
  }));
}
