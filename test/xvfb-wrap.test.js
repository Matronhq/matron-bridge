import { describe, it, expect } from 'vitest';
import { spawn, execFileSync } from 'child_process';
import { fileURLToPath } from 'url';

// Integration tests for hooks/xvfb-wrap.sh — the leak-proof replacement for
// xvfb-run in the browser MCP stack. xvfb-run is a /bin/sh (dash) script
// whose ONLY cleanup is `trap clean_up EXIT`, and dash does not run EXIT
// traps when killed by SIGTERM while waiting on a foreground child — which
// is exactly how claude tears down MCP servers. Every reaped/crashed browser
// session stranded one Xvfb (39 found on dev-6 when this was written), and
// the strays then made --auto-servernum's display probing retry-storm on
// "server already running". The wrapper must therefore guarantee the Xvfb
// dies with it on EVERY exit path — clean exit, SIGTERM, and (via
// PR_SET_PDEATHSIG) even SIGKILL — while preserving the stdio passthrough
// the MCP protocol runs over.
//
// Linux-only by nature (Xvfb + setpriv); skipped elsewhere, same pattern as
// the matron-journal integration suite.

const WRAP = fileURLToPath(new URL('../hooks/xvfb-wrap.sh', import.meta.url));

function hasBin(name) {
  try {
    execFileSync('sh', ['-c', `command -v ${name}`], { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

const canRun = process.platform === 'linux' && hasBin('Xvfb');
const describeIfXvfb = canRun ? describe : describe.skip;
const itIfSetpriv = canRun && hasBin('setpriv') ? it : it.skip;

function delay(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitFor(predicate, timeoutMs = 15000, intervalMs = 100) {
  const start = Date.now();
  while (!(await predicate())) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor: timed out');
    await delay(intervalMs);
  }
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// The wrapper's Xvfb is its direct child (setpriv execs in place).
function xvfbChildOf(wrapperPid) {
  try {
    const out = execFileSync('pgrep', ['-P', String(wrapperPid), '-x', 'Xvfb'], { encoding: 'utf-8' }).trim();
    return out ? parseInt(out.split('\n')[0], 10) : null;
  } catch {
    return null;
  }
}

// Spawn the wrapper around a command, collect stdout, wait for a marker line.
function spawnWrap(cmdArgs) {
  const proc = spawn(WRAP, cmdArgs, { stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  proc.stdout.on('data', (d) => { stdout += d.toString(); });
  proc.stderr.on('data', (d) => { stderr += d.toString(); });
  const exited = new Promise((resolve) => proc.on('exit', (code, signal) => resolve({ code, signal })));
  return { proc, exited, getStdout: () => stdout, getStderr: () => stderr };
}

describeIfXvfb('hooks/xvfb-wrap.sh', () => {
  it('runs the command with DISPLAY set, passes stdin through, and reaps its Xvfb on clean exit', async () => {
    const w = spawnWrap(['bash', '-c', 'echo "READY:$DISPLAY"; read -r line; echo "GOT:$line"']);
    await waitFor(() => w.getStdout().includes('READY:'));

    const display = w.getStdout().match(/READY:(\S+)/)[1];
    expect(display).toMatch(/^:\d+$/);

    const xvfbPid = xvfbChildOf(w.proc.pid);
    expect(xvfbPid).not.toBeNull();
    expect(pidAlive(xvfbPid)).toBe(true);

    // stdin passthrough — the MCP protocol runs over this pipe, so a wrapper
    // that lets bash redirect the backgrounded command's stdin to /dev/null
    // would silently break every browser session.
    w.proc.stdin.write('hello\n');
    await waitFor(() => w.getStdout().includes('GOT:hello'));

    const { code } = await w.exited;
    expect(code).toBe(0);
    await waitFor(() => !pidAlive(xvfbPid));
  }, 30000);

  it('propagates the command exit code', async () => {
    const w = spawnWrap(['bash', '-c', 'exit 7']);
    const { code } = await w.exited;
    expect(code).toBe(7);
  }, 30000);

  it('SIGTERM (claude MCP teardown path) kills the command, its descendants, and the Xvfb — the xvfb-run leak', async () => {
    // The grandchild models npx → chrome-devtools-mcp: the process claude
    // talks to is NOT the wrapper's direct child, and it only exits on stdin
    // EOF — which never comes if its inherited stdin isn't claude's dying
    // pipe. The wrapper must kill the command's whole process group.
    // (marker: a sleep duration nothing else on the box would use)
    const w = spawnWrap(['bash', '-c', 'echo "READY:$DISPLAY"; sleep 3971 & wait']);
    await waitFor(() => w.getStdout().includes('READY:'));
    const xvfbPid = xvfbChildOf(w.proc.pid);
    expect(xvfbPid).not.toBeNull();
    await waitFor(() => {
      try { return execFileSync('pgrep', ['-f', 'sleep 3971'], { encoding: 'utf-8' }).trim() !== ''; } catch { return false; }
    });

    w.proc.kill('SIGTERM');
    await w.exited;
    await waitFor(() => !pidAlive(xvfbPid));

    // No survivors: neither the direct child nor the grandchild sleep.
    await waitFor(() => xvfbChildOf(w.proc.pid) === null);
    await waitFor(() => {
      try { execFileSync('pgrep', ['-f', 'sleep 3971'], { stdio: 'pipe' }); return false; } catch { return true; }
    });
  }, 30000);

  itIfSetpriv('SIGKILL (crash/OOM path) still reaps the Xvfb via PR_SET_PDEATHSIG', async () => {
    const w = spawnWrap(['bash', '-c', 'echo "READY:$DISPLAY"; sleep 300']);
    await waitFor(() => w.getStdout().includes('READY:'));
    const xvfbPid = xvfbChildOf(w.proc.pid);
    expect(xvfbPid).not.toBeNull();

    w.proc.kill('SIGKILL');
    await w.exited;
    // No trap can run after SIGKILL — only the kernel's pdeathsig delivery
    // can save us here.
    await waitFor(() => !pidAlive(xvfbPid));
  }, 30000);

  it('exits non-zero with a diagnostic if Xvfb cannot start', async () => {
    // Sabotage: make the wrapper look for an Xvfb binary that doesn't exist.
    const proc = spawn(WRAP, ['bash', '-c', 'echo should-not-run'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, XVFB_WRAP_XVFB_BIN: '/nonexistent/Xvfb' },
    });
    let stderr = '';
    let stdout = '';
    proc.stderr.on('data', (d) => { stderr += d.toString(); });
    proc.stdout.on('data', (d) => { stdout += d.toString(); });
    const { code } = await new Promise((resolve) => proc.on('exit', (c, s) => resolve({ code: c, signal: s })));
    expect(code).not.toBe(0);
    expect(stderr).toMatch(/xvfb-wrap/i);
    expect(stdout).not.toContain('should-not-run');
  }, 30000);
});
