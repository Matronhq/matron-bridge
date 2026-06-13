import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  parseModelDefaultCommand,
  resolveSpawnModel,
  readSpawnModel,
  writeSpawnModel,
} from '../lib/spawn-model.js';

describe('parseModelDefaultCommand', () => {
  it('returns show when there is no further argument', () => {
    expect(parseModelDefaultCommand([])).toEqual({ action: 'show' });
  });

  it('sets a normalized alias for a valid argument', () => {
    expect(parseModelDefaultCommand(['Opus[1M]'])).toEqual({ action: 'set', value: 'opus[1m]' });
    expect(parseModelDefaultCommand(['sonnet'])).toEqual({ action: 'set', value: 'sonnet' });
  });

  it('accepts a full claude-* model name', () => {
    expect(parseModelDefaultCommand(['claude-opus-4-8'])).toEqual({ action: 'set', value: 'claude-opus-4-8' });
  });

  it('treats reset words as a clear', () => {
    for (const w of ['reset', 'clear', 'none', 'off', 'auto', 'RESET']) {
      expect(parseModelDefaultCommand([w]).action).toBe('reset');
    }
  });

  it('rejects an unknown model with a hint', () => {
    const r = parseModelDefaultCommand(['banana']);
    expect(r.action).toBe('invalid');
    expect(r.message).toMatch(/Unknown model/);
  });
});

describe('resolveSpawnModel', () => {
  it('returns null when nothing is set', () => {
    expect(resolveSpawnModel({})).toBe(null);
    expect(resolveSpawnModel({ persisted: '', env: '' })).toBe(null);
    expect(resolveSpawnModel({ persisted: null, env: undefined })).toBe(null);
  });

  it('prefers the persisted value over env', () => {
    expect(resolveSpawnModel({ persisted: 'opus', env: 'sonnet' })).toBe('opus');
  });

  it('falls back to env when nothing is persisted', () => {
    expect(resolveSpawnModel({ persisted: null, env: 'sonnet[1m]' })).toBe('sonnet[1m]');
  });

  it('trims surrounding whitespace', () => {
    expect(resolveSpawnModel({ persisted: '  opus  ' })).toBe('opus');
  });
});

describe('readSpawnModel / writeSpawnModel', () => {
  // A unique, securely-permissioned temp dir per test (mkdtempSync) rather than a
  // predictable name in the shared /tmp root — avoids the symlink/predictable-path
  // class CodeQL flags as "insecure temporary file".
  let dir;
  let tmp;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-cfg-test-'));
    tmp = path.join(dir, 'config.json');
  });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('returns null when the file is missing or malformed', () => {
    expect(readSpawnModel(path.join(dir, 'definitely-not-here.json'))).toBe(null);
    fs.writeFileSync(tmp, 'not json');
    expect(readSpawnModel(tmp)).toBe(null);
  });

  it('round-trips a model value', () => {
    writeSpawnModel(tmp, 'opus[1m]');
    expect(readSpawnModel(tmp)).toBe('opus[1m]');
  });

  it('clears with null while preserving other keys', () => {
    fs.writeFileSync(tmp, JSON.stringify({ spawnModel: 'opus', other: 1 }));
    writeSpawnModel(tmp, null);
    expect(readSpawnModel(tmp)).toBe(null);
    expect(JSON.parse(fs.readFileSync(tmp, 'utf8')).other).toBe(1);
  });
});
