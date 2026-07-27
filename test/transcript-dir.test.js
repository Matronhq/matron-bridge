import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  encodeProjectSegment,
  encodeProjectDir,
  resolveWorkdir,
  projectDirFor,
  transcriptPathFor,
  subagentsDirFor,
} from '../lib/transcript-dir.js';

// This encoder must match Claude Code's cwd → transcript-dir encoding byte for
// byte, or every read/tail/resume/list site points at a directory Claude never
// created. The two failure modes these tests guard against are (1) a sanitizer
// that only strips `/` (or a future `\w`-based one that spares `_`), and (2) a
// divergent long-path truncation that lands on the wrong hashed directory.
describe('encodeProjectSegment', () => {
  it('replaces every non-alphanumeric char with a dash — including the dot', () => {
    // A `.` must encode to `-`, so a dotted segment yields a double dash.
    expect(encodeProjectSegment('/home/dan/.config/ws')).toBe('-home-dan--config-ws');
  });

  it('encodes underscores to dashes (guards against a future \\w-based sanitizer)', () => {
    // Pinned regression: `_` is non-alphanumeric to Claude, so `my_app` must
    // become `my-app`. A `\w`-based sanitizer would silently keep the `_`.
    expect(encodeProjectSegment('/home/dan/my_app')).toBe('-home-dan-my-app');
  });

  it('leaves a dot-free, underscore-free path as the plain dashed form', () => {
    expect(encodeProjectSegment('/home/danbarker/foo')).toBe('-home-danbarker-foo');
  });

  it('does not truncate a segment of exactly 200 dashed chars', () => {
    const p = '/' + 'a'.repeat(199); // dashed length === 200
    const encoded = encodeProjectSegment(p);
    expect(encoded).toHaveLength(200);
    expect(encoded).toBe('-' + 'a'.repeat(199));
  });

  it('truncates a >200-char path to 200 chars + a base36 hash of the ORIGINAL path', () => {
    // Golden value cross-checked against Claude Code's own encoder
    // (h = (h*31 + charCode)|0 over the raw path, then base36 of |h|).
    const p = '/home/danbarker/' + Array.from({ length: 30 }, (_, i) => `segment_${i}`).join('/');
    const encoded = encodeProjectSegment(p);
    expect(encoded).toBe(
      '-home-danbarker-segment-0-segment-1-segment-2-segment-3-segment-4-segment-5-segment-6-segment-7-segment-8-segment-9-segment-10-segment-11-segment-12-segment-13-segment-14-segment-15-segment-16-segment-2humw2',
    );
    // Structural pins: 200-char dashed prefix, then `-`, then the hash.
    expect(encoded.slice(0, 200)).toBe(p.replace(/[^a-zA-Z0-9]/g, '-').slice(0, 200));
    expect(encoded.slice(200)).toBe('-2humw2');
  });
});

describe('resolveWorkdir', () => {
  let dir;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'td-')); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('realpaths a symlinked workdir so it encodes to the dir Claude actually wrote', () => {
    const real = fs.realpathSync(dir); // macOS /var → /private/var etc
    const link = path.join(fs.realpathSync(os.tmpdir()), `td-link-${process.pid}`);
    fs.symlinkSync(real, link);
    try {
      // path.resolve would keep the symlink; realpath collapses it to the target.
      expect(encodeProjectDir(link)).toBe(encodeProjectSegment(real));
      expect(resolveWorkdir(link)).toBe(real);
    } finally {
      fs.rmSync(link, { force: true });
    }
  });

  it('falls back to path.resolve for a not-yet-created workdir (no ENOENT throw)', () => {
    const missing = path.join(dir, 'does', 'not', 'exist');
    expect(resolveWorkdir(missing)).toBe(path.resolve(missing));
    expect(encodeProjectDir(missing)).toBe(encodeProjectSegment(path.resolve(missing)));
  });
});

describe('path builders (site-level)', () => {
  const base = path.join(os.homedir(), '.claude', 'projects');

  it('projectDirFor joins the encoded workdir under ~/.claude/projects', () => {
    expect(projectDirFor('/home/danbarker/my_app')).toBe(path.join(base, '-home-danbarker-my-app'));
  });

  it('transcriptPathFor appends <sessionId>.jsonl', () => {
    expect(transcriptPathFor('/home/danbarker/my_app', 'sid-9'))
      .toBe(path.join(base, '-home-danbarker-my-app', 'sid-9.jsonl'));
  });

  it('subagentsDirFor appends <sessionId>/subagents', () => {
    expect(subagentsDirFor('/home/danbarker/my_app', 'sid-9'))
      .toBe(path.join(base, '-home-danbarker-my-app', 'sid-9', 'subagents'));
  });
});
