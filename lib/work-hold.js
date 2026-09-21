// Work in flight keeps a session — and its box — up.
//
// The bridge's idle reaper kills a claude process after SESSION_IDLE_TIMEOUT_MS
// (an hour) without assistant text or user input. That clock knows nothing
// about a turn still running or a background job the agent started: a
// colleague's hour-plus `rake test`, launched from a chat session, was cut
// off at the 60-minute mark (Dan, 2026-09-21) — in interactive mode the PTY
// hang-up took the test run with it, the load fell, and the host's
// vm-idle-stop wound the box down 90 minutes later. The host probe's own
// signals (logins, ssh, a `claude` process, load ≥ 0.5, a hold_awake
// reminder) are all either gone or unreliable at that point.
//
// Two signals say "work in flight", both read at each reaper tick:
//   - the session is mid-turn (`session.busy`);
//   - the claude process has a live descendant that is not one of the
//     servers claude spawns for itself (MCP servers, the headless browser
//     stack) — a shell running a tool call, a background Bash task, and
//     whatever they spawned.
// While either holds, the reaper skips the session and index.js leases the
// guest-side keep-awake marker (the same ~/.matron-bridge-keepawake.json the
// hold_awake reminders use, read by the host's vm-idle-stop probe) so the box
// stays up even if the job's load dips below the probe's threshold — a test
// suite waiting on a lock, say. Both are bounded by WORK_HOLD_MAX_MS from the
// session's last activity so a wedged job cannot pin a session or a box for
// good; the lease is short and re-issued every tick so a crashed bridge
// cannot either.
//
// Pure: the process table, the clock and the session fields are injected.

export const WORK_HOLD_MAX_MS = 8 * 3600 * 1000;
// Re-issued every reaper tick (SESSION_IDLE_CHECK_MS, 5 min); three ticks of
// slack so one slow tick does not let the host's 10-minute probe see a lapse.
export const WORK_HOLD_LEASE_MS = 15 * 60 * 1000;

// What claude spawns for ITSELF, present for the whole session and never
// evidence of work: the bridge's MCP servers (mcp-config.json: ask-user,
// show-file, chrome-devtools behind hooks/xvfb-wrap.sh) and the browser stack
// the last of those starts. Anything else under the claude process is a tool
// call or a background task — which is exactly the work this exists to keep
// alive.
export const NON_WORK_CHILD_PATTERNS = [
  /\/ask-user\.js\b/,
  /\/show-file-mcp\.js\b/,
  /xvfb-wrap\.sh|\bxvfb-run\b|\bXvfb\b/,
  /chrome-devtools-mcp/,
  /\bchrom(e|ium)\b/i,
];

export function isWorkProcess(args) {
  const a = typeof args === 'string' ? args : '';
  return !NON_WORK_CHILD_PATTERNS.some((re) => re.test(a));
}

// `ps -axo pid=,ppid=,args=` (Linux and macOS alike) -> [{pid, ppid, args}].
export function parseProcessTable(text) {
  if (typeof text !== 'string' || !text) return [];
  const out = [];
  for (const line of text.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (!m) continue;
    out.push({ pid: parseInt(m[1], 10), ppid: parseInt(m[2], 10), args: m[3].trim() });
  }
  return out;
}

// Every descendant of `pid` (children, grandchildren, …) that counts as work.
// A descendant of a non-work process is skipped with it: the browser under
// the MCP server is not work either.
export function liveWorkChildren(pid, table) {
  if (!Number.isInteger(pid) || !Array.isArray(table) || !table.length) return [];
  const byParent = new Map();
  for (const p of table) {
    if (!p || !Number.isInteger(p.pid) || !Number.isInteger(p.ppid)) continue;
    if (!byParent.has(p.ppid)) byParent.set(p.ppid, []);
    byParent.get(p.ppid).push(p);
  }
  const work = [];
  const seen = new Set();
  const stack = [pid];
  while (stack.length) {
    const parent = stack.pop();
    for (const child of byParent.get(parent) || []) {
      if (seen.has(child.pid)) continue;
      seen.add(child.pid);
      if (!isWorkProcess(child.args)) continue;
      work.push({ pid: child.pid, args: child.args });
      stack.push(child.pid);
    }
  }
  return work;
}

// The reaper's decision for one session: {reason} to keep it, or null to let
// the idle clock rule. `idleSince` is the session's last activity stamp.
export function workHold({ busy = false, children = [], idleSince = 0, now = Date.now() } = {}) {
  if (now - idleSince >= WORK_HOLD_MAX_MS) return null;
  if (busy) return { reason: 'turn in progress' };
  const live = Array.isArray(children) ? children : [];
  if (!live.length) return null;
  const first = String(live[0].args || '').slice(0, 160);
  return { reason: `${live.length} child process${live.length === 1 ? '' : 'es'} still running (${first})` };
}

// The marker's `until`: whichever of the hold_awake reminders and the work
// lease ends later, or null when neither is in force (the file is removed).
export function keepAwakeUntil({ timerUntil = null, workUntil = 0 } = {}) {
  const t = Number.isFinite(timerUntil) ? timerUntil : 0;
  const w = Number.isFinite(workUntil) ? workUntil : 0;
  const until = Math.max(t, w);
  return until > 0 ? until : null;
}
