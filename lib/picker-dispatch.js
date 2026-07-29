// Picker-button dispatch for the journal prompt_reply return path.
//
// The no-arg /model, /effort and /mode commands publish button messages whose
// option VALUES are namespaced `model:<alias>`, `effort:<level>` and
// `mode:<target>` (lib/model-command.js modelButtons, lib/effort-command.js
// effortButtons, lib/session-mode.js modeButtons); the /timer set-confirmation
// card's Cancel button carries `timer:cancel:<id>` (lib/timer-command.js
// timerCancelButton) and rides the same path. A Matron tap arrives back at
// the bridge as a journal prompt_reply whose `choice` carries that value — the
// same wire shape a Matrix button_response once carried. Upstream (issue #98)
// only ever wired these three through the deleted Matrix button path, so the
// journal prompt_reply path never dispatched them: a tap fell through to
// pending-prompt routing, matched nothing, and no-op'd ("Nothing to answer
// right now"). This module is the missing dispatch, extracted pure (injected
// switch fns, no I/O) so it's unit-testable without a live session — the same
// shape as lib/busy-queue.js resolveQueueReleaseTap.
//
// Picker-vs-answer classification is the ROUTER's job: it verifies a reply's
// target_seq against the picker frame the bridge published and that frame's
// offered values, and only then flags the reply as a picker command. This
// module is reached only after that confirmation. handlePickerValue still
// validates the value against the exact closed set of values the pickers emit
// (below) as defense-in-depth, and rejects malformed/future values (e.g.
// `mode:bogus`) rather than acting on them.

import { SWITCHABLE_ALIASES } from './model-aliases.js';
import { EFFORT_LEVELS } from './effort-command.js';

const MODEL_ALIASES = new Set(SWITCHABLE_ALIASES.map(m => m.alias));
const EFFORT_LEVEL_SET = new Set(EFFORT_LEVELS.map(e => e.level));
const MODE_TARGETS = new Set(['interactive', 'print']);

const ALLOWED = {
  model: MODEL_ALIASES,
  effort: EFFORT_LEVEL_SET,
  mode: MODE_TARGETS,
};

const PICKER_VALUE = /^(model|effort|mode|timer):(.+)$/;
// Timer values carry a dynamic record id (lib/timer-command.js
// timerCancelButton emits `timer:cancel:<id>`), so unlike the closed alias
// sets above they validate by shape: the only verb is `cancel` and the id
// must be all digits.
const TIMER_CANCEL_ARG = /^cancel:(\d+)$/;

// Parse a `<kind>:<arg>` value into { kind, arg } iff kind is a picker kind AND
// arg is one of the values that kind's picker actually emits; else null. For
// `timer`, arg is the parsed numeric record id (the verb is implied — cancel
// is the only one).
function parsePickerValue(value) {
  const m = typeof value === 'string' ? value.match(PICKER_VALUE) : null;
  if (!m) return null;
  const kind = m[1];
  const arg = m[2];
  if (kind === 'timer') {
    const t = arg.match(TIMER_CANCEL_ARG);
    return t ? { kind, arg: parseInt(t[1], 10) } : null;
  }
  return ALLOWED[kind].has(arg) ? { kind, arg } : null;
}

// Dispatch a picker tap to the matching switch implementation. Returns true if
// `value` was a valid picker value and has been handled, false otherwise
// (nothing touched). The caller has already classified the reply as a picker
// tap by frame provenance and returns unconditionally either way, so a false
// return is a silent no-op — unreachable for values a picker frame offered. Mirrors
// the explicit-arg !model/!effort/!mode command handlers in index.js: model and
// mode take (roomId, session, arg, { sendReply, sendHtml }); effort takes
// (session, level, sendReply). A validated `mode:<target>` is `interactive` or
// `print`, so `arg === 'interactive'` is the wantInteractive boolean.
export function handlePickerValue(value, roomId, session, {
  applyModelSwitch,
  switchEffortInSession,
  applyModeSwitch,
  cancelTimer,
  sendReply,
  sendHtml,
} = {}) {
  const parsed = parsePickerValue(value);
  if (!parsed) return false;
  const { kind, arg } = parsed;
  if (kind === 'model') {
    applyModelSwitch(roomId, session, arg, { sendReply, sendHtml });
    return true;
  }
  if (kind === 'effort') {
    switchEffortInSession(session, arg, sendReply);
    return true;
  }
  if (kind === 'timer') {
    cancelTimer(session, arg, sendReply);
    return true;
  }
  // kind === 'mode'
  applyModeSwitch(roomId, session, arg === 'interactive', { sendReply, sendHtml });
  return true;
}
