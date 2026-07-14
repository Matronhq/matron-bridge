import path from 'path';

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
