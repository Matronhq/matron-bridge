import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  readEffortDefaults,
  restoreEffortDefaults,
  createEffortDefaultGuard,
  claudeSettingsPath,
} from '../lib/claude-effort-default.js';

describe('readEffortDefaults', () => {
  it('collects per-model and top-level effort levels, nothing else', () => {
    expect(readEffortDefaults({
      effortLevel: 'medium',
      model: 'opus',
      modelSettings: { 'claude-opus-5-5': { effortLevel: 'high', other: 1 }, 'claude-sonnet-5': { other: 2 } },
    })).toEqual({ '': 'medium', 'claude-opus-5-5': 'high' });
    expect(readEffortDefaults({})).toEqual({});
    expect(readEffortDefaults(null)).toEqual({});
  });
});

describe('restoreEffortDefaults', () => {
  it('removes an effort default the chat added, dropping emptied entries', () => {
    const s = { tui: 'fullscreen', modelSettings: { 'claude-opus-5-5': { effortLevel: 'high' } } };
    expect(restoreEffortDefaults(s, {})).toBe(true);
    expect(s).toEqual({ tui: 'fullscreen' });
  });

  it('puts a changed default back and keeps sibling keys', () => {
    const s = { modelSettings: { 'claude-opus-5-5': { effortLevel: 'max', keep: true } }, effortLevel: 'low' };
    expect(restoreEffortDefaults(s, { 'claude-opus-5-5': 'medium' })).toBe(true);
    expect(s).toEqual({ modelSettings: { 'claude-opus-5-5': { effortLevel: 'medium', keep: true } } });
  });

  it('recreates a default the write removed', () => {
    const s = {};
    expect(restoreEffortDefaults(s, { '': 'high', 'claude-opus-5-5': 'low' })).toBe(true);
    expect(s).toEqual({ effortLevel: 'high', modelSettings: { 'claude-opus-5-5': { effortLevel: 'low' } } });
  });

  it('reports no change when nothing moved', () => {
    const s = { modelSettings: { m: { effortLevel: 'high' } } };
    expect(restoreEffortDefaults(s, { m: 'high' })).toBe(false);
  });
});

describe('claudeSettingsPath', () => {
  it('honours CLAUDE_CONFIG_DIR', () => {
    expect(claudeSettingsPath({ CLAUDE_CONFIG_DIR: '/x/cfg' })).toBe(path.join('/x/cfg', 'settings.json'));
  });
});

describe('createEffortDefaultGuard', () => {
  let file; let writes;
  const make = (over = {}) => createEffortDefaultGuard({
    file: 'settings.json', pollMs: 1000, graceMs: 2000, maxMs: 60000,
    read: () => (file === null ? null : structuredClone(file)),
    write: (_f, v) => { writes.push(v); file = structuredClone(v); },
    log: () => {},
    ...over,
  });
  beforeEach(() => { vi.useFakeTimers(); writes = []; file = { tui: 'x' }; });
  afterEach(() => { vi.useRealTimers(); });

  it('restores the snapshot a grace period after the write settles', () => {
    const g = make();
    let settled = false;
    g.acquire(() => settled);
    file.modelSettings = { 'claude-opus-5-5': { effortLevel: 'high' } }; // Claude saves it
    vi.advanceTimersByTime(5000);
    expect(writes).toHaveLength(0); // not settled yet
    settled = true;
    vi.advanceTimersByTime(1000);
    expect(writes).toHaveLength(0); // grace running
    vi.advanceTimersByTime(3000);
    expect(file).toEqual({ tui: 'x' });
    expect(g.holding).toBe(0);
  });

  it('keeps one box-wide snapshot across overlapping writes', () => {
    const g = make();
    let a = false; let b = false;
    g.acquire(() => a);
    file.modelSettings = { m: { effortLevel: 'high' } };
    g.acquire(() => b); // second chat snapshots nothing new: it sees chat A's write
    file.modelSettings = { m: { effortLevel: 'max' } };
    a = true;
    vi.advanceTimersByTime(10000);
    expect(writes).toHaveLength(0); // B still in flight
    b = true;
    vi.advanceTimersByTime(10000);
    expect(file).toEqual({ tui: 'x' }); // the ORIGINAL default, not chat A's
  });

  it('writes nothing when the default never changed', () => {
    const g = make();
    g.acquire(() => true);
    vi.advanceTimersByTime(10000);
    expect(writes).toHaveLength(0);
  });

  it('gives up after maxMs on a write that never settles, and restores', () => {
    const g = make();
    g.acquire(() => false);
    file.effortLevel = 'max';
    vi.advanceTimersByTime(60000);
    expect(file).toEqual({ tui: 'x' });
  });

  it('never overwrites a settings file it cannot parse', () => {
    const g = make();
    g.acquire(() => true);
    file = null;
    vi.advanceTimersByTime(10000);
    expect(writes).toHaveLength(0);
    file = null;
    expect(make().acquire(() => true)).toBeNull();
  });

  it('treats a throwing settle check as settled', () => {
    const g = make();
    g.acquire(() => { throw new Error('gone'); });
    file.effortLevel = 'high';
    vi.advanceTimersByTime(10000);
    expect(file).toEqual({ tui: 'x' });
  });
});

describe('index.js wiring', () => {
  const src = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
  it('guards the saved default at both bridge-typed /effort writes, Claude only', () => {
    expect(src.match(/guardEffortDefault\(session\);/g)?.length).toBe(2);
    expect(src).toContain('const effortDefaultGuard = createEffortDefaultGuard();');
    expect(src).toContain('if (session.agent === AGENT_CODEX) return;');
  });
});
