import path from 'path';

// Without a GEMINI_API_KEY the LLM rename in maybeUpdatePinnedSummary never
// runs, so convos kept their workdir-basename seed forever. Fall back to the
// same name Claude Code itself gives a session — the first user message, as
// shown by `claude --resume` and the bridge's own /sessions listing (see
// lib/session-summary.js's extraction, whose cleaning rules this mirrors).
// One-shot per session: the first user message never changes, so there is
// nothing to re-derive. Same title format as the LLM rename
// (`label:xx <text>`) so journals look uniform whichever path named them.
const FALLBACK_TITLE_MAX = 60;

export function applyFallbackTitle(session, { serverLabel, updateRoomName }) {
  if (session._fallbackTitleApplied) return false;
  const first = Array.isArray(session.chatHistory)
    ? session.chatHistory.find((m) => m?.role === 'user' && typeof m.text === 'string' && m.text.trim())
    : undefined;
  if (!first) return false; // no user turn yet — stay armed for the next flush
  const clean = first.text.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
  if (!clean) return false;
  const text = clean.length > FALLBACK_TITLE_MAX ? `${clean.slice(0, FALLBACK_TITLE_MAX)}…` : clean;
  const sessionShort = (session.claudeSessionId || session.roomId.slice(1)).slice(0, 2);
  session._fallbackTitleApplied = true;
  updateRoomName(session.roomId, `${serverLabel}:${sessionShort} ${text}`);
  return true;
}

// Seed a journal convo title from the session's workdir (basename), unless a
// live title hint already won. Fails open — a title is cosmetic.
export async function seedJournalTitle(session, { workdir, upsertConvo, warn = () => {} }) {
  try {
    if (session._journalTitleHint !== undefined) return false;
    const base = workdir ? path.basename(path.resolve(workdir)) : '';
    const title = base || 'session';
    upsertConvo(session, { title });
    return true;
  } catch (e) {
    warn(`seedJournalTitle failed: ${e?.message || e}`);
    return false;
  }
}
