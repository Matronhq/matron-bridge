// Shared command-classification for the bridge's !/ command surface. Both
// the Matrix room.message handler (index.js) and the journal session-text
// route (journalRouteTextToSession, also index.js — wired as
// lib/journal-input-router.js's routeTextToSession) run every inbound text
// through these SAME pure classifiers before deciding whether to intercept
// it as a bridge command, an iv-mode PTY rescue keystroke, or let it flow
// through as an ordinary message / TUI-native slash passthrough.
//
// Keeping this decision logic in one shared, dependency-free module is what
// makes it impossible for the two transports to silently fork: change a
// command's name or a passthrough rule here and BOTH transports pick it up
// identically. The actual command IMPLEMENTATIONS (handleCommand's switch,
// in index.js) and PTY calls (session.iv.sendKeystroke) stay put — they're
// deeply coupled to index.js's session/room state and reused AS-IS by both
// transports, not duplicated here. This module only ever answers "what IS
// this text?", never "what should happen because of it".

// The full set of !/ command names the bridge intercepts before they ever
// reach a Claude session. Mirrors handleCommand's switch cases exactly
// (index.js ~3466) MINUS the show_bash family ('!show_bash',
// '!show_bash_output', '!bash_output'): those cases exist in the switch but
// were never added to this gate, so they've never actually been reachable
// from typed chat text in Matrix either. Preserved exactly as-is — closing
// that gap would be a Matrix-visible behavior change, out of scope here.
export const BRIDGE_COMMAND_NAMES = new Set([
  'start', 'stop', 'restart', 'resume', 'workdir', 'status',
  'show', 'show_working', 'working', 'sessions', 'help',
  'mcp', 'model', 'mode', 'effort', 'cost', 'usage', 'limits', 'tools',
]);

// text -> the bang-normalized command string handleCommand expects (e.g.
// '!stop'), or null if `text` isn't one of the bridge's intercepted
// commands. Accepts either `!` or `/` prefix, case-insensitive on the
// command word — exactly what the Matrix room.message handler does.
export function classifyBridgeCommand(text) {
  if (typeof text !== 'string') return null;
  if (!(text.startsWith('!') || text.startsWith('/'))) return null;
  const firstWord = text.split(/\s+/)[0].toLowerCase();
  const cmdName = firstWord.slice(1);
  if (!BRIDGE_COMMAND_NAMES.has(cmdName)) return null;
  return '!' + text.slice(1);
}

// iv-mode PTY rescue keystrokes (index.js, the block right after the
// isClaudeSlashCommand check). Recognized regardless of busy state and
// independent of BRIDGE_COMMAND_NAMES — these bypass everything because
// they're pure recovery actions the user can always need. Returns
// 'enter' | 'esc' | null. Case/whitespace-insensitive, like the Matrix
// handler. Callers must additionally gate on session.iv && session.iv.alive
// (kept out of here so this stays a pure string predicate).
export function classifyRescueKeystroke(text) {
  if (typeof text !== 'string') return null;
  const lower = text.trim().toLowerCase();
  if (lower === '!enter') return 'enter';
  if (lower === '!esc' || lower === '!escape' || lower === '!stop') return 'esc';
  return null;
}

// Whether `text` should bypass busy-queueing and go straight into the PTY
// as a claude-native slash command (index.js's isClaudeSlashCommand). `//`
// escapes this — a message starting with a literal double slash is queued
// like ordinary text instead of typed straight into the TUI. Only
// meaningful for interactive (iv-mode) sessions; callers must AND this with
// their own session.iv check (kept out of here so this stays a pure string
// predicate, easy to unit test without a session fixture).
export function isIvSlashPassthrough(text) {
  return typeof text === 'string' && text.startsWith('/') && !text.startsWith('//');
}
