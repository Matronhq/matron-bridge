import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, symlinkSync, mkdirSync, rmSync, readFileSync, readdirSync, statSync, openSync, fchmodSync, closeSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { applyFileEdit, MAX_EDIT_BYTES, writeFileReplacing } from '../lib/edit-file.js';
import { pinAllowedRootsSync } from '../lib/file-link-guard.js';

// Create a file with an exact mode through one descriptor (no umask, and no
// window between writing and chmod-ing a pathname).
function writeWithMode(file, data, mode) {
  const fd = openSync(file, 'w', 0o600);
  try {
    fchmodSync(fd, mode);
    writeFileSync(fd, data);
  } finally {
    closeSync(fd);
  }
}

// Real temp dirs (like file-link-guard.test.js) so the fd-pinned / O_NOFOLLOW /
// realpath containment is exercised for real, not mocked.
let root;
let outside;
let roots; // pinned root set scoped to `root`

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'edit-root-'));
  outside = mkdtempSync(path.join(tmpdir(), 'edit-out-'));
  roots = pinAllowedRootsSync([root]);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

describe('applyFileEdit — happy paths', () => {
  it('full-content mode replaces the whole file atomically and reports the real path', async () => {
    const file = path.join(root, 'config.txt');
    writeFileSync(file, 'OLD=1\n');
    const res = await applyFileEdit({ path: file, content: 'NEW=2\nX=3\n' }, { allowedRoots: roots });
    expect(readFileSync(file, 'utf8')).toBe('NEW=2\nX=3\n');
    expect(res.mode).toBe('content');
    expect(res.path).toBe(file);
    expect(res.bytes).toBe(Buffer.byteLength('NEW=2\nX=3\n'));
    // Atomic write leaves no *.tmp litter behind.
    expect(readdirSync(root).some((f) => f.includes('.tmp'))).toBe(false);
  });

  it('targeted mode replaces exactly one occurrence of old_string', async () => {
    const file = path.join(root, 'settings.conf'); // non-sensitive name
    writeFileSync(file, 'PORT=3000\nDEBUG=false\n');
    const res = await applyFileEdit(
      { path: file, old_string: 'DEBUG=false', new_string: 'DEBUG=true' },
      { allowedRoots: roots },
    );
    expect(readFileSync(file, 'utf8')).toBe('PORT=3000\nDEBUG=true\n');
    expect(res.mode).toBe('replace');
  });

  it('targeted replacement is LITERAL — $ sequences in new_string are not special', async () => {
    const file = path.join(root, 'app.conf');
    writeFileSync(file, 'token=PLACEHOLDER\n');
    await applyFileEdit(
      { path: file, old_string: 'PLACEHOLDER', new_string: '$&$1${x}literal' },
      { allowedRoots: roots },
    );
    expect(readFileSync(file, 'utf8')).toBe('token=$&$1${x}literal\n');
  });

  it('can edit an empty file via content mode', async () => {
    const file = path.join(root, 'empty.txt');
    writeFileSync(file, '');
    await applyFileEdit({ path: file, content: 'now has content' }, { allowedRoots: roots });
    expect(readFileSync(file, 'utf8')).toBe('now has content');
  });
});

describe('applyFileEdit — path-safety rejections', () => {
  it('rejects a path that traverses outside the root (../ escape)', async () => {
    const outsideFile = path.join(outside, 'target.txt');
    writeFileSync(outsideFile, 'secret-ish');
    // A traversal expressed relative to the root that climbs out.
    const traversal = path.join(root, '..', path.basename(outside), 'target.txt');
    await expect(applyFileEdit({ path: traversal, content: 'x' }, { allowedRoots: roots }))
      .rejects.toMatchObject({ name: 'EditFileError', code: 'outside-scope' });
    expect(readFileSync(outsideFile, 'utf8')).toBe('secret-ish'); // untouched
  });

  it('rejects a plain absolute path outside the allowed root', async () => {
    const outsideFile = path.join(outside, 'elsewhere.txt');
    writeFileSync(outsideFile, 'do not touch');
    await expect(applyFileEdit({ path: outsideFile, content: 'x' }, { allowedRoots: roots }))
      .rejects.toMatchObject({ code: 'outside-scope' });
    expect(readFileSync(outsideFile, 'utf8')).toBe('do not touch');
  });

  it('rejects a symlink whose target escapes the root (O_NOFOLLOW)', async () => {
    const outsideFile = path.join(outside, 'real.txt');
    writeFileSync(outsideFile, 'escape target');
    const link = path.join(root, 'link.txt');
    symlinkSync(outsideFile, link);
    await expect(applyFileEdit({ path: link, content: 'x' }, { allowedRoots: roots }))
      .rejects.toMatchObject({ name: 'EditFileError' });
    // The symlink is caught (ELOOP -> 'symlink') and the escape target is untouched.
    expect(readFileSync(outsideFile, 'utf8')).toBe('escape target');
  });

  it('rejects a relative path outright', async () => {
    await expect(applyFileEdit({ path: 'relative/config.txt', content: 'x' }, { allowedRoots: roots }))
      .rejects.toMatchObject({ code: 'relative-path' });
  });

  it('rejects a sensitive file even inside the root (.env)', async () => {
    const envFile = path.join(root, '.env');
    writeFileSync(envFile, 'API_KEY=abc\n');
    await expect(applyFileEdit({ path: envFile, content: 'API_KEY=hijacked\n' }, { allowedRoots: roots }))
      .rejects.toMatchObject({ code: 'sensitive' });
    expect(readFileSync(envFile, 'utf8')).toBe('API_KEY=abc\n');
  });

  it('rejects a directory target (not-a-file)', async () => {
    const dir = path.join(root, 'subdir');
    mkdirSync(dir);
    await expect(applyFileEdit({ path: dir, content: 'x' }, { allowedRoots: roots }))
      .rejects.toMatchObject({ code: 'not-a-file' });
  });

  it('rejects editing a non-existent file (existing files only)', async () => {
    await expect(applyFileEdit({ path: path.join(root, 'ghost.txt'), content: 'x' }, { allowedRoots: roots }))
      .rejects.toMatchObject({ name: 'EditFileError', code: 'unreadable' });
  });
});

describe('applyFileEdit — fail closed on scope', () => {
  it('rejects when no allowed roots are pinned (empty set)', async () => {
    const file = path.join(root, 'f.txt');
    writeFileSync(file, 'hi');
    const empty = pinAllowedRootsSync([]);
    await expect(applyFileEdit({ path: file, content: 'x' }, { allowedRoots: empty }))
      .rejects.toMatchObject({ code: 'bad_workdir' });
    expect(readFileSync(file, 'utf8')).toBe('hi');
  });

  it('rejects when allowedRoots is absent', async () => {
    const file = path.join(root, 'f.txt');
    writeFileSync(file, 'hi');
    await expect(applyFileEdit({ path: file, content: 'x' }, {}))
      .rejects.toMatchObject({ code: 'bad_workdir' });
  });
});

describe('applyFileEdit — malformed input fails loud', () => {
  it('rejects a missing/empty path', async () => {
    await expect(applyFileEdit({ content: 'x' }, { allowedRoots: roots }))
      .rejects.toMatchObject({ code: 'bad_request' });
    await expect(applyFileEdit({ path: '', content: 'x' }, { allowedRoots: roots }))
      .rejects.toMatchObject({ code: 'bad_request' });
  });

  it('rejects supplying BOTH content and old_string', async () => {
    const file = path.join(root, 'f.txt');
    writeFileSync(file, 'a');
    await expect(applyFileEdit({ path: file, content: 'x', old_string: 'a', new_string: 'b' }, { allowedRoots: roots }))
      .rejects.toMatchObject({ code: 'bad_request' });
  });

  it('rejects supplying NEITHER content nor old_string', async () => {
    const file = path.join(root, 'f.txt');
    writeFileSync(file, 'a');
    await expect(applyFileEdit({ path: file }, { allowedRoots: roots }))
      .rejects.toMatchObject({ code: 'bad_request' });
  });

  it('rejects non-string content', async () => {
    const file = path.join(root, 'f.txt');
    writeFileSync(file, 'a');
    await expect(applyFileEdit({ path: file, content: 123 }, { allowedRoots: roots }))
      .rejects.toMatchObject({ code: 'bad_request' });
  });

  it('rejects an empty old_string', async () => {
    const file = path.join(root, 'f.txt');
    writeFileSync(file, 'a');
    await expect(applyFileEdit({ path: file, old_string: '', new_string: 'b' }, { allowedRoots: roots }))
      .rejects.toMatchObject({ code: 'bad_request' });
  });

  it('rejects old_string with a non-string new_string', async () => {
    const file = path.join(root, 'f.txt');
    writeFileSync(file, 'a');
    await expect(applyFileEdit({ path: file, old_string: 'a', new_string: 5 }, { allowedRoots: roots }))
      .rejects.toMatchObject({ code: 'bad_request' });
  });
});

describe('applyFileEdit — targeted-edit match discipline', () => {
  it('rejects when old_string is not found', async () => {
    const file = path.join(root, 'f.txt');
    writeFileSync(file, 'hello world');
    await expect(applyFileEdit({ path: file, old_string: 'absent', new_string: 'x' }, { allowedRoots: roots }))
      .rejects.toMatchObject({ code: 'not_found' });
  });

  it('rejects an ambiguous (multi-occurrence) old_string', async () => {
    const file = path.join(root, 'f.txt');
    writeFileSync(file, 'x=1\nx=1\n');
    await expect(applyFileEdit({ path: file, old_string: 'x=1', new_string: 'x=2' }, { allowedRoots: roots }))
      .rejects.toMatchObject({ code: 'ambiguous_match' });
    expect(readFileSync(file, 'utf8')).toBe('x=1\nx=1\n'); // untouched
  });
});

describe('applyFileEdit — size guard', () => {
  it('rejects a result larger than maxBytes', async () => {
    const file = path.join(root, 'f.txt');
    writeFileSync(file, 'a');
    await expect(applyFileEdit({ path: file, content: 'x'.repeat(50) }, { allowedRoots: roots, maxBytes: 10 }))
      .rejects.toMatchObject({ code: 'too_large' });
  });

  it('exposes a sane default byte cap', () => {
    expect(MAX_EDIT_BYTES).toBeGreaterThan(0);
  });
});

describe('applyFileEdit — preserves file mode', () => {
  it('keeps a private 0600 file at 0600 after a content edit', async () => {
    const file = path.join(root, 'secret.conf');
    writeWithMode(file, 'PASSWORD=old\n', 0o600);
    await applyFileEdit({ path: file, content: 'PASSWORD=new\n' }, { allowedRoots: roots });
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readFileSync(file, 'utf8')).toBe('PASSWORD=new\n');
  });

  it('keeps an executable 0755 file executable after a targeted edit', async () => {
    const file = path.join(root, 'run.sh');
    writeWithMode(file, '#!/bin/sh\necho old\n', 0o755);
    await applyFileEdit({ path: file, old_string: 'echo old', new_string: 'echo new' }, { allowedRoots: roots });
    expect(statSync(file).mode & 0o777).toBe(0o755);
  });
});

describe('applyFileEdit — expected_sha256 compare-and-swap', () => {
  const sha = (s) => createHash('sha256').update(s).digest('hex');

  it('applies the edit when expected_sha256 matches the live content', async () => {
    const file = path.join(root, 'f.txt');
    writeFileSync(file, 'CURRENT');
    await applyFileEdit(
      { path: file, content: 'CHANGED', expected_sha256: sha('CURRENT') },
      { allowedRoots: roots },
    );
    expect(readFileSync(file, 'utf8')).toBe('CHANGED');
  });

  it('rejects with "stale" and does not write when expected_sha256 mismatches', async () => {
    const file = path.join(root, 'f.txt');
    writeFileSync(file, 'CURRENT');
    await expect(applyFileEdit(
      { path: file, content: 'CHANGED', expected_sha256: sha('SOMETHING-ELSE') },
      { allowedRoots: roots },
    )).rejects.toMatchObject({ code: 'stale' });
    expect(readFileSync(file, 'utf8')).toBe('CURRENT');
  });

  it('rejects a malformed expected_sha256 (not 64-hex)', async () => {
    const file = path.join(root, 'f.txt');
    writeFileSync(file, 'x');
    await expect(applyFileEdit(
      { path: file, content: 'y', expected_sha256: 'not-a-hash' },
      { allowedRoots: roots },
    )).rejects.toMatchObject({ code: 'bad_request' });
  });

  it('a replayed targeted edit is caught by expected_sha256 (no double-apply)', async () => {
    const file = path.join(root, 'f.txt');
    writeFileSync(file, 'x=1\n');
    const expected = sha('x=1\n');
    await applyFileEdit(
      { path: file, old_string: 'x=1', new_string: 'x=12', expected_sha256: expected },
      { allowedRoots: roots },
    );
    expect(readFileSync(file, 'utf8')).toBe('x=12\n');
    // Replay with the SAME expected hash now fails: content already advanced.
    await expect(applyFileEdit(
      { path: file, old_string: 'x=1', new_string: 'x=12', expected_sha256: expected },
      { allowedRoots: roots },
    )).rejects.toMatchObject({ code: 'stale' });
    expect(readFileSync(file, 'utf8')).toBe('x=12\n'); // not x=122
  });
});

describe('applyFileEdit — atomicity', () => {
  it('does not corrupt or truncate the original when the write fails', async () => {
    const file = path.join(root, 'durable.txt');
    writeFileSync(file, 'ORIGINAL');
    const boom = () => { throw new Error('disk full'); };
    await expect(applyFileEdit(
      { path: file, content: 'NEW' },
      { allowedRoots: roots, deps: {
        validateAndOpen: (await import('../lib/file-link-guard.js')).validateAndOpen,
        FileLinkDenied: (await import('../lib/file-link-guard.js')).FileLinkDenied,
        atomicWrite: boom,
      } },
    )).rejects.toThrow('disk full');
    expect(readFileSync(file, 'utf8')).toBe('ORIGINAL');
  });
});

describe('applyFileEdit — concurrency, encoding, and permissions', () => {
  it('two concurrent edits based on the same sha256: exactly one applies, the other is stale', async () => {
    const file = path.join(root, 'race.conf');
    writeFileSync(file, 'A=1\nB=1\n');
    const expected = createHash('sha256').update('A=1\nB=1\n').digest('hex');
    const results = await Promise.allSettled([
      applyFileEdit({ path: file, old_string: 'A=1', new_string: 'A=2', expected_sha256: expected }, { allowedRoots: roots }),
      applyFileEdit({ path: file, old_string: 'B=1', new_string: 'B=2', expected_sha256: expected }, { allowedRoots: roots }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toMatchObject({ code: 'stale' });
    expect(['A=2\nB=1\n', 'A=1\nB=2\n']).toContain(readFileSync(file, 'utf8'));
  });

  it('refuses a targeted edit of a file that is not valid utf-8, leaving its bytes intact', async () => {
    const file = path.join(root, 'latin1.txt');
    const bytes = Buffer.from([0x41, 0xff, 0x5a]);
    writeFileSync(file, bytes);
    await expect(applyFileEdit({ path: file, old_string: 'A', new_string: 'B' }, { allowedRoots: roots }))
      .rejects.toMatchObject({ code: 'not_text' });
    expect(readFileSync(file).equals(bytes)).toBe(true);
  });

  it('hands the original mode to the atomic writer so the temp file is never looser than the target', async () => {
    const file = path.join(root, 'private.conf');
    writeWithMode(file, 'k=v\n', 0o600);
    const seen = [];
    const { validateAndOpen, FileLinkDenied } = await import('../lib/file-link-guard.js');
    await applyFileEdit({ path: file, content: 'k=w\n' }, {
      allowedRoots: roots,
      deps: {
        validateAndOpen,
        FileLinkDenied,
        atomicWrite: (p, data, opts) => { seen.push(opts); writeFileReplacing(p, data, opts); },
      },
    });
    expect(seen).toEqual([{ mode: 0o600 }]);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readFileSync(file, 'utf8')).toBe('k=w\n');
  });
});

describe('applyFileEdit — credential paths and the temp file', () => {
  it('refuses credential files the shared guard lets through', async () => {
    for (const rel of ['.git-credentials', '.pgpass', '.envrc', path.join('.config', 'gh', 'hosts.yml'), path.join('.codex', 'auth.json')]) {
      const file = path.join(root, rel);
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, 'secret\n');
      await expect(applyFileEdit({ path: file, content: 'x' }, { allowedRoots: roots }))
        .rejects.toMatchObject({ code: 'sensitive' });
      expect(readFileSync(file, 'utf8')).toBe('secret\n');
    }
  });

  it('writes through an exclusive temp sibling and leaves no temp file behind', async () => {
    const file = path.join(root, 'app.conf');
    writeFileSync(file, 'a\n');
    await applyFileEdit({ path: file, content: 'b\n' }, { allowedRoots: roots });
    expect(readFileSync(file, 'utf8')).toBe('b\n');
    expect(readdirSync(root).filter((n) => n.endsWith('.tmp'))).toEqual([]);
  });
});

