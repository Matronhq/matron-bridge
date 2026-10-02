// macOS: a Mac with work in flight must not go to sleep.
//
// On the Linux dev boxes the HOST decides when a box stops (vm-idle-stop: a
// live `claude` process, load, the keep-awake marker in lib/work-hold.js all
// count as activity) and the journal's wake command starts it again. A Mac
// has no such supervisor: macOS itself sleeps the machine once the display
// has been off for `pmset sleep` minutes — one minute by default on an Apple
// silicon desktop — and knows nothing about a turn in progress. build-mac
// slept mid-turn, eleven minutes into a session watching CI, and stayed
// asleep until someone moved its mouse (Dan, 2026-10-02): a sleeping Mac
// runs nothing, so the bridge's socket, its reminders and the turn all froze.
//
// So on macOS the bridge holds the power assertion itself, through
// /usr/bin/caffeinate (ships with macOS, needs no privileges):
//   - `-i` (no idle sleep, on any power source) while a session is live — the
//     same "a claude process exists" signal the Linux host probe uses, so the
//     idle reaper (an hour idle, longer with work in flight) is what finally
//     lets the Mac sleep — or while a hold_awake reminder is pending;
//   - `-s` (no sleep on mains power) for the bridge's whole life when
//     MATRON_KEEP_AWAKE=always: nothing can wake a sleeping Mac from the
//     internet, so a Mac that must stay reachable for new sessions, reminders
//     and invites does not sleep at all. On battery `-s` is void and the Mac
//     sleeps as usual.
// The display is never held on. caffeinate is started with `-w <bridge pid>`,
// so the assertion goes when the bridge does, however it dies.
//
// Pure but for the injected spawn.

import { spawn as nodeSpawn } from 'node:child_process';

export const CAFFEINATE = '/usr/bin/caffeinate';
// How often index.js re-evaluates the hold. Short against macOS's shortest
// idle-sleep setting (one minute), cheap enough to never matter.
export const POWER_HOLD_TICK_MS = 15 * 1000;

// env + platform -> 'off' | 'work' | 'always'. Only macOS has anything to
// hold; `work` is the default there because a bridge whose turn can be frozen
// mid-flight by the OS is broken, whereas never sleeping is the owner's call.
export function keepAwakeMode(env = process.env, platform = process.platform) {
  if (platform !== 'darwin') return 'off';
  const raw = String(env.MATRON_KEEP_AWAKE ?? '').trim().toLowerCase();
  if (['off', '0', 'false', 'no', 'never'].includes(raw)) return 'off';
  if (raw === 'always') return 'always';
  return 'work';
}

// The caffeinate flags the current state calls for; [] means no assertion.
// `holdUntil` is the keep-awake marker's `until` (lib/work-hold.js
// keepAwakeUntil): a pending hold_awake reminder outlives a bridge restart,
// when no session is live yet.
export function powerHoldFlags({ mode = 'off', liveSessions = 0, holdUntil = null, now = Date.now() } = {}) {
  if (mode !== 'work' && mode !== 'always') return [];
  const flags = [];
  if (mode === 'always') flags.push('-s');
  if (liveSessions > 0 || (Number.isFinite(holdUntil) && holdUntil > now)) flags.push('-i');
  return flags;
}

// Owns the one caffeinate child. set(flags) is idempotent: it starts, swaps
// or stops the child only when the flags differ from what is held, and
// restarts a child that died on its own at the next call. Never throws — a
// Mac that cannot run caffeinate sleeps as it did before, and says so once.
export function createPowerHold({ spawn = nodeSpawn, pid = process.pid, log = console } = {}) {
  let child = null;
  let held = '';
  let warned = false;

  function release() {
    const c = child;
    child = null;
    held = '';
    if (c) { try { c.kill(); } catch { /* already gone */ } }
  }

  function warn(message) {
    if (warned) return;
    warned = true;
    try { log.warn(`[power] cannot hold the Mac awake: ${message}`); } catch { /* logging must never throw */ }
  }

  return {
    // Returns true when the held assertion changed.
    set(flags) {
      const want = Array.isArray(flags) ? flags.join(' ') : '';
      if (want === held && (child || !want)) return false;
      release();
      if (!want) return true;
      try {
        const c = spawn(CAFFEINATE, [...flags, '-w', String(pid)], { stdio: 'ignore' });
        child = c;
        held = want;
        const gone = () => { if (child === c) { child = null; held = ''; } };
        c.on('error', (e) => { gone(); warn(e.message); });
        c.on('exit', gone);
        c.unref?.();
      } catch (e) {
        warn(e.message);
      }
      return held === want;
    },
    stop: release,
    held: () => held,
  };
}
