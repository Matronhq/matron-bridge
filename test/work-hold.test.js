import { describe, expect, it } from 'vitest';
import {
  WORK_HOLD_MAX_MS, WORK_HOLD_LEASE_MS, liveWorkChildren, workHold, keepAwakeUntil, parseProcessTable,
} from '../lib/work-hold.js';

// A session with work in flight is not idle (Dan, 2026-09-21: a colleague's
// hour-plus `rake test`, started from a chat session, was cut off when the
// bridge's idle reaper killed the session at the 60-minute mark; in
// interactive mode the PTY hang-up took the test run with it, the load fell,
// and the host idle-stopped the box 90 minutes later). Two signals say "work
// in flight": a turn in progress, and a live child process of the claude
// process that is not one of its MCP servers.

const T0 = 1_700_000_000_000;

describe('liveWorkChildren', () => {
  const table = [
    { pid: 1, ppid: 0, args: '/sbin/init' },
    { pid: 100, ppid: 1, args: 'node /home/d/matron-bridge/index.js' },
    { pid: 200, ppid: 100, args: 'claude --print --verbose --input-format stream-json' },
    { pid: 201, ppid: 200, args: 'node /home/d/matron-bridge/ask-user.js' },
    { pid: 202, ppid: 200, args: 'node /home/d/matron-bridge/show-file-mcp.js' },
    { pid: 203, ppid: 200, args: '/bin/sh /home/d/matron-bridge/hooks/xvfb-wrap.sh npx -y chrome-devtools-mcp --no-usage-statistics' },
    { pid: 204, ppid: 203, args: 'Xvfb :99 -screen 0 1280x800x24' },
    { pid: 205, ppid: 203, args: 'node /home/d/.npm/_npx/abc/node_modules/.bin/chrome-devtools-mcp' },
    { pid: 206, ppid: 205, args: '/opt/google/chrome/chrome --headless --remote-debugging-port=0' },
    { pid: 300, ppid: 200, args: '/usr/bin/zsh -c source /home/d/.claude/shell-snapshots/snapshot-zsh-1.sh && eval docker compose exec -T php-fpm rake test:run' },
    { pid: 301, ppid: 300, args: 'docker compose exec -T php-fpm rake test:run' },
    { pid: 302, ppid: 301, args: 'docker exec -i abc rake test:run' },
    { pid: 400, ppid: 100, args: 'claude --print --verbose' }, // another session's claude
    { pid: 401, ppid: 400, args: '/usr/bin/bash -c sleep 3000' },
  ];

  it('returns the descendants of the claude process that are work, grandchildren included', () => {
    const work = liveWorkChildren(200, table);
    expect(work.map((p) => p.pid).sort((a, b) => a - b)).toEqual([300, 301, 302]);
  });

  it('never counts MCP servers or the browser stack claude spawns for itself', () => {
    const quiet = table.filter((p) => ![300, 301, 302].includes(p.pid));
    expect(liveWorkChildren(200, quiet)).toEqual([]);
  });

  it('is scoped to the given pid — another session\'s children are not this session\'s work', () => {
    expect(liveWorkChildren(400, table).map((p) => p.pid)).toEqual([401]);
    expect(liveWorkChildren(999, table)).toEqual([]);
    expect(liveWorkChildren(null, table)).toEqual([]);
    expect(liveWorkChildren(200, [])).toEqual([]);
  });
});

describe('parseProcessTable', () => {
  it('parses `ps -axo pid=,ppid=,args=` output, tolerating leading spaces and args with spaces', () => {
    const out = '    1     0 /sbin/init splash\n  200   100 claude --print --verbose\n  300   200 /usr/bin/zsh -c source x && eval y\n\n';
    expect(parseProcessTable(out)).toEqual([
      { pid: 1, ppid: 0, args: '/sbin/init splash' },
      { pid: 200, ppid: 100, args: 'claude --print --verbose' },
      { pid: 300, ppid: 200, args: '/usr/bin/zsh -c source x && eval y' },
    ]);
    expect(parseProcessTable('')).toEqual([]);
    expect(parseProcessTable(null)).toEqual([]);
  });
});

describe('workHold', () => {
  it('holds a session mid-turn', () => {
    expect(workHold({ busy: true, children: [], idleSince: T0 - 3600_000, now: T0 })).toEqual({ reason: 'turn in progress' });
  });

  it('holds a session whose claude process still has work children, naming them', () => {
    const children = [{ pid: 301, args: 'docker compose exec -T php-fpm rake test:run' }];
    const hold = workHold({ busy: false, children, idleSince: T0 - 3600_000, now: T0 });
    expect(hold.reason).toMatch(/1 child process/);
    expect(hold.reason).toContain('docker compose exec -T php-fpm rake test:run');
  });

  it('does not hold an idle session with nothing running', () => {
    expect(workHold({ busy: false, children: [], idleSince: T0 - 3600_000, now: T0 })).toBeNull();
  });

  it('stops holding once the session has been idle for the cap, so a wedged job cannot pin it forever', () => {
    const children = [{ pid: 1, args: 'sleep infinity' }];
    expect(workHold({ busy: true, children, idleSince: T0 - WORK_HOLD_MAX_MS, now: T0 })).toBeNull();
    expect(workHold({ busy: false, children, idleSince: T0 - WORK_HOLD_MAX_MS - 1, now: T0 })).toBeNull();
    expect(workHold({ busy: false, children, idleSince: T0 - WORK_HOLD_MAX_MS + 1, now: T0 })).not.toBeNull();
  });

  it('caps at eight hours and leases the host marker fifteen minutes at a time', () => {
    expect(WORK_HOLD_MAX_MS).toBe(8 * 3600 * 1000);
    expect(WORK_HOLD_LEASE_MS).toBe(15 * 60 * 1000);
  });
});

describe('keepAwakeUntil', () => {
  it('is the later of the reminder hold and the work lease, or null when neither', () => {
    expect(keepAwakeUntil({ timerUntil: T0 + 10, workUntil: T0 + 20 })).toBe(T0 + 20);
    expect(keepAwakeUntil({ timerUntil: T0 + 30, workUntil: T0 + 20 })).toBe(T0 + 30);
    expect(keepAwakeUntil({ timerUntil: null, workUntil: T0 + 20 })).toBe(T0 + 20);
    expect(keepAwakeUntil({ timerUntil: T0 + 10, workUntil: 0 })).toBe(T0 + 10);
    expect(keepAwakeUntil({ timerUntil: null, workUntil: 0 })).toBeNull();
    expect(keepAwakeUntil({})).toBeNull();
  });
});
