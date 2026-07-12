import { describe, it, expect, vi } from 'vitest';
import { seedJournalTitleFromRoom } from '../lib/journal-title-seed.js';

// Journal convos created for sessions that were named BEFORE the journal
// connected (any bridge restart resumes such sessions) were upserted with
// title: undefined — the journal UI then falls back to the convo id, i.e. a
// bare session UUID, until the next 5-message Gemini rename happens to fire.
// This seam reads the room's existing m.room.name back into the journal at
// session creation. Guards pinned here: never clobber a title learned while
// the fetch was in flight, and fail open on every fetch problem.

function makeSession(hint) {
  const s = { roomId: '!room:hs' };
  if (hint !== undefined) s._journalTitleHint = hint;
  return s;
}

describe('seedJournalTitleFromRoom', () => {
  it('upserts the fetched room name when no title hint is set', async () => {
    const session = makeSession();
    const upsertConvo = vi.fn();
    const seeded = await seedJournalTitleFromRoom(session, {
      getRoomName: async () => '6:b2 Journal streaming bridge setup',
      upsertConvo,
    });
    expect(seeded).toBe(true);
    expect(upsertConvo).toHaveBeenCalledExactlyOnceWith(session, {
      title: '6:b2 Journal streaming bridge setup',
    });
  });

  it('does nothing when a title hint already exists (no fetch, no upsert)', async () => {
    const session = makeSession('already named');
    const getRoomName = vi.fn();
    const upsertConvo = vi.fn();
    const seeded = await seedJournalTitleFromRoom(session, { getRoomName, upsertConvo });
    expect(seeded).toBe(false);
    expect(getRoomName).not.toHaveBeenCalled();
    expect(upsertConvo).not.toHaveBeenCalled();
  });

  it('does not clobber a title set while the fetch was in flight', async () => {
    const session = makeSession();
    const upsertConvo = vi.fn();
    const seeded = await seedJournalTitleFromRoom(session, {
      getRoomName: async () => {
        session._journalTitleHint = 'renamed mid-flight';
        return 'stale fetched name';
      },
      upsertConvo,
    });
    expect(seeded).toBe(false);
    expect(upsertConvo).not.toHaveBeenCalled();
  });

  it('fails open when the fetch rejects (unnamed room → 404)', async () => {
    const session = makeSession();
    const upsertConvo = vi.fn();
    const warn = vi.fn();
    const seeded = await seedJournalTitleFromRoom(session, {
      getRoomName: async () => { throw new Error('M_NOT_FOUND'); },
      upsertConvo,
      warn,
    });
    expect(seeded).toBe(false);
    expect(upsertConvo).not.toHaveBeenCalled();
  });

  it.each([undefined, null, '', 42])('skips a fetched name of %o', async (name) => {
    const session = makeSession();
    const upsertConvo = vi.fn();
    const seeded = await seedJournalTitleFromRoom(session, {
      getRoomName: async () => name,
      upsertConvo,
    });
    expect(seeded).toBe(false);
    expect(upsertConvo).not.toHaveBeenCalled();
  });

  it('is safe on a null session', async () => {
    const upsertConvo = vi.fn();
    const seeded = await seedJournalTitleFromRoom(null, {
      getRoomName: async () => 'name',
      upsertConvo,
    });
    expect(seeded).toBe(false);
    expect(upsertConvo).not.toHaveBeenCalled();
  });
});
