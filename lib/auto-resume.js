// Automatic carry-on (spec 2026-09-29 coordinator session control §4,
// decision D): a Claude session that stalled on a usage limit carries
// itself on when the meter resets, and one whose model turned out to be
// unavailable is moved to the default model once and carried on. Pure
// helpers; index.js owns the timers, the persisted `_autoResume` slot and
// the delivery (resume if needed, /compact when the gauge is high, then
// the text as a turn).
export const AUTO_RESUME_TEXT = '[auto-continue after usage limit reset] The usage limit that stopped you has reset. Carry on with what you were doing.';
export const BAD_MODEL_RECOVERY_TEXT = '[auto-continue after model recovery] The model this session was on is no longer available here, so the bridge switched it to the default model. Carry on with what you were doing.';
export const COMPACT_BEFORE_RESUME_PCT = 80;
// Late is fine, early is not: the meter's reset can lag its own timestamp.
export const RESUME_GRACE_MS = 30_000;

// What to arm from a fresh stall, or null when nothing can be scheduled.
// `existing` is the slot already on the session (a Coordinator's
// after_limit_reset message wins over the default text; a slot armed for
// the same stall is left alone).
// A reset time already in the past arms nothing: the meters have not
// refreshed yet (the bridge forces a refresh at the stall and re-arms when
// the real reset lands), and arming it would fire at once, stall again and
// loop.
export function armFromStall(stall, existing = null, now = Date.now()) {
  if (!stall || stall.kind !== 'usage_limit' || typeof stall.resets_at !== 'string') return existing || null;
  const at = Date.parse(stall.resets_at);
  if (!Number.isFinite(at) || at <= now) return existing || null;
  if (existing && existing.kind === 'usage_limit' && existing.at === stall.resets_at) return existing;
  const text = existing?.source === 'coordinator' && existing.text ? existing.text : AUTO_RESUME_TEXT;
  return { at: stall.resets_at, kind: 'usage_limit', text, ...(existing?.source ? { source: existing.source } : {}) };
}

// Due when the reset time plus the grace window has passed.
export function autoResumeDue(slot, now = Date.now()) {
  if (!slot || typeof slot.at !== 'string') return false;
  const at = Date.parse(slot.at);
  return Number.isFinite(at) && now >= at + RESUME_GRACE_MS;
}

// Whether to queue a /compact ahead of the carry-on: the last gauge at or
// above COMPACT_BEFORE_RESUME_PCT of the window.
export function shouldCompactBefore(contextTokens, contextWindow) {
  if (!Number.isFinite(contextTokens) || !Number.isFinite(contextWindow) || contextWindow <= 0) return false;
  return (contextTokens / contextWindow) * 100 >= COMPACT_BEFORE_RESUME_PCT;
}

// Persisted-session records (values of ~/.claude-matrix-sessions.json) whose
// slot is due and that have no live session — the sweep resumes those.
export function dueResumes(records, now = Date.now()) {
  const out = [];
  for (const [roomId, rec] of Object.entries(records || {})) {
    if (!rec || !rec._autoResume) continue;
    if (autoResumeDue(rec._autoResume, now)) out.push({ roomId, convoId: rec.journalConvoId || rec.sessionId || null, slot: rec._autoResume });
  }
  return out;
}
