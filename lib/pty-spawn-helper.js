// node-pty's spawn-helper must be executable, or no interactive session can
// start on macOS.
//
// On macOS every pty.spawn() execs node-pty's small `spawn-helper` binary
// (posix_spawn), which then execs the real command. node-pty 1.1.0 ships it
// prebuilt (prebuilds/darwin-<arch>/spawn-helper), and `npm install` can land
// it WITHOUT its execute bit. Every interactive spawn then throws
// "posix_spawnp failed." — /effort, /login, /mode interactive, and the
// resume of any room persisted as interactive. One Mac hit exactly this: a reinstall of node_modules left both darwin spawn-helpers at
// 0644, and `!effort high` killed the chat it ran in.
//
// Linux builds node-pty from source (build/Release/spawn-helper, created
// executable by the compiler) and Windows uses ConPTY with no helper, so this
// is a macOS failure in practice. The check is not platform-gated beyond
// skipping win32, though: a from-source helper that lost its bit somehow
// fails the same way, and the check is a few stat() calls.
//
// Two callers: scripts/fix-node-pty-perms.mjs (package.json postinstall, so
// every npm install / npm ci / fleet update repairs it) and
// lib/interactive-session.js (once per process before the first spawn, so a
// checkout installed by some other route self-heals too).

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const EXEC_BITS = 0o111;

// Every spawn-helper node-pty might load: the from-source build outputs and
// every non-Windows prebuild. All prebuilds, not just this process's arch: a
// Rosetta node (darwin-x64) on an arm64 Mac loads the x64 one.
export function spawnHelperCandidates(ptyDir, fsImpl = fs) {
  const out = [
    path.join(ptyDir, 'build', 'Release', 'spawn-helper'),
    path.join(ptyDir, 'build', 'Debug', 'spawn-helper'),
  ];
  const prebuilds = path.join(ptyDir, 'prebuilds');
  let entries = [];
  try {
    entries = fsImpl.readdirSync(prebuilds);
  } catch {
    // No prebuilds directory: a from-source install.
  }
  for (const name of entries.sort()) {
    if (name.startsWith('win32-')) continue;
    out.push(path.join(prebuilds, name, 'spawn-helper'));
  }
  return out;
}

// Make every existing spawn-helper executable. Never throws: a failure to
// chmod (read-only checkout, someone else's file) is reported in `failed`,
// and the spawn that follows fails visibly instead — the bridge then falls
// back to print mode (createSession in index.js).
//
// Returns { checked, fixed, failed: [{ path, error }] }.
export function ensureSpawnHelperExecutable({ ptyDir, platform = process.platform, fsImpl = fs } = {}) {
  const result = { checked: [], fixed: [], failed: [] };
  if (platform === 'win32' || !ptyDir) return result;
  for (const helper of spawnHelperCandidates(ptyDir, fsImpl)) {
    let stat;
    try {
      stat = fsImpl.statSync(helper);
    } catch {
      continue;
    }
    if (!stat.isFile()) continue;
    result.checked.push(helper);
    const mode = stat.mode & 0o7777;
    if ((mode & EXEC_BITS) === EXEC_BITS) continue;
    try {
      fsImpl.chmodSync(helper, mode | EXEC_BITS);
      result.fixed.push(helper);
    } catch (error) {
      result.failed.push({ path: helper, error: error?.message || String(error) });
    }
  }
  return result;
}

// The installed node-pty package directory, or null when it can't be found.
export function resolveNodePtyDir() {
  try {
    const require = createRequire(import.meta.url);
    return path.dirname(require.resolve('node-pty/package.json'));
  } catch {
    return null;
  }
}

// One human-readable line per problem, for logs and the postinstall script.
export function describeSpawnHelperResult(result) {
  const lines = [];
  for (const p of result.fixed) lines.push(`made node-pty spawn-helper executable: ${p}`);
  for (const f of result.failed) lines.push(`could not make node-pty spawn-helper executable: ${f.path} (${f.error}) — interactive mode will fail on this host`);
  return lines;
}
