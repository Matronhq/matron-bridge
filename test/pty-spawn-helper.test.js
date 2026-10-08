import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  ensureSpawnHelperExecutable,
  spawnHelperCandidates,
  resolveNodePtyDir,
  describeSpawnHelperResult,
} from '../lib/pty-spawn-helper.js';

const posixOnly = process.platform === 'win32' ? it.skip : it;

describe('node-pty spawn-helper exec bit (alice-mac posix_spawnp failure, 2026-10-05)', () => {
  let dir;
  const helper = (...parts) => path.join(dir, ...parts, 'spawn-helper');
  const write = (file, mode) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '#!/bin/sh\n');
    fs.chmodSync(file, mode);
  };
  const modeOf = (file) => fs.statSync(file).mode & 0o777;

  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pty-helper-')); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('lists the build outputs and every non-Windows prebuild', () => {
    for (const name of ['darwin-arm64', 'darwin-x64', 'win32-x64']) fs.mkdirSync(path.join(dir, 'prebuilds', name), { recursive: true });
    expect(spawnHelperCandidates(dir)).toEqual([
      helper('build', 'Release'),
      helper('build', 'Debug'),
      helper('prebuilds', 'darwin-arm64'),
      helper('prebuilds', 'darwin-x64'),
    ]);
  });

  posixOnly('restores the execute bit on a prebuilt helper installed 0644, for both darwin arches', () => {
    write(helper('prebuilds', 'darwin-arm64'), 0o644);
    write(helper('prebuilds', 'darwin-x64'), 0o644);
    const result = ensureSpawnHelperExecutable({ ptyDir: dir, platform: 'darwin' });
    expect(result.fixed).toEqual([helper('prebuilds', 'darwin-arm64'), helper('prebuilds', 'darwin-x64')]);
    expect(result.failed).toEqual([]);
    expect(modeOf(helper('prebuilds', 'darwin-arm64'))).toBe(0o755);
    expect(modeOf(helper('prebuilds', 'darwin-x64'))).toBe(0o755);
  });

  posixOnly('leaves an already-executable helper alone and is idempotent', () => {
    write(helper('build', 'Release'), 0o755);
    const first = ensureSpawnHelperExecutable({ ptyDir: dir, platform: 'linux' });
    expect(first).toEqual({ checked: [helper('build', 'Release')], fixed: [], failed: [] });
    write(helper('prebuilds', 'darwin-arm64'), 0o600);
    ensureSpawnHelperExecutable({ ptyDir: dir, platform: 'darwin' });
    // Only the missing x bits are added; the owner-only read/write stays.
    expect(modeOf(helper('prebuilds', 'darwin-arm64'))).toBe(0o711);
    expect(ensureSpawnHelperExecutable({ ptyDir: dir, platform: 'darwin' }).fixed).toEqual([]);
  });

  it('does nothing on Windows (ConPTY, no helper) or without a node-pty dir', () => {
    write(helper('prebuilds', 'darwin-arm64'), 0o644);
    expect(ensureSpawnHelperExecutable({ ptyDir: dir, platform: 'win32' })).toEqual({ checked: [], fixed: [], failed: [] });
    expect(ensureSpawnHelperExecutable({ ptyDir: null, platform: 'darwin' })).toEqual({ checked: [], fixed: [], failed: [] });
  });

  it('reports a helper it cannot chmod instead of throwing', () => {
    const file = helper('prebuilds', 'darwin-arm64');
    const fakeFs = {
      readdirSync: () => ['darwin-arm64'],
      statSync: (p) => {
        if (p !== file) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
        return { isFile: () => true, mode: 0o100644 };
      },
      chmodSync: () => { throw new Error('EPERM: operation not permitted'); },
    };
    const result = ensureSpawnHelperExecutable({ ptyDir: dir, platform: 'darwin', fsImpl: fakeFs });
    expect(result.fixed).toEqual([]);
    expect(result.failed).toEqual([{ path: file, error: 'EPERM: operation not permitted' }]);
    expect(describeSpawnHelperResult(result)[0]).toMatch(/could not make node-pty spawn-helper executable: .*EPERM.*interactive mode will fail/);
  });

  it('finds the installed node-pty', () => {
    const ptyDir = resolveNodePtyDir();
    expect(ptyDir).toBeTruthy();
    expect(JSON.parse(fs.readFileSync(path.join(ptyDir, 'package.json'), 'utf8')).name).toBe('node-pty');
  });
});

describe('postinstall wiring', () => {
  const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

  it('repairs the helper on every npm install / npm ci, the route deploy.sh and update-bridges take', () => {
    expect(pkg.scripts.postinstall).toBe('node scripts/fix-node-pty-perms.mjs');
    expect(fs.existsSync(new URL('../scripts/fix-node-pty-perms.mjs', import.meta.url))).toBe(true);
  });
});
