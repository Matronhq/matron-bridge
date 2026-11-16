import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { it, expect } from 'vitest';

const repo = fileURLToPath(new URL('../', import.meta.url));

it('MATRON_BRIDGE_PREFLIGHT=module loads the import graph and exits 0 before startup', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'preflight-'));
  try {
    const res = spawnSync(process.execPath, ['index.js'], {
      cwd: repo,
      env: { PATH: process.env.PATH, HOME: home, USERPROFILE: home, MATRON_BRIDGE_PREFLIGHT: 'module' },
      timeout: 30000,
      encoding: 'utf8',
    });
    expect(res.error).toBeUndefined();
    expect(res.status, res.stderr).toBe(0);
    // No journal URL or token was set: reaching config or startup would warn or exit non-zero.
    expect(res.stdout).toBe('');
    expect(fs.readdirSync(home)).toEqual([]);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}, 40000);
