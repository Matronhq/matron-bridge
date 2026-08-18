import { describe, it, expect, vi } from 'vitest';
import { shouldAnnounceOnline, recordOnlineAnnounced } from '../lib/announce-once.js';

// In-memory fs fake (same shape as test/atomic-write.test.js) — covers the
// readFileSync used by shouldAnnounceOnline and the write/rename/unlink trio
// atomicWriteFileSync needs under recordOnlineAnnounced.
function fakeFs(initial = {}) {
  const files = { ...initial };
  return {
    files,
    readFileSync: (p) => {
      if (!(p in files)) { const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e; }
      return files[p];
    },
    writeFileSync: vi.fn((p, data) => { files[p] = data; }),
    renameSync: vi.fn((from, to) => {
      if (!(from in files)) { const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e; }
      files[to] = files[from];
      delete files[from];
    }),
    unlinkSync: vi.fn((p) => { delete files[p]; }),
  };
}

const MARKER = '/home/dan/.claude-matrix-announced.json';
const CONVO = 'bridge-henry';

describe('announce-once', () => {
  it('announces on first boot (no marker file)', () => {
    const fs = fakeFs();
    expect(shouldAnnounceOnline(MARKER, CONVO, { fs })).toBe(true);
  });

  it('stays silent on later boots once the marker records this convo', () => {
    const fs = fakeFs();
    recordOnlineAnnounced(MARKER, CONVO, { fs });
    expect(shouldAnnounceOnline(MARKER, CONVO, { fs })).toBe(false);
  });

  it('re-announces when the control convo id changes (new convo never saw the intro)', () => {
    const fs = fakeFs();
    recordOnlineAnnounced(MARKER, CONVO, { fs });
    expect(shouldAnnounceOnline(MARKER, 'bridge-renamed', { fs })).toBe(true);
  });

  it('treats a corrupt marker as first boot (one repeat beats never announcing)', () => {
    const fs = fakeFs({ [MARKER]: '{not json' });
    expect(shouldAnnounceOnline(MARKER, CONVO, { fs })).toBe(true);
  });

  it('records the marker atomically (temp sibling + rename, target never opened directly)', () => {
    const fs = fakeFs();
    recordOnlineAnnounced(MARKER, CONVO, { fs });
    const writtenPaths = fs.writeFileSync.mock.calls.map(c => c[0]);
    expect(writtenPaths).toEqual([`${MARKER}.${process.pid}.tmp`]);
    expect(fs.renameSync).toHaveBeenCalledWith(`${MARKER}.${process.pid}.tmp`, MARKER);
    const marker = JSON.parse(fs.files[MARKER]);
    expect(marker.convoId).toBe(CONVO);
    expect(typeof marker.announcedAt).toBe('string');
  });
});
