// Restart onto new code by itself — the fix for a bridge that never updates.
//
// A rollout (deploy.sh, yearbook-infra's update-bridges) pulls the new code
// onto disk and then DEFERS the restart whenever the bridge hosts a live
// agent session, because the restart kills that session's process. The
// deferral is "picks up on the next natural restart" — and a bridge whose
// session is nearly always live (the Coordinator's box) has no natural
// restart. On 2026-10-02 bev ran code from the morning all evening, with
// three newer commits on disk, and voice notes went through local whisper
// although the journal already had the Azure transcript.
//
// So the bridge watches its own checkout. When HEAD moves (the last line
// of .git/logs/HEAD, the same "newest reflog entry" test update-bridges
// uses to call a process stale), it waits for the deploy to settle
// (npm install runs after the pull — a restart in between boots onto half
// a node_modules), proves the new tree can boot (the same preflight the
// deploy scripts run), and then exits for the supervisor to relaunch it:
//
//   * at the first poll where no session is mid-turn — an idle session is
//     killed and resumes with its history on its next turn, which is how a
//     bridge restart has always worked for it;
//   * or, once the new code has waited MAX_DEFER (30 min), regardless. The
//     interrupted turns leave inflight markers, so the next boot publishes a
//     "Carry on" card into each of those chats (lib/inflight-marker.js).
//
// Pure with every impure edge injected (file reads, clock, the session list,
// the preflight, the restart), the same shape as createInflightMarker, so the
// whole policy unit-tests without a checkout or a live bridge. index.js owns
// the timer and the gracefulShutdown.
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';

// What the process exits with when it restarts itself. Non-zero on purpose:
// launchd's KeepAlive { SuccessfulExit = false } relaunches only after an
// UNSUCCESSFUL exit (deploy.sh's kickstart -k is how a clean exit gets
// restarted there), systemd's Restart=always relaunches after any exit, and
// the Windows task restarts on failure. 75 is sysexits' EX_TEMPFAIL: "try
// again later", which is exactly the message.
export const RESTART_EXIT_CODE = 75;

export const DEFAULT_POLL_MS = 60_000;
// A pull is followed by npm install and a preflight; HEAD moves at the pull.
// Give the deploy this long to finish before trusting what is on disk.
export const DEFAULT_SETTLE_MS = 5 * 60_000;
// The longest a landed update waits for a quiet moment before it goes ahead
// mid-turn. A turn longer than this is rare; a session that is never
// between turns for this long is the case this whole module exists for.
export const DEFAULT_MAX_DEFER_MS = 30 * 60_000;
export const PREFLIGHT_TIMEOUT_MS = 120_000;

// Positive-integer env setting with a fallback; "0" is allowed where the
// caller treats it as off (pollMs never: a zero poll would spin).
export function parseMs(value, fallback) {
  const n = Number.parseInt(value, 10);
  return Number.isSafeInteger(n) && n > 0 ? n : fallback;
}

// MATRON_CODE_UPDATE_RESTART: unset or anything but "0"/"false"/"off" is on.
export function restartEnabled(value) {
  if (value == null) return true;
  return !/^(0|false|off|no)$/i.test(String(value).trim());
}

// The git directory behind a checkout: `.git` itself, or the directory a
// worktree's `.git` FILE points at ("gitdir: <path>", relative to the
// checkout). null when the checkout has neither — nothing to watch.
export function resolveGitDir(checkoutDir, { statSync = fs.statSync, readFileSync = fs.readFileSync } = {}) {
  const dotGit = path.join(checkoutDir, '.git');
  let st;
  try { st = statSync(dotGit); } catch { return null; }
  if (st.isDirectory()) return dotGit;
  if (!st.isFile()) return null;
  let text;
  try { text = String(readFileSync(dotGit, 'utf8')); } catch { return null; }
  const m = /^gitdir:\s*(.+?)\s*$/m.exec(text);
  if (!m) return null;
  return path.resolve(checkoutDir, m[1]);
}

// The newest reflog entry of HEAD: { sha, at } (at in ms) from the last
// non-empty line of logs/HEAD, which git appends on every HEAD move (a
// fast-forward merge, a checkout, a reset). null when there is no reflog
// or the line does not parse — the watcher then does nothing, ever: this
// only ever adds a restart, never blocks one.
//
// Line shape: "<old-sha> <new-sha> <name> <email> <unix-ts> <tz>\t<message>"
export function readHeadReflog(gitDir, { readFileSync = fs.readFileSync } = {}) {
  let text;
  try { text = String(readFileSync(path.join(gitDir, 'logs', 'HEAD'), 'utf8')); } catch { return null; }
  const lines = text.split('\n').filter(l => l.trim() !== '');
  if (!lines.length) return null;
  const head = lines[lines.length - 1].split('\t')[0];
  const m = /^[0-9a-f]{40} ([0-9a-f]{40}) .* (\d+) [+-]\d{4}$/.exec(head);
  if (!m) return null;
  return { sha: m[1], at: Number(m[2]) * 1000 };
}

// The same two checks update-bridges and deploy.sh run before they restart
// anything: index.js parses, and the import chain (native bindings
// included — sharp was the one that bit) resolves. Resolves to
// { ok: true } or { ok: false, error }. Never throws.
export function defaultPreflight(checkoutDir, { exec = execFile, timeoutMs = PREFLIGHT_TIMEOUT_MS } = {}) {
  const run = (args) => new Promise(resolve => {
    try {
      exec(process.execPath, args, { cwd: checkoutDir, timeout: timeoutMs, windowsHide: true }, (err, _stdout, stderr) => {
        if (!err) return resolve({ ok: true });
        const detail = String(stderr || err.message || err).trim().split('\n').slice(-3).join(' | ');
        resolve({ ok: false, error: `${args.join(' ')}: ${detail}` });
      });
    } catch (e) {
      resolve({ ok: false, error: e?.message || String(e) });
    }
  });
  return (async () => {
    const check = await run(['--check', 'index.js']);
    if (!check.ok) return check;
    return run(['--input-type=module', '-e', "await import('sharp'); await import('./lib/inline-image.js')"]);
  })();
}

// The policy, as one object with a tick(). Deps:
//   readHead()      -> { sha, at } | null   (the newest HEAD reflog entry)
//   busySessions()  -> number of sessions mid-turn right now
//   preflight()     -> Promise<{ ok, error? }>
//   restart(info)   -> exit for the supervisor; info = { sha, forced, busy, waitedMs }
//   now()           -> ms
//   log / warn      -> console-ish
//   bootSha         -> the HEAD sha this process started on (default: read now)
export function createCodeUpdateWatcher({
  readHead,
  busySessions,
  preflight,
  restart,
  now = Date.now,
  log = () => {},
  warn = () => {},
  bootSha,
  settleMs = DEFAULT_SETTLE_MS,
  maxDeferMs = DEFAULT_MAX_DEFER_MS,
}) {
  const boot = bootSha ?? readHead()?.sha ?? null;
  // The update waiting for a quiet moment: { sha, since }.
  let pending = null;
  // A sha whose preflight failed, logged once; the deploy's own rollback
  // moves HEAD again, which clears it. Without this a broken tree would be
  // preflighted (and warned about) every poll.
  let refused = null;
  // A preflight in progress; a tick during it does nothing.
  let checking = null;
  let restarted = false;

  const short = (sha) => (typeof sha === 'string' ? sha.slice(0, 7) : String(sha));
  const mins = (ms) => Math.round(ms / 60_000);

  async function tick() {
    if (restarted) return { action: 'restarted' };
    const head = readHead();
    if (!head) return { action: 'none', reason: 'no reflog' };
    if (!boot || head.sha === boot) {
      if (pending) {
        log(`[code-update] HEAD is back on ${short(boot)}; the pending restart is off`);
        pending = null;
      }
      return { action: 'none', reason: 'unchanged' };
    }
    const t = now();
    if (t - head.at < settleMs) return { action: 'settling', sha: head.sha };
    if (head.sha === refused) return { action: 'refused', sha: head.sha };
    if (checking) return { action: 'checking', sha: head.sha };

    if (!pending || pending.sha !== head.sha) {
      checking = preflight();
      let result;
      try { result = await checking; } catch (e) { result = { ok: false, error: e?.message || String(e) }; } finally { checking = null; }
      if (!result || !result.ok) {
        refused = head.sha;
        pending = null;
        warn(`[code-update] new code on disk (${short(head.sha)}, running ${short(boot)}) failed its preflight — NOT restarting onto it: ${result?.error || 'unknown error'}`);
        return { action: 'refused', sha: head.sha, error: result?.error };
      }
      pending = { sha: head.sha, since: now() };
      log(`[code-update] new code on disk: ${short(head.sha)} (running ${short(boot)}). Restarting when no session is mid-turn, at the latest in ${mins(maxDeferMs)} min.`);
    }

    const busy = busySessions();
    const waitedMs = now() - pending.since;
    if (busy > 0 && waitedMs < maxDeferMs) {
      return { action: 'waiting', sha: head.sha, busy, waitedMs };
    }
    const forced = busy > 0;
    restarted = true;
    const info = { sha: head.sha, forced, busy, waitedMs };
    if (forced) {
      warn(`[code-update] ${busy} session(s) still mid-turn after ${mins(waitedMs)} min — restarting onto ${short(head.sha)} anyway; interrupted chats get a carry-on card on boot`);
    } else {
      log(`[code-update] no session mid-turn — restarting onto ${short(head.sha)}`);
    }
    restart(info);
    return { action: 'restart', ...info };
  }

  return {
    tick,
    get bootSha() { return boot; },
    get pending() { return pending; },
  };
}
