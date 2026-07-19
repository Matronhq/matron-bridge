import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { resolveSpawnCwd, attachSpawnErrorHandler } from '../lib/spawn-guard.js';

describe('resolveSpawnCwd', () => {
  const exists = (p) => p === '/exists' || p === '/fallback';

  it('keeps the requested workdir when it exists', () => {
    expect(resolveSpawnCwd('/exists', ['/fallback'], { exists }))
      .toEqual({ cwd: '/exists', fellBack: false, missing: null });
  });

  it('falls back to the first existing fallback when the workdir is gone', () => {
    expect(resolveSpawnCwd('/renamed-away', ['/also-gone', '/fallback'], { exists }))
      .toEqual({ cwd: '/fallback', fellBack: true, missing: '/renamed-away' });
  });

  it('treats a null/empty workdir as missing', () => {
    expect(resolveSpawnCwd(null, ['/fallback'], { exists }))
      .toEqual({ cwd: '/fallback', fellBack: true, missing: null });
    expect(resolveSpawnCwd('', ['/fallback'], { exists }))
      .toEqual({ cwd: '/fallback', fellBack: true, missing: null });
  });

  it('returns the last fallback even when nothing exists', () => {
    expect(resolveSpawnCwd('/gone', ['/gone-too'], { exists }))
      .toEqual({ cwd: '/gone-too', fellBack: true, missing: '/gone' });
  });

  it('checks the real filesystem by default', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'spawn-guard-'));
    try {
      expect(resolveSpawnCwd(dir, ['/nope']).cwd).toBe(dir);
      expect(resolveSpawnCwd(path.join(dir, 'missing'), [dir]))
        .toEqual({ cwd: dir, fellBack: true, missing: path.join(dir, 'missing') });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('attachSpawnErrorHandler', () => {
  it("absorbs the 'error' event instead of crashing the process", () => {
    const proc = new EventEmitter();
    attachSpawnErrorHandler(proc, { notify: () => {}, log: () => {} });
    // Without a listener, EventEmitter throws on 'error' — the bridge crash.
    expect(() => proc.emit('error', new Error('spawn claude ENOENT'))).not.toThrow();
  });

  it('logs and notifies with the error message', () => {
    const proc = new EventEmitter();
    const notify = vi.fn();
    const log = vi.fn();
    attachSpawnErrorHandler(proc, { notify, log });
    proc.emit('error', new Error('spawn claude ENOENT'));
    expect(log).toHaveBeenCalledWith(expect.stringContaining('spawn claude ENOENT'));
    expect(notify).toHaveBeenCalledWith(expect.stringContaining('spawn claude ENOENT'));
  });

  it('survives a notifier that throws', () => {
    const proc = new EventEmitter();
    attachSpawnErrorHandler(proc, {
      notify: () => { throw new Error('room send failed'); },
      log: () => {},
    });
    expect(() => proc.emit('error', new Error('boom'))).not.toThrow();
  });
});
