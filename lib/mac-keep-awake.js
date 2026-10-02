// macOS half of the keep-awake marker.
//
// On the Linux dev VMs the host's vm-idle-stop probe reads
// ~/.matron-bridge-keepawake.json, so leasing that file (lib/work-hold.js,
// hold_awake reminders) is enough to keep the box up. A Mac has no such
// probe: pmset idle sleep runs on its own and ignores the file, so build-mac
// slept mid-session and only woke when Dan jogged the mouse (2026-10-02).
//
// Here the same `until` holds a `caffeinate -i` for as long as the marker
// does. `-i` only blocks IDLE system sleep — a laptop still sleeps on lid
// close and on battery the way its owner set it — and `-w <bridge pid>`
// releases the assertion if the bridge dies, so a crash cannot pin the Mac.
// `-t` ends it at the lease's own end even if no further update arrives.
//
// The writer calls update() every time it rewrites the marker (each reaper
// tick, each timer save); an unchanged `until` keeps the running child, a
// new one replaces it, null releases it. Pure apart from the injected spawn.

import { spawn as nodeSpawn } from 'node:child_process';

export function caffeinateArgs({ until, now = Date.now(), pid = process.pid }) {
  const secs = Math.max(1, Math.ceil((until - now) / 1000));
  return ['-i', '-w', String(pid), '-t', String(secs)];
}

export function createMacKeepAwake({
  platform = process.platform,
  spawn = nodeSpawn,
  pid = process.pid,
  now = () => Date.now(),
  log = () => {},
} = {}) {
  let child = null;
  let childUntil = null;

  function release() {
    if (!child) return;
    const c = child;
    child = null;
    childUntil = null;
    try { c.kill('SIGTERM'); } catch { /* already gone */ }
  }

  function update(until) {
    if (platform !== 'darwin') return;
    const t = now();
    if (!Number.isFinite(until) || until <= t) {
      release();
      return;
    }
    if (child && childUntil === until) return;
    release();
    try {
      const c = spawn('caffeinate', caffeinateArgs({ until, now: t, pid }), { stdio: 'ignore' });
      c.on('error', (e) => { log(`caffeinate failed: ${e.message}`); if (child === c) { child = null; childUntil = null; } });
      c.on('exit', () => { if (child === c) { child = null; childUntil = null; } });
      child = c;
      childUntil = until;
    } catch (e) {
      log(`caffeinate failed: ${e.message}`);
    }
  }

  return { update, release, get active() { return !!child; } };
}
