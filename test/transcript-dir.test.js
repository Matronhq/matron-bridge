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
  findTranscriptBySessionId,
} from '../lib/transcript-dir.js';

// This encoder must match Claude Code's cwd → transcript-dir encoding byte for
// byte, or every read/tail/resume/list site points at a directory Claude never
// created. The two failure modes these tests guard against are (1) a sanitizer
// that only strips `/` (or a future `\w`-based one that spares `_`), and (2) a
// divergent long-path truncation that lands on the wrong hashed directory.
describe('encodeProjectSegment', () => {
  it('replaces every non-alphanumeric char with a dash — including the dot', () => {
    // A `.` must encode to `-`, so a dotted segment yields a double dash.
    expect(encodeProjectSegment('/home/alice/.config/ws')).toBe('-home-alice--config-ws');
  });

  it('encodes underscores to dashes (guards against a future \\w-based sanitizer)', () => {
    // Pinned regression: `_` is non-alphanumeric to Claude, so `my_app` must
    // become `my-app`. A `\w`-based sanitizer would silently keep the `_`.
    expect(encodeProjectSegment('/home/alice/my_app')).toBe('-home-alice-my-app');
  });

  it('leaves a dot-free, underscore-free path as the plain dashed form', () => {
    expect(encodeProjectSegment('/home/developer/foo')).toBe('-home-developer-foo');
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
    const p = '/home/developer/' + Array.from({ length: 30 }, (_, i) => `segment_${i}`).join('/');
    const encoded = encodeProjectSegment(p);
    expect(encoded).toBe(
      '-home-developer-segment-0-segment-1-segment-2-segment-3-segment-4-segment-5-segment-6-segment-7-segment-8-segment-9-segment-10-segment-11-segment-12-segment-13-segment-14-segment-15-segment-16-segment-8295pu',
    );
    // Structural pins: 200-char dashed prefix, then `-`, then the hash.
    expect(encoded.slice(0, 200)).toBe(p.replace(/[^a-zA-Z0-9]/g, '-').slice(0, 200));
    expect(encoded.slice(200)).toBe('-8295pu');
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
    expect(projectDirFor('/home/developer/my_app')).toBe(path.join(base, '-home-developer-my-app'));
  });

  it('transcriptPathFor appends <sessionId>.jsonl', () => {
    expect(transcriptPathFor('/home/developer/my_app', 'sid-9'))
      .toBe(path.join(base, '-home-developer-my-app', 'sid-9.jsonl'));
  });

  it('subagentsDirFor appends <sessionId>/subagents', () => {
    expect(subagentsDirFor('/home/developer/my_app', 'sid-9'))
      .toBe(path.join(base, '-home-developer-my-app', 'sid-9', 'subagents'));
  });
});

// A session that changes cwd mid-flight (EnterWorktree) has its transcript
// relocated to the new cwd's project dir; the resume paths fall back to this
// by-id search so the stale persisted workdir doesn't demote the resume to a
// fresh spawn (silent conversation loss — the fresh-clone-bootstrap amnesia).
describe('findTranscriptBySessionId', () => {
  let root;
  const entry = (cwd) => JSON.stringify({ type: 'user', cwd, message: { role: 'user' } }) + '\n';
  const writeTranscript = (dirName, sessionId, lines) => {
    const dir = path.join(root, dirName);
    fs.mkdirSync(dir, { recursive: true });
    const p = path.join(dir, `${sessionId}.jsonl`);
    fs.writeFileSync(p, lines.join(''));
    return p;
  };

  beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'td-find-')); });
  afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

  it('returns null when no project dir holds a transcript for the id', () => {
    writeTranscript('-home-alice-app', 'other-session', [entry('/home/alice/app')]);
    expect(findTranscriptBySessionId('sid-1', { projectsRoot: root })).toBeNull();
  });

  it('returns null for a missing projects root', () => {
    expect(findTranscriptBySessionId('sid-1', { projectsRoot: path.join(root, 'nope') })).toBeNull();
  });

  it('finds the transcript and recovers the workdir from its last cwd entry', () => {
    const p = writeTranscript('-home-alice-app--claude-worktrees-wt', 'sid-1', [
      entry('/home/alice/app'),
      entry('/home/alice/app/.claude/worktrees/wt'),
    ]);
    expect(findTranscriptBySessionId('sid-1', { projectsRoot: root }))
      .toEqual({ transcriptPath: p, workdir: '/home/alice/app/.claude/worktrees/wt' });
  });

  it('prefers the most recently modified transcript when several dirs match', () => {
    const stale = writeTranscript('-home-alice-app', 'sid-1', [entry('/home/alice/app')]);
    const live = writeTranscript('-home-alice-wt', 'sid-1', [entry('/home/alice/wt')]);
    const old = new Date(Date.now() - 60_000);
    fs.utimesSync(stale, old, old);
    expect(findTranscriptBySessionId('sid-1', { projectsRoot: root }))
      .toEqual({ transcriptPath: live, workdir: '/home/alice/wt' });
  });

  it('skips malformed tail lines and lines without a cwd while scanning backwards', () => {
    const p = writeTranscript('-home-alice-app', 'sid-1', [
      entry('/home/alice/app'),
      JSON.stringify({ type: 'summary' }) + '\n',
      '{"truncated": "not json\n',
    ]);
    expect(findTranscriptBySessionId('sid-1', { projectsRoot: root }))
      .toEqual({ transcriptPath: p, workdir: '/home/alice/app' });
  });

  it('reports a null workdir when no entry carries a cwd', () => {
    const p = writeTranscript('-home-alice-app', 'sid-1', [JSON.stringify({ type: 'summary' }) + '\n']);
    expect(findTranscriptBySessionId('sid-1', { projectsRoot: root }))
      .toEqual({ transcriptPath: p, workdir: null });
  });

  it('rejects a session id that is not a plain token (filename-component safety)', () => {
    writeTranscript('-home-alice-app', 'sid-1', [entry('/home/alice/app')]);
    expect(findTranscriptBySessionId('../-home-alice-app/sid-1', { projectsRoot: root })).toBeNull();
    expect(findTranscriptBySessionId('', { projectsRoot: root })).toBeNull();
  });

  it('finds a cwd recorded before a >256KB cwd-less tail (Bugbot: scan must not stop at one tail chunk)', () => {
    // A giant final tool-result line with no cwd fills more than one scan
    // chunk; the backward scan must keep walking into older chunks.
    const huge = JSON.stringify({ type: 'user', message: { role: 'user', content: 'x'.repeat(600 * 1024) } }) + '\n';
    const p = writeTranscript('-home-alice-app', 'sid-1', [entry('/home/alice/app'), huge]);
    expect(findTranscriptBySessionId('sid-1', { projectsRoot: root }))
      .toEqual({ transcriptPath: p, workdir: '/home/alice/app' });
  });

  it('parses a cwd-bearing line that spans a chunk boundary', () => {
    // Pad the entry so the line holding the cwd straddles the 256KB chunk
    // edge — the carry logic must reassemble it before parsing.
    const padded = JSON.stringify({ type: 'user', cwd: '/home/alice/span', pad: 'y'.repeat(200 * 1024) }) + '\n';
    const trailer = JSON.stringify({ type: 'user', message: { role: 'user', content: 'z'.repeat(180 * 1024) } }) + '\n';
    const p = writeTranscript('-home-alice-app', 'sid-1', [padded, trailer]);
    expect(findTranscriptBySessionId('sid-1', { projectsRoot: root }))
      .toEqual({ transcriptPath: p, workdir: '/home/alice/span' });
  });

  it('still prefers the LATEST cwd when older chunks hold earlier ones', () => {
    const filler = JSON.stringify({ type: 'summary', pad: 'f'.repeat(300 * 1024) }) + '\n';
    const p = writeTranscript('-home-alice-app', 'sid-1', [
      entry('/home/alice/old'),
      filler,
      entry('/home/alice/new'),
    ]);
    expect(findTranscriptBySessionId('sid-1', { projectsRoot: root }))
      .toEqual({ transcriptPath: p, workdir: '/home/alice/new' });
  });
});
