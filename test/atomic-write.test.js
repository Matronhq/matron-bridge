import { describe, it, expect, vi } from 'vitest';
import { atomicWriteFileSync } from '../lib/atomic-write.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// In-memory fs fake (same shape as test/recent-folders.test.js) modelling
// POSIX atomic-rename semantics: writeFileSync lands the temp file, renameSync
// atomically replaces the target with it (and removes the temp).
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

const FILE = '/home/dan/.durable-store.json';

describe('atomicWriteFileSync', () => {
  it('writes a pid-tagged temp sibling, then renames it onto the target (never opens the target directly)', () => {
    const fs = fakeFs({ [FILE]: 'old' });
    atomicWriteFileSync(FILE, 'new', { fs });
    // The write went to a temp path, not the durable file.
    const writtenPaths = fs.writeFileSync.mock.calls.map(c => c[0]);
    expect(writtenPaths).toEqual([`${FILE}.${process.pid}.tmp`]);
    // Then a rename landed the complete file onto the target, temp gone.
    expect(fs.renameSync).toHaveBeenCalledWith(`${FILE}.${process.pid}.tmp`, FILE);
    expect(Object.keys(fs.files)).toEqual([FILE]);
    expect(fs.files[FILE]).toBe('new');
  });

  it('a write that fails mid-save (ENOSPC) retains the prior durable file and rethrows', () => {
    const prior = JSON.stringify({ keep: true });
    const fs = fakeFs({ [FILE]: prior });
    fs.writeFileSync.mockImplementation(() => { const e = new Error('ENOSPC'); e.code = 'ENOSPC'; throw e; });
    expect(() => atomicWriteFileSync(FILE, 'partial', { fs })).toThrow(/ENOSPC/);
    // The durable file is UNCHANGED — it was never opened, never truncated.
    expect(fs.files[FILE]).toBe(prior);
    expect(fs.renameSync).not.toHaveBeenCalled();
  });

  it('a rename failure retains the prior durable file and cleans up the temp', () => {
    const prior = 'prior-contents';
    const fs = fakeFs({ [FILE]: prior });
    fs.renameSync.mockImplementation(() => { const e = new Error('EPERM'); e.code = 'EPERM'; throw e; });
    expect(() => atomicWriteFileSync(FILE, 'new', { fs })).toThrow(/EPERM/);
    expect(fs.files[FILE]).toBe(prior);
    // Best-effort cleanup removed the orphaned temp.
    expect(fs.unlinkSync).toHaveBeenCalledWith(`${FILE}.${process.pid}.tmp`);
    expect(Object.keys(fs.files)).toEqual([FILE]);
  });

  it('tolerates an fs without unlinkSync during failure cleanup (original error still surfaces)', () => {
    const fs = fakeFs({ [FILE]: 'prior' });
    fs.writeFileSync.mockImplementation(() => { throw new Error('EROFS'); });
    delete fs.unlinkSync;
    expect(() => atomicWriteFileSync(FILE, 'new', { fs })).toThrow(/EROFS/);
    expect(fs.files[FILE]).toBe('prior');
  });
});

describe('atomicWriteFileSync mode', () => {
  it('creates the temp and the target with the requested permissions', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-mode-'));
    const target = path.join(dir, 'store.json');
    const modes = [];
    const spyFs = {
      writeFileSync: (f, d, o) => { modes.push({ file: f, mode: o?.mode }); fs.writeFileSync(f, d, o); },
      renameSync: fs.renameSync,
      unlinkSync: fs.unlinkSync,
      chmodSync: fs.chmodSync,
    };
    atomicWriteFileSync(target, '{"a":1}', { fs: spyFs, mode: 0o600 });
    // The mode must ride on the TEMP write: the rename carries it onto the
    // target, so setting it afterwards would leave a window where the file
    // is world-readable.
    expect(modes[0].mode).toBe(0o600);
    expect(modes[0].file.startsWith(target)).toBe(true);
    expect(fs.statSync(target).mode & 0o777).toBe(0o600);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('is unchanged when no mode is given', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-nomode-'));
    const target = path.join(dir, 'store.json');
    atomicWriteFileSync(target, 'hello');
    expect(fs.readFileSync(target, 'utf8')).toBe('hello');
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
