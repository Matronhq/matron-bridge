import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { writeSavedMediaFile, makeIdentityAwareCleanup } from '../lib/saved-media-file.js';

describe('saved attachments', () => {
  let dir;
  let target;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'saved-media-'));
    target = path.join(dir, 'report.pdf');
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('installs complete bytes and cleans the same file once', () => {
    const saved = writeSavedMediaFile(target, Buffer.from('complete'));
    expect(fs.readFileSync(saved.path, 'utf8')).toBe('complete');
    expect(fs.readdirSync(dir)).toEqual(['report.pdf']);
    const cleanup = makeIdentityAwareCleanup(saved.path, saved.identity);
    cleanup();
    fs.writeFileSync(target, 'later upload');
    cleanup();
    expect(fs.readFileSync(target, 'utf8')).toBe('later upload');
  });

  it('reselects after an install collision without replacing the existing upload', () => {
    const next = path.join(dir, 'report-2.pdf');
    const fsImpl = { ...fs, linkSync: (source, dest) => {
      if (dest === target) fs.writeFileSync(target, 'existing');
      fs.linkSync(source, dest);
    } };
    const saved = writeSavedMediaFile(target, Buffer.from('new'), { fsImpl, reselectPath: () => next });
    expect(saved.path).toBe(next);
    expect(fs.readFileSync(target, 'utf8')).toBe('existing');
    expect(fs.readFileSync(next, 'utf8')).toBe('new');
    expect(fs.readdirSync(dir).sort()).toEqual(['report-2.pdf', 'report.pdf']);
  });

  it.each(['writeFileSync', 'fsyncSync', 'linkSync'])('removes temporary files when %s fails', (operation) => {
    const fsImpl = { ...fs, [operation]: () => { throw new Error('disk failure'); } };
    expect(() => writeSavedMediaFile(target, Buffer.from('new'), { fsImpl })).toThrow('disk failure');
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it('cleans the temporary file when name selection throws', () => {
    fs.writeFileSync(target, 'existing');
    expect(() => writeSavedMediaFile(target, Buffer.from('new'), {
      reselectPath: () => { throw new Error('selection failed'); },
    })).toThrow('selection failed');
    expect(fs.readdirSync(dir)).toEqual(['report.pdf']);
  });

  it('bounds collision retries', () => {
    fs.writeFileSync(target, 'existing');
    expect(() => writeSavedMediaFile(target, Buffer.from('new'), {
      reselectPath: () => target, maxAttempts: 2,
    })).toThrow();
    expect(fs.readFileSync(target, 'utf8')).toBe('existing');
    expect(fs.readdirSync(dir)).toEqual(['report.pdf']);
  });

  it('leaves a replacement file and unknown identities alone', () => {
    const saved = writeSavedMediaFile(target, Buffer.from('first'));
    fs.renameSync(target, path.join(dir, 'original.pdf'));
    fs.writeFileSync(target, 'replacement');
    makeIdentityAwareCleanup(target, saved.identity)();
    makeIdentityAwareCleanup(target, null)();
    expect(fs.readFileSync(target, 'utf8')).toBe('replacement');
  });
});
