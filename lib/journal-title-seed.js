// Seed the journal convo title from the room's existing Matrix name.
//
// A journal convo's title only ever reaches the server as a side effect of a
// rename (updateRoomName → journalUpsertConvo). Sessions that were named
// before the journal connected — every session a bridge restart resumes —
// re-establish their convo with title: undefined, and the journal UI falls
// back to showing the convo id (the bare session UUID) until the next
// 5-message Gemini rename fires. Called at session creation, this reads the
// room's current m.room.name back and upserts it as the title.
//
// Fails open everywhere: an unnamed room (fetch rejects with M_NOT_FOUND) or
// any other fetch problem simply leaves the convo title unset. A title hint
// learned while the fetch was in flight (initial Gemini naming, a rename)
// always wins — the fetched name is stale by definition at that point.
export async function seedJournalTitleFromRoom(session, { getRoomName, upsertConvo, warn = () => {} }) {
  try {
    if (!session || session._journalTitleHint !== undefined) return false;
    const name = await getRoomName();
    if (typeof name !== 'string' || name.length === 0) return false;
    if (session._journalTitleHint !== undefined) return false;
    upsertConvo(session, { title: name });
    return true;
  } catch (e) {
    try { warn(`[journal] title seed failed for ${session?.roomId}: ${e.message}`); } catch { /* logging must never throw */ }
    return false;
  }
}
