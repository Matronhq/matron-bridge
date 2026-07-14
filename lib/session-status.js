// Pure helpers for the per-convo session-status frame ("header data"):
// model, context-window gauge, and account rate limits, published to the
// journal at turn end so Matron clients can render them without anyone
// having to run /context or /limits by hand.
//
// The context gauge is computed passively from the `usage` block claude
// already emits on every result event — input + cache read + cache creation
// is the context footprint of the last request. Deliberately NOT sourced by
// sending /context into the session: a polled local command would append
// its own report to the transcript (eating the context it measures), bump
// lastActivityAt (defeating the idle reaper), and race real turns. The
// numbers here are an estimate — close enough for a header gauge, not
// /context's exact accounting.

// Model → context window. 1m-class models are matched by family name (or an
// explicit [1m] marker); everything else gets the standard 200k. A wrong
// guess only skews the header percentage, so a conservative default beats an
// exhaustive table that goes stale with every model launch.
const WINDOW_1M_RE = /fable|mythos|\[1m\]/i;

export function contextWindowFor(model) {
  return WINDOW_1M_RE.test(String(model ?? '')) ? 1_000_000 : 200_000;
}

// Context footprint of the last request: everything that was sent up,
// however it was billed. Output tokens are excluded — they aren't part of
// the next request's context accounting here (the next turn's usage will
// include them as input). Returns null when there's nothing usable so the
// caller can distinguish "no turn yet" from a genuine zero.
export function contextTokensFromUsage(usage) {
  if (!usage || typeof usage !== 'object') return null;
  const tokens = (usage.input_tokens || 0)
    + (usage.cache_read_input_tokens || 0)
    + (usage.cache_creation_input_tokens || 0);
  return tokens > 0 ? tokens : null;
}

// Extract the logged-in account's email from a parsed ~/.claude.json.
// Returns null when logged out / malformed — the frame simply omits it.
// Pure (takes the parsed object); the file read + TTL cache live in
// index.js (getAccountEmail).
export function emailFromClaudeConfig(config) {
  const email = config?.oauthAccount?.emailAddress;
  return typeof email === 'string' && email ? email : null;
}

// Assemble the status frame payload. Every part is optional — a fresh
// session may know only its model, a resumed one may have limits before its
// first turn — and absent parts are omitted (not nulled) so clients can
// keep whatever they last rendered.
export function buildSessionStatus({ model, contextTokens, limits, email } = {}) {
  const status = {};
  if (model) status.model = model;
  if (typeof email === 'string' && email) status.email = email;
  if (typeof contextTokens === 'number' && contextTokens > 0) {
    const window = contextWindowFor(model);
    status.context = {
      tokens: contextTokens,
      window,
      pct: Math.min(100, Math.round((contextTokens / window) * 100)),
    };
  }
  if (Array.isArray(limits) && limits.length > 0) status.limits = limits;
  return status;
}
