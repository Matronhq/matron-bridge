# Live Bash Output Tile Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add live-streaming Bash command output to claude-matrix-bridge, rendered as a sandboxed iframe in modified Matron clients. Output is purged after 4 hours so it never persists in chat history.

**Architecture:** A `PreToolUse` hook rewrites Bash commands to tee output to a per-command log file. The bridge correlates the log path back to the `tool_use_id` from Claude's stream-json, posts a custom Matrix event (`com.matron.live_output.v1`), and tracks the log lifecycle (in-memory map, GC, startup sweep). The viewer gets a new `/live` HTML endpoint and `/live/ws` WebSocket endpoint that tails the log file. The matron-web fork registers a custom message renderer that returns a sandboxed iframe pointing at `/live`.

**Tech Stack:** Node.js 20, vitest, Express, `ws` (WebSocket), Matrix client, React (matron-web).

**Spec:** [docs/plans/2026-05-02-live-bash-output-tile-design.md](2026-05-02-live-bash-output-tile-design.md)

---

## Phase 0 — Validate critical assumption (DO THIS FIRST)

The whole design depends on Claude Code's PreToolUse hook being able to modify `tool_input.command`. If it can't, the design needs a different mechanism (`$SHELL` wrapper) — better to know before writing 30 tasks of code that won't fit.

### Task 0.1: Empirically verify PreToolUse hook can modify tool_input.command

**Files:**
- Create: `/tmp/probe-hook.sh` (throwaway)
- Create: `/tmp/probe-settings.json` (throwaway)

- [ ] **Step 1: Write probe hook script**

```bash
cat > /tmp/probe-hook.sh <<'EOF'
#!/bin/bash
set -e
INPUT=$(cat)
TOOL=$(echo "$INPUT" | jq -r '.tool_name // empty')
CMD=$(echo "$INPUT" | jq -r '.tool_input.command // empty')
if [ "$TOOL" = "Bash" ] && [ -n "$CMD" ]; then
  NEW_CMD="echo PROBE_REWROTE_THIS && ($CMD)"
  jq -n --arg c "$NEW_CMD" '{
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      updatedInput: { command: $c }
    }
  }'
fi
exit 0
EOF
chmod +x /tmp/probe-hook.sh
```

- [ ] **Step 2: Write probe settings**

```bash
cat > /tmp/probe-settings.json <<'EOF'
{
  "hooks": {
    "PreToolUse": [{
      "matcher": "Bash",
      "hooks": [{
        "type": "command",
        "command": "/tmp/probe-hook.sh"
      }]
    }]
  }
}
EOF
```

- [ ] **Step 3: Run claude with the probe and a Bash command**

Run:
```bash
echo '{"type":"user","message":{"role":"user","content":"run: echo hello"}}' | \
  claude --print --input-format stream-json --output-format stream-json --verbose \
    --dangerously-skip-permissions \
    --settings /tmp/probe-settings.json 2>&1 | tee /tmp/probe-output.log
```

- [ ] **Step 4: Verify the rewrite happened**

Check `/tmp/probe-output.log` for `PROBE_REWROTE_THIS`:
```bash
grep PROBE_REWROTE_THIS /tmp/probe-output.log
```

Expected: matches found (hook successfully rewrote the command).

- [ ] **Step 5: Test exit-code propagation through the rewrite**

Modify the probe to wrap the command and run a `false` (exit 1). Confirm Claude reports `is_error: true` (or non-zero exit code) in the resulting `tool_result`. This validates that wrapping doesn't mangle exit codes.

- [ ] **Step 6: Decide and document**

If Step 4 fails, **stop and revisit the design** — the `$SHELL` wrapper fallback path needs different plumbing. If Step 4 passes, proceed.

Cleanup:
```bash
rm /tmp/probe-hook.sh /tmp/probe-settings.json /tmp/probe-output.log
```

- [ ] **Step 7: Commit nothing**

Phase 0 produces no committable artifacts — just a go/no-go decision.

---

## Phase 1 — `matron-tee` wrapper script

A small Node script that runs a command, captures stdout+stderr to a file with a size cap, and propagates the exit code. This isolates shell-escaping concerns from the hook.

### Task 1.1: Create the wrapper with a basic capture test

**Files:**
- Create: `hooks/matron-tee` (Node script, executable, no extension)
- Test: `test/matron-tee.test.js`

- [ ] **Step 1: Write the failing test for basic capture**

```js
// test/matron-tee.test.js
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';

const run = promisify(execFile);
const TEE = path.resolve('hooks/matron-tee');

describe('matron-tee', () => {
  let tmp;
  beforeEach(() => { tmp = mkdtempSync(path.join(tmpdir(), 'tee-test-')); });
  afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });

  it('captures stdout and stderr to log file', async () => {
    const log = path.join(tmp, 'out.log');
    await run(TEE, [log, '--', 'sh', '-c', 'echo hi-stdout; echo hi-stderr 1>&2']);
    const content = readFileSync(log, 'utf-8');
    expect(content).toContain('hi-stdout');
    expect(content).toContain('hi-stderr');
  });
});
```

- [ ] **Step 2: Run the test, confirm it fails**

Run: `npx vitest run test/matron-tee.test.js`
Expected: FAIL — `hooks/matron-tee` doesn't exist.

- [ ] **Step 3: Implement the wrapper**

```js
#!/usr/bin/env node
// hooks/matron-tee
// Usage: matron-tee <log-path> -- <command> [args...]
import { spawn } from 'child_process';
import { createWriteStream, existsSync, mkdirSync } from 'fs';
import path from 'path';

const args = process.argv.slice(2);
const sepIdx = args.indexOf('--');
if (sepIdx < 1) {
  console.error('Usage: matron-tee <log-path> -- <command> [args...]');
  process.exit(2);
}

const logPath = args[0];
const cmdArgs = args.slice(sepIdx + 1);
const cmd = cmdArgs[0];
const rest = cmdArgs.slice(1);

const MAX_BYTES = parseInt(process.env.MATRON_LIVE_OUTPUT_MAX_BYTES || String(50 * 1024 * 1024), 10);

const dir = path.dirname(logPath);
if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
const log = createWriteStream(logPath);

log.on('error', err => {
  process.stderr.write(`[matron-tee: log write error: ${err.message}]\n`);
  process.exit(126);
});

let bytesWritten = 0;
let truncated = false;

function pipe(source, sink) {
  source.on('data', chunk => {
    if (truncated) return;
    if (bytesWritten + chunk.length > MAX_BYTES) {
      const remaining = MAX_BYTES - bytesWritten;
      if (remaining > 0) log.write(chunk.subarray(0, remaining));
      log.write(`\n[matron-tee: output truncated at ${MAX_BYTES} bytes]\n`);
      truncated = true;
      bytesWritten = MAX_BYTES;
      return;
    }
    bytesWritten += chunk.length;
    log.write(chunk);
    sink.write(chunk);
  });
}

const child = spawn(cmd, rest, { stdio: ['inherit', 'pipe', 'pipe'] });
pipe(child.stdout, process.stdout);
pipe(child.stderr, process.stderr);

child.on('close', (code, signal) => {
  log.end(() => {
    if (signal) process.kill(process.pid, signal);
    else process.exit(code ?? 1);
  });
});

child.on('error', err => {
  log.write(`\n[matron-tee: spawn error: ${err.message}]\n`);
  log.end(() => process.exit(127));
});
```

Mark executable:
```bash
chmod +x hooks/matron-tee
```

- [ ] **Step 4: Run test, confirm it passes**

Run: `npx vitest run test/matron-tee.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add hooks/matron-tee test/matron-tee.test.js
git commit -m "feat(matron-tee): wrapper script captures cmd output to log"
```

### Task 1.2: Verify exit code propagation

**Files:**
- Modify: `test/matron-tee.test.js`

- [ ] **Step 1: Add failing test for exit code**

```js
  it('propagates non-zero exit code', async () => {
    const log = path.join(tmp, 'out.log');
    await expect(run(TEE, [log, '--', 'sh', '-c', 'exit 7']))
      .rejects.toMatchObject({ code: 7 });
  });

  it('propagates zero exit code', async () => {
    const log = path.join(tmp, 'out.log');
    const { stdout } = await run(TEE, [log, '--', 'sh', '-c', 'exit 0']);
    expect(stdout).toBe('');
  });
```

- [ ] **Step 2: Run the new tests, confirm they pass**

Run: `npx vitest run test/matron-tee.test.js`
Expected: PASS for both new tests.

- [ ] **Step 3: Commit**

```bash
git add test/matron-tee.test.js
git commit -m "test(matron-tee): exit code propagation"
```

### Task 1.3: Verify size cap

**Files:**
- Modify: `test/matron-tee.test.js`

- [ ] **Step 1: Add failing test for size cap**

```js
  it('truncates output past MATRON_LIVE_OUTPUT_MAX_BYTES', async () => {
    const log = path.join(tmp, 'out.log');
    // Cap at 1KB; produce 5KB of output
    await run(TEE, [log, '--', 'sh', '-c', 'yes x | head -c 5000'], {
      env: { ...process.env, MATRON_LIVE_OUTPUT_MAX_BYTES: '1024' }
    });
    const content = readFileSync(log, 'utf-8');
    expect(content).toContain('[matron-tee: output truncated at 1024 bytes]');
    const sentinelIdx = content.indexOf('[matron-tee: output truncated');
    // Cap applies to user output (1024 bytes); the wrapper writes a leading
    // '\n' delimiter before the sentinel, so the sentinel string starts at
    // byte index MAX_BYTES + 1.
    expect(sentinelIdx).toBeLessThanOrEqual(1025);
  });
```

- [ ] **Step 2: Run test, confirm it passes**

Run: `npx vitest run test/matron-tee.test.js`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add test/matron-tee.test.js
git commit -m "test(matron-tee): size cap with sentinel marker"
```

---

## Phase 2 — `matron-bash-tee.sh` PreToolUse hook

### Task 2.1: Write the hook script

**Files:**
- Create: `hooks/matron-bash-tee.sh`
- Test: `test/matron-bash-tee.test.js`

- [ ] **Step 1: Write failing test**

```js
// test/matron-bash-tee.test.js
import { describe, it, expect } from 'vitest';
import { execFile } from 'child_process';
import path from 'path';

const HOOK = path.resolve('hooks/matron-bash-tee.sh');
const TEE = path.resolve('hooks/matron-tee');

function runHook(input, env = {}) {
  return new Promise((resolve, reject) => {
    const child = execFile(HOOK, [], {
      env: { ...process.env, ...env },
    }, (err, stdout, stderr) => {
      if (err) return reject(err);
      resolve({ stdout, stderr });
    });
    child.stdin.write(JSON.stringify(input));
    child.stdin.end();
  });
}

describe('matron-bash-tee.sh', () => {
  it('rewrites Bash commands when MATRON_BASH_TEE_ENABLED=1', async () => {
    const { stdout } = await runHook({
      session_id: 's1',
      tool_use_id: 'toolu_abc',
      tool_name: 'Bash',
      tool_input: { command: 'ls -la' }
    }, { MATRON_BASH_TEE_ENABLED: '1' });
    const parsed = JSON.parse(stdout);
    expect(parsed.hookSpecificOutput.hookEventName).toBe('PreToolUse');
    expect(parsed.hookSpecificOutput.updatedInput.command).toBe(
      `${TEE} /tmp/matron-cmd-toolu_abc.log -- bash -c 'ls -la'`
    );
  });

  it('passes through when MATRON_BASH_TEE_ENABLED unset', async () => {
    const { stdout } = await runHook({
      session_id: 's1',
      tool_use_id: 'toolu_abc',
      tool_name: 'Bash',
      tool_input: { command: 'ls -la' }
    });
    expect(stdout.trim()).toBe('');
  });

  it('passes through for non-Bash tools', async () => {
    const { stdout } = await runHook({
      session_id: 's1',
      tool_use_id: 'toolu_abc',
      tool_name: 'Read',
      tool_input: { file_path: '/etc/hosts' }
    }, { MATRON_BASH_TEE_ENABLED: '1' });
    expect(stdout.trim()).toBe('');
  });

  it('passes through on malformed JSON input (no crash, no rewrite)', async () => {
    const { stdout, stderr } = await new Promise((resolve, reject) => {
      const child = execFile(HOOK, [], {
        env: { ...process.env, MATRON_BASH_TEE_ENABLED: '1' },
      }, (err, stdout, stderr) => {
        if (err) return reject(err);
        resolve({ stdout, stderr });
      });
      child.stdin.write('this is not json');
      child.stdin.end();
    });
    expect(stdout.trim()).toBe('');
  });

  it('passes through when tool_use_id is malformed', async () => {
    const { stdout } = await runHook({
      session_id: 's1',
      tool_use_id: '../../../etc/passwd',
      tool_name: 'Bash',
      tool_input: { command: 'ls' }
    }, { MATRON_BASH_TEE_ENABLED: '1' });
    expect(stdout.trim()).toBe('');
  });
});
```

- [ ] **Step 2: Run test, confirm it fails**

Run: `npx vitest run test/matron-bash-tee.test.js`
Expected: FAIL — `hooks/matron-bash-tee.sh` doesn't exist.

- [ ] **Step 3: Write the hook**

```bash
cat > hooks/matron-bash-tee.sh <<'EOF'
#!/bin/bash
# PreToolUse hook for Bash commands - rewrites command to tee output to a log
# file via matron-tee. Only active when MATRON_BASH_TEE_ENABLED=1. Passes
# through (exit 0, empty stdout) on any unexpected input.
INPUT=$(cat)
ENABLED="${MATRON_BASH_TEE_ENABLED:-0}"
TOOL=$(echo "$INPUT" | jq -r '.tool_name // empty' 2>/dev/null)
CMD=$(echo "$INPUT" | jq -r '.tool_input.command // empty' 2>/dev/null)
TUID=$(echo "$INPUT" | jq -r '.tool_use_id // empty' 2>/dev/null)

if [ "$ENABLED" != "1" ] || [ "$TOOL" != "Bash" ] || [ -z "$CMD" ] || [ -z "$TUID" ]; then
  exit 0
fi

# Defense-in-depth: tool_use_id is API-generated as `toolu_[A-Za-z0-9_]+`.
# Reject anything else to avoid path traversal or shell-metacharacter injection
# via the log path or rewritten command.
if [[ ! "$TUID" =~ ^toolu_[A-Za-z0-9_]+$ ]]; then
  exit 0
fi

HOOK_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TEE_BIN="$HOOK_DIR/matron-tee"
LOG_PATH="/tmp/matron-cmd-${TUID}.log"

QUOTED_CMD=$(echo "$INPUT" | jq -r '.tool_input.command | @sh')
NEW_CMD="$TEE_BIN $LOG_PATH -- bash -c $QUOTED_CMD"

jq -n --arg c "$NEW_CMD" '{
  hookSpecificOutput: {
    hookEventName: "PreToolUse",
    updatedInput: { command: $c }
  }
}'
EOF
chmod +x hooks/matron-bash-tee.sh
```

- [ ] **Step 4: Run test, confirm it passes**

Run: `npx vitest run test/matron-bash-tee.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add hooks/matron-bash-tee.sh test/matron-bash-tee.test.js
git commit -m "feat(hook): matron-bash-tee.sh rewrites Bash to tee output"
```

---

## Phase 3 — Bridge `lib/live-output.js` module

Factor the live-output state, sentinel handling, and GC into its own module so `index.js` doesn't grow further.

### Task 3.1: Create the in-memory store

**Files:**
- Create: `lib/live-output.js`
- Test: `test/live-output.test.js`

- [ ] **Step 1: Write failing test for register/get**

```js
// test/live-output.test.js
import { describe, it, expect, beforeEach } from 'vitest';
import { createLiveOutputStore } from '../lib/live-output.js';

describe('LiveOutputStore', () => {
  let store;
  beforeEach(() => { store = createLiveOutputStore({ ttlSeconds: 60, now: () => 1000 }); });

  it('register and get an entry', () => {
    store.register('toolu_1', { logPath: '/tmp/a.log', roomId: '!room:s' });
    const entry = store.get('toolu_1');
    expect(entry).toEqual({
      logPath: '/tmp/a.log',
      doneSentinelPath: '/tmp/a.log.done',
      roomId: '!room:s',
      expiresAt: 1060,
      complete: false,
    });
  });

  it('get returns undefined for unknown id', () => {
    expect(store.get('nope')).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test, confirm it fails**

Run: `npx vitest run test/live-output.test.js`
Expected: FAIL — module doesn't exist.

- [ ] **Step 3: Implement minimal store**

```js
// lib/live-output.js
export function createLiveOutputStore({ ttlSeconds = 14400, now = () => Math.floor(Date.now() / 1000) } = {}) {
  const entries = new Map();

  function register(toolUseId, { logPath, roomId }) {
    entries.set(toolUseId, {
      logPath,
      doneSentinelPath: `${logPath}.done`,
      roomId,
      expiresAt: now() + ttlSeconds,
      complete: false,
    });
  }

  function get(toolUseId) {
    return entries.get(toolUseId);
  }

  return { register, get };
}
```

- [ ] **Step 4: Run test, confirm it passes**

Run: `npx vitest run test/live-output.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/live-output.js test/live-output.test.js
git commit -m "feat(live-output): register/get for in-memory store"
```

### Task 3.2: Mark complete + write sentinel

**Files:**
- Modify: `lib/live-output.js`
- Modify: `test/live-output.test.js`

- [ ] **Step 1: Write failing test**

Add to `test/live-output.test.js`:

```js
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync, utimesSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';

  it('markComplete writes sentinel JSON and flips complete flag', () => {
    const tmp = mkdtempSync(path.join(tmpdir(), 'live-'));
    const logPath = path.join(tmp, 'cmd.log');
    store.register('toolu_2', { logPath, roomId: '!r:s' });
    store.markComplete('toolu_2', { exitCode: 0, denied: false, truncated: false });
    expect(existsSync(`${logPath}.done`)).toBe(true);
    const sentinel = JSON.parse(readFileSync(`${logPath}.done`, 'utf-8'));
    expect(sentinel).toEqual({ exitCode: 0, denied: false, truncated: false });
    expect(store.get('toolu_2').complete).toBe(true);
    rmSync(tmp, { recursive: true });
  });

  it('markComplete is a no-op for unknown id', () => {
    expect(() => store.markComplete('nope', { exitCode: 0 })).not.toThrow();
  });
```

- [ ] **Step 2: Run test, confirm it fails**

Run: `npx vitest run test/live-output.test.js`
Expected: FAIL — `markComplete` not defined.

- [ ] **Step 3: Implement markComplete**

Add to `lib/live-output.js`:

```js
import { writeFileSync } from 'fs';

// inside createLiveOutputStore:
  function markComplete(toolUseId, { exitCode = null, denied = false, truncated = false } = {}) {
    const entry = entries.get(toolUseId);
    if (!entry) return;
    writeFileSync(entry.doneSentinelPath, JSON.stringify({ exitCode, denied, truncated }));
    entry.complete = true;
  }

  return { register, get, markComplete };
```

- [ ] **Step 4: Run test, confirm it passes**

Run: `npx vitest run test/live-output.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/live-output.js test/live-output.test.js
git commit -m "feat(live-output): markComplete writes done sentinel"
```

### Task 3.3: GC sweep removes expired entries

**Files:**
- Modify: `lib/live-output.js`
- Modify: `test/live-output.test.js`

- [ ] **Step 1: Write failing test**

```js
  it('gcExpired deletes log + sentinel files and removes entries past expiry', () => {
    const tmp = mkdtempSync(path.join(tmpdir(), 'live-'));
    const logPath = path.join(tmp, 'cmd.log');
    let clock = 1000;
    const s = createLiveOutputStore({ ttlSeconds: 60, now: () => clock });
    writeFileSync(logPath, 'output');
    s.register('toolu_3', { logPath, roomId: '!r:s' });
    s.markComplete('toolu_3', { exitCode: 0, denied: false, truncated: false });

    clock = 1000 + 70; // past expiry
    const removed = s.gcExpired();
    expect(removed).toBe(1);
    expect(existsSync(logPath)).toBe(false);
    expect(existsSync(`${logPath}.done`)).toBe(false);
    expect(s.get('toolu_3')).toBeUndefined();
    rmSync(tmp, { recursive: true });
  });
```

- [ ] **Step 2: Run test, confirm it fails**

Run: `npx vitest run test/live-output.test.js`
Expected: FAIL — `gcExpired` not defined.

- [ ] **Step 3: Implement gcExpired**

Add to `lib/live-output.js`:

```js
import { unlinkSync } from 'fs';

  function gcExpired() {
    let removed = 0;
    for (const [id, entry] of entries) {
      if (now() >= entry.expiresAt) {
        try { unlinkSync(entry.logPath); } catch {}
        try { unlinkSync(entry.doneSentinelPath); } catch {}
        entries.delete(id);
        removed++;
      }
    }
    return removed;
  }

  return { register, get, markComplete, gcExpired };
```

- [ ] **Step 4: Run test, confirm it passes**

Run: `npx vitest run test/live-output.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/live-output.js test/live-output.test.js
git commit -m "feat(live-output): gcExpired sweeps expired entries + files"
```

### Task 3.4: Startup sweep for orphaned files

**Files:**
- Modify: `lib/live-output.js`
- Modify: `test/live-output.test.js`

- [ ] **Step 1: Write failing test**

```js
import { sweepOrphanedLogs } from '../lib/live-output.js';

  it('sweepOrphanedLogs deletes pre-existing log files older than ttl', () => {
    const tmp = mkdtempSync(path.join(tmpdir(), 'live-'));
    const oldLog = path.join(tmp, 'matron-cmd-old.log');
    const oldDone = path.join(tmp, 'matron-cmd-old.log.done');
    const newLog = path.join(tmp, 'matron-cmd-new.log');
    writeFileSync(oldLog, 'old');
    writeFileSync(oldDone, '{}');
    writeFileSync(newLog, 'new');

    const fiveHoursAgo = (Date.now() - 5 * 60 * 60 * 1000) / 1000;
    utimesSync(oldLog, fiveHoursAgo, fiveHoursAgo);
    utimesSync(oldDone, fiveHoursAgo, fiveHoursAgo);

    const removed = sweepOrphanedLogs(tmp, 14400);
    expect(removed).toBe(2);
    expect(existsSync(oldLog)).toBe(false);
    expect(existsSync(oldDone)).toBe(false);
    expect(existsSync(newLog)).toBe(true);
    rmSync(tmp, { recursive: true });
  });
```

- [ ] **Step 2: Run test, confirm it fails**

Run: `npx vitest run test/live-output.test.js`
Expected: FAIL — `sweepOrphanedLogs` not exported.

- [ ] **Step 3: Implement sweepOrphanedLogs**

Add to `lib/live-output.js`:

```js
import { readdirSync, statSync } from 'fs';

export function sweepOrphanedLogs(dir, ttlSeconds) {
  const cutoff = Date.now() - ttlSeconds * 1000;
  let removed = 0;
  let entries;
  try { entries = readdirSync(dir); } catch { return 0; }
  for (const name of entries) {
    if (!name.startsWith('matron-cmd-')) continue;
    const full = `${dir}/${name}`;
    try {
      const st = statSync(full);
      if (st.mtimeMs < cutoff) {
        unlinkSync(full);
        removed++;
      }
    } catch {}
  }
  return removed;
}
```

- [ ] **Step 4: Run test, confirm it passes**

Run: `npx vitest run test/live-output.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/live-output.js test/live-output.test.js
git commit -m "feat(live-output): sweepOrphanedLogs for startup cleanup"
```

---

## Phase 4 — Bridge integration

> **Dependency note:** Task 4.3 imports `generateSignedUrl` from `viewer/server.js` and uses an extended signature added in Task 5.1, and importing from `viewer/server.js` triggers `app.listen()` at module load. **Execute Task 5.1 and Task 5.2 (the refactor that exposes `startServer`) before Task 4.3.** The order Task 4.1 → Task 4.2 → Task 5.1 → Task 5.2 → Task 4.3 → Task 4.4 produces a clean dependency chain.

### Task 4.1: Register hook in `--settings`

**Files:**
- Modify: `index.js:180-209`

- [ ] **Step 1: Read the existing `--settings` block**

Open `index.js` lines 170-209. Note the existing inline `--settings` JSON registers a `PreCompact` hook for `compact-notify.sh`.

- [ ] **Step 2: Extend the hooks object**

Modify the inline JSON to also include `PreToolUse` for Bash:

```js
'--settings', JSON.stringify({
  hooks: {
    PreCompact: [/* existing entry unchanged */],
    PreToolUse: [{
      matcher: 'Bash',
      hooks: [{
        type: 'command',
        command: path.join(__dirname, 'hooks', 'matron-bash-tee.sh'),
      }],
    }],
  },
}),
```

(Leave the existing PreCompact entry exactly as-is.)

- [ ] **Step 3: Set MATRON_BASH_TEE_ENABLED in spawn env when room has showBashOutput**

Find the `env: {...}` block where Claude is spawned (`index.js` around line 200). Add:

```js
env: {
  ...process.env,
  CLAUDECODE: '',
  CLAUDE_CODE_MAX_OUTPUT_TOKENS: '128000',
  BRIDGE_ROOM_ID: session.roomId,
  MATRON_BRIDGE_API_PORT: String(API_PORT),
  MATRON_BASH_TEE_ENABLED: session.showBashOutput ? '1' : '0',
},
```

(Where `session.showBashOutput` reads from the same per-room settings store as the existing `session.showWorking`.)

- [ ] **Step 4: Test manually**

Start the bridge with a room that has `showBashOutput=true`, ask Claude to run `ls`, and check `/tmp/matron-cmd-*.log` is created. (No automated test for this step — pure wiring.)

- [ ] **Step 5: Commit**

```bash
git add index.js
git commit -m "feat(bridge): register matron-bash-tee.sh PreToolUse hook"
```

### Task 4.2: Add `showBashOutput` per-room setting

**Files:**
- Modify: `index.js` (wherever per-room settings are read/persisted)

- [ ] **Step 1: Locate the existing `showWorking` setting**

```bash
grep -n "showWorking" index.js
```

Note where it's defined, persisted, defaulted, and toggled (e.g., a `!setflag` command handler or similar).

- [ ] **Step 2: Add `showBashOutput` everywhere `showWorking` lives**

Mirror every `showWorking` usage with a parallel `showBashOutput`:
- Default: `true` (rooms with no persisted preference get live output)
- Persistence: same store
- Toggle command: same surface (e.g., `!setflag showBashOutput true`)

After the in-memory mutation, persist the new value via:

```js
persistSession(session.roomId, session.claudeSessionId, session.workdir, session.originRoomId, { showBashOutput: session.showBashOutput })
```

The toggle requires `!restart` to apply because `MATRON_BASH_TEE_ENABLED` is fixed in the spawn env (read once from `getPersistedSession(roomId)?.showBashOutput` inside `createSession`). Reply to the user with messaging that makes the restart requirement clear, e.g. `showBashOutput: ON — run !restart to apply`.

- [ ] **Step 3: Manually verify**

Start the bridge, toggle `showBashOutput` on for a test room, restart, confirm the setting persisted and the spawned hook env is `MATRON_BASH_TEE_ENABLED=1`.

- [ ] **Step 4: Commit**

```bash
git add index.js
git commit -m "feat(bridge): per-room showBashOutput setting"
```

### Task 4.3: Detect tee marker in tool_use, register entry, post Matrix event

**Files:**
- Modify: `index.js:606-680` (Bash tool_use handler)
- Modify: `index.js` (top imports)

- [ ] **Step 1: Import the live-output store and create a singleton**

At top of `index.js`:

```js
import { createLiveOutputStore, sweepOrphanedLogs } from './lib/live-output.js';
import { generateSignedUrl } from './viewer/server.js';
```

Below the imports, near other singletons:

```js
const LIVE_OUTPUT_TTL = parseInt(process.env.MATRON_LIVE_OUTPUT_TTL || '14400', 10);
const liveOutputStore = createLiveOutputStore({ ttlSeconds: LIVE_OUTPUT_TTL });
sweepOrphanedLogs('/tmp', LIVE_OUTPUT_TTL); // startup sweep
setInterval(() => liveOutputStore.gcExpired(), 60_000); // periodic GC
```

- [ ] **Step 2: Extend Bash tool_use handler to detect marker**

In `index.js` around line 606 (the `if (toolName === 'Bash' && input.command)` branch):

```js
if (toolName === 'Bash' && input.command) {
  // Detect matron-tee rewrite and extract original command.
  const teeMatch = input.command.match(/^.*\/matron-tee (\/tmp\/matron-cmd-([^.]+)\.log) -- bash -c '(.+)'$/s);
  let displayCommand = input.command;
  let liveLogPath = null;
  let liveToolUseId = null;
  if (teeMatch) {
    liveLogPath = teeMatch[1];
    liveToolUseId = teeMatch[2];
    // Unescape jq @sh quoting: '\''  ->  '
    displayCommand = teeMatch[3].replace(/'\\''/g, "'");
  }

  const cmd = displayCommand.length > 100
    ? displayCommand.slice(0, 100) + '…'
    : displayCommand;
  indicator = `🔧 \`${cmd}\``;
  indicatorHtml = `🔧 <code>${escapeHtml(cmd)}</code>`;
  isKeyEvent = true;

  if (liveToolUseId && session.showBashOutput) {
    liveOutputStore.register(liveToolUseId, {
      logPath: liveLogPath,
      roomId: session.roomId,
    });
    const expiresAt = Math.floor(Date.now() / 1000) + LIVE_OUTPUT_TTL;
    const viewerBase = process.env.MATRIX_VIEWER_BASE_URL;
    const viewerUrl = generateSignedUrl(
      viewerBase,
      null,
      undefined,
      LIVE_OUTPUT_TTL,
      { liveCmdId: liveToolUseId, logPath: liveLogPath, doneSentinelPath: `${liveLogPath}.done` }
    ).replace('/view', '/live');
    sendLiveOutputEvent(session, {
      tool_use_id: liveToolUseId,
      command: displayCommand,
      viewer_url: viewerUrl,
      expires_at: expiresAt,
    });
  }
}
```

(`generateSignedUrl` will support the live-output payload shape after Task 5.1 — note the dependency order.)

- [ ] **Step 3: Implement `sendLiveOutputEvent`**

Add a helper near the other Matrix-send functions in `index.js`:

```js
function sendLiveOutputEvent(session, { tool_use_id, command, viewer_url, expires_at }) {
  const body = `$ ${command}\n[live output: ${viewer_url}]`;
  const formatted_body = `<a href="${escapeHtml(viewer_url)}"><code>$ ${escapeHtml(command)}</code> · view live output</a>`;
  session.matrixClient.sendEvent(session.roomId, 'com.matron.live_output.v1', {
    msgtype: 'm.text',
    body,
    format: 'org.matrix.custom.html',
    formatted_body,
    'com.matron.live_output': { tool_use_id, command, viewer_url, expires_at },
  });
}
```

(Match the actual sendEvent signature used elsewhere in `index.js`.)

- [ ] **Step 4: Sanity check**

```bash
node --check index.js
```

- [ ] **Step 5: Commit**

```bash
git add index.js
git commit -m "feat(bridge): detect matron-tee marker, post live_output event"
```

### Task 4.4: Mark complete on tool_result

**Files:**
- Modify: `index.js:824-834` (user event handler)

- [ ] **Step 1: Locate the `user` event handler**

```bash
grep -n "case 'user'" index.js
```

- [ ] **Step 2: Extend it to call markComplete**

```js
case 'user': {
  const content = event.message?.content;
  if (Array.isArray(content)) {
    for (const block of content) {
      if (block.type === 'tool_result' && block.tool_use_id) {
        const entry = liveOutputStore.get(block.tool_use_id);
        if (entry) {
          const denied = !!(typeof block.content === 'string' && /permission/i.test(block.content));
          const truncated = typeof block.content === 'string' && block.content.includes('[matron-tee: output truncated');
          const ecMatch = typeof block.content === 'string' && block.content.match(/exit code[: ]+(\d+)/i);
          const exitCode = ecMatch ? parseInt(ecMatch[1], 10) : (block.is_error ? 1 : 0);
          liveOutputStore.markComplete(block.tool_use_id, { exitCode, denied, truncated });
        }
      }
    }
  }
  break;
}
```

(Preserve any existing logic in the `user` case — error logging, etc.)

- [ ] **Step 3: Sanity check**

```bash
node --check index.js
```

- [ ] **Step 4: Commit**

```bash
git add index.js
git commit -m "feat(bridge): mark live_output complete on tool_result"
```

---

## Phase 5 — Viewer `/live` HTML endpoint

### Task 5.1: Extend signed-token payload shape

**Files:**
- Modify: `viewer/server.js:21-26` (generateSignedUrl)
- Modify: `viewer/server.js:28-45` (verifyToken — already exists; just export it)
- Test: `test/viewer-token.test.js`

- [ ] **Step 1: Write failing test for live-output token**

```js
// test/viewer-token.test.js
import { describe, it, expect, beforeEach } from 'vitest';

beforeEach(() => { process.env.HMAC_SECRET = 'test-secret'; });

describe('viewer token', () => {
  it('round-trips a live-output payload', async () => {
    const { generateSignedUrl, verifyToken } = await import('../viewer/server.js');
    const url = generateSignedUrl('http://x', null, undefined, 60, {
      liveCmdId: 'toolu_1',
      logPath: '/tmp/a.log',
      doneSentinelPath: '/tmp/a.log.done',
    });
    const token = url.split('token=')[1];
    const payload = verifyToken(token);
    expect(payload.liveCmdId).toBe('toolu_1');
    expect(payload.logPath).toBe('/tmp/a.log');
    expect(payload.doneSentinelPath).toBe('/tmp/a.log.done');
    expect(payload.path).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test, confirm it fails**

Run: `npx vitest run test/viewer-token.test.js`
Expected: FAIL — generateSignedUrl signature doesn't accept extra fields, or verifyToken not exported.

- [ ] **Step 3: Extend generateSignedUrl and export verifyToken**

Modify `viewer/server.js`:

```js
export function generateSignedUrl(baseUrl, filePath, secret = SECRET, expiry = TOKEN_EXPIRY_SECONDS, extra = null) {
  const exp = Math.floor(Date.now() / 1000) + expiry;
  const payloadObj = extra ? { ...extra, exp } : { path: filePath, exp };
  const payload = Buffer.from(JSON.stringify(payloadObj)).toString('base64url');
  const sig = crypto.createHmac('sha256', secret).update(payload).digest('base64url');
  return `${baseUrl}/view?token=${payload}.${sig}`;
}

export function verifyToken(token) { /* existing body */ }
```

- [ ] **Step 4: Run test, confirm it passes**

Run: `npx vitest run test/viewer-token.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add viewer/server.js test/viewer-token.test.js
git commit -m "feat(viewer): extend signed-url payload for live-output tokens"
```

### Task 5.2: Refactor `viewer/server.js` for testability

`server.js` currently calls `app.listen` at module load. We need to import the Express app from tests without binding to a port.

**Files:**
- Modify: `viewer/server.js`
- Create: `viewer/start.js`
- Modify: `package.json` scripts

- [ ] **Step 1: Move listen into a separate entrypoint**

In `viewer/server.js`, replace the bottom `app.listen(...)` call with:

```js
export { app };
export function startServer(port = PORT) {
  return app.listen(port, '127.0.0.1', () => {
    console.log(`Code file viewer listening on 127.0.0.1:${port}`);
  });
}
```

Create `viewer/start.js`:

```js
import { startServer } from './server.js';
startServer();
```

- [ ] **Step 2: Update any service launchers / scripts**

```bash
grep -rn "viewer/server.js" --include="*.sh" --include="*.json" .
```

Replace references with `viewer/start.js` where they're meant to invoke a process.

- [ ] **Step 3: Manually run**

```bash
node viewer/start.js &
curl http://127.0.0.1:9803/health
kill %1
```

Expected: `ok`.

- [ ] **Step 4: Commit**

```bash
git add viewer/server.js viewer/start.js package.json start-bridge.sh
git commit -m "refactor(viewer): split start from app for testability"
```

### Task 5.3: `/live` HTML endpoint

**Files:**
- Modify: `viewer/server.js`
- Test: `test/viewer-live.test.js`

- [ ] **Step 1: Write failing integration test**

```js
// test/viewer-live.test.js
import { describe, it, expect, beforeAll, afterAll } from 'vitest';

let server, port;
beforeAll(async () => {
  process.env.HMAC_SECRET = 'test-secret';
  const { startServer } = await import('../viewer/server.js');
  server = startServer(0); // 0 = ephemeral port
  await new Promise(r => server.on('listening', r));
  port = server.address().port;
});
afterAll(() => server?.close());

describe('GET /live', () => {
  it('rejects missing token', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/live`);
    expect(res.status).toBe(400);
  });

  it('rejects expired token', async () => {
    const { generateSignedUrl } = await import('../viewer/server.js');
    const url = generateSignedUrl(`http://127.0.0.1:${port}`, null, undefined, -10, {
      liveCmdId: 'x', logPath: '/tmp/x.log', doneSentinelPath: '/tmp/x.log.done',
    }).replace('/view', '/live');
    const res = await fetch(url);
    expect(res.status).toBe(403);
  });

  it('serves HTML for valid live token', async () => {
    const { generateSignedUrl } = await import('../viewer/server.js');
    const url = generateSignedUrl(`http://127.0.0.1:${port}`, null, undefined, 60, {
      liveCmdId: 'x', logPath: '/tmp/x.log', doneSentinelPath: '/tmp/x.log.done',
    }).replace('/view', '/live');
    const res = await fetch(url);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/html/);
    const body = await res.text();
    expect(body).toContain('<pre');
    expect(body).toContain('/live/ws');
  });
});
```

- [ ] **Step 2: Run test, confirm it fails**

Run: `npx vitest run test/viewer-live.test.js`
Expected: FAIL — `/live` route doesn't exist.

- [ ] **Step 3: Add the `/live` route**

In `viewer/server.js` after the `/view` route:

```js
function renderLiveHtml(token) {
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>
  body { margin: 0; background: #0d1117; color: #e6edf3; font-family: -apple-system, BlinkMacSystemFont, sans-serif; height: 100vh; display: flex; flex-direction: column; }
  pre { margin: 0; padding: 12px; flex: 1; overflow-y: auto; font-family: 'SF Mono', 'Fira Code', monospace; font-size: 12px; line-height: 1.4; white-space: pre-wrap; word-break: break-all; }
  .status { padding: 4px 12px; background: #161b22; border-bottom: 1px solid #30363d; font-size: 11px; color: #8b949e; }
</style>
</head>
<body>
<div class="status" id="status">running…</div>
<pre id="output"></pre>
<script>
(() => {
  const out = document.getElementById('output');
  const status = document.getElementById('status');
  let userScrolled = false;
  out.addEventListener('scroll', () => {
    userScrolled = (out.scrollTop + out.clientHeight) < (out.scrollHeight - 20);
  });
  const wsUrl = location.origin.replace(/^http/, 'ws') + '/live/ws?token=${token}';
  const ws = new WebSocket(wsUrl);
  ws.onmessage = (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    if (msg.type === 'data') {
      out.textContent += msg.chunk;
      if (!userScrolled) out.scrollTop = out.scrollHeight;
    } else if (msg.type === 'complete') {
      const code = msg.exitCode;
      const denied = msg.denied;
      const trunc = msg.truncated;
      status.textContent = denied ? '✗ not executed' :
        (code === 0 ? '✓ exit 0' : '✗ exit ' + code) +
        (trunc ? ' · truncated' : '');
    }
  };
  ws.onerror = () => { status.textContent = '⚠ disconnected'; };
})();
</script>
</body>
</html>`;
}

app.get('/live', (req, res) => {
  const { token } = req.query;
  if (!token) return res.status(400).send('Missing token');
  const data = verifyToken(token);
  if (!data) return res.status(403).send('Invalid or expired token');
  if (!data.liveCmdId) return res.status(400).send('Invalid live token');
  res.type('html').send(renderLiveHtml(token));
});
```

- [ ] **Step 4: Run test, confirm it passes**

Run: `npx vitest run test/viewer-live.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add viewer/server.js test/viewer-live.test.js
git commit -m "feat(viewer): /live HTML endpoint serves WS-streaming page"
```

---

## Phase 6 — Viewer `/live/ws` WebSocket endpoint

### Task 6.1: Add `ws` dependency and WS server skeleton

**Files:**
- Modify: `package.json`
- Modify: `viewer/server.js`

- [ ] **Step 1: Install `ws`**

```bash
npm install ws
```

- [ ] **Step 2: Wire WS upgrade onto the Express server**

In `viewer/server.js`, modify `startServer`:

```js
import { WebSocketServer } from 'ws';

export function startServer(port = PORT) {
  const httpServer = app.listen(port, '127.0.0.1', () => {
    console.log(`Code file viewer listening on 127.0.0.1:${httpServer.address().port}`);
  });
  const wss = new WebSocketServer({ noServer: true });
  httpServer.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (url.pathname !== '/live/ws') {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => handleLiveWs(ws, url));
  });
  return httpServer;
}

function handleLiveWs(ws, url) {
  const token = url.searchParams.get('token');
  const data = token ? verifyToken(token) : null;
  if (!data || !data.liveCmdId || !data.logPath) {
    ws.close(1008, 'invalid token');
    return;
  }
  // streaming logic in next task
  ws.close(1000, 'not implemented');
}
```

- [ ] **Step 3: Sanity check**

```bash
node --check viewer/server.js
```

- [ ] **Step 4: Commit**

```bash
git add package.json package-lock.json viewer/server.js
git commit -m "feat(viewer): WebSocket server skeleton for /live/ws"
```

### Task 6.2: Stream log file content

**Files:**
- Modify: `viewer/server.js`
- Test: `test/viewer-live-ws.test.js`

- [ ] **Step 1: Write failing test**

```js
// test/viewer-live-ws.test.js
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, appendFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import WebSocket from 'ws';

let server, port;
beforeAll(async () => {
  process.env.HMAC_SECRET = 'test-secret';
  const { startServer } = await import('../viewer/server.js');
  server = startServer(0);
  await new Promise(r => server.on('listening', r));
  port = server.address().port;
});
afterAll(() => server?.close());

describe('GET /live/ws', () => {
  it('streams log content and closes on .done sentinel', async () => {
    const tmp = mkdtempSync(path.join(tmpdir(), 'ws-'));
    const logPath = path.join(tmp, 'cmd.log');
    writeFileSync(logPath, 'line1\nline2\n');

    const { generateSignedUrl } = await import('../viewer/server.js');
    const url = generateSignedUrl(`ws://127.0.0.1:${port}`, null, undefined, 60, {
      liveCmdId: 'test1', logPath, doneSentinelPath: `${logPath}.done`,
    }).replace('/view?', '/live/ws?');

    const messages = [];
    await new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      ws.on('message', m => messages.push(JSON.parse(m.toString())));
      ws.on('open', () => {
        setTimeout(() => {
          appendFileSync(logPath, 'line3\n');
          setTimeout(() => {
            writeFileSync(`${logPath}.done`, JSON.stringify({ exitCode: 0, denied: false, truncated: false }));
          }, 50);
        }, 50);
      });
      ws.on('close', resolve);
      ws.on('error', reject);
    });

    const concat = messages.filter(m => m.type === 'data').map(m => m.chunk).join('');
    expect(concat).toContain('line1');
    expect(concat).toContain('line2');
    expect(concat).toContain('line3');
    const complete = messages.find(m => m.type === 'complete');
    expect(complete).toEqual({ type: 'complete', exitCode: 0, denied: false, truncated: false });

    rmSync(tmp, { recursive: true });
  });
});
```

- [ ] **Step 2: Run test, confirm it fails**

Run: `npx vitest run test/viewer-live-ws.test.js`
Expected: FAIL — handler closes immediately with "not implemented".

- [ ] **Step 3: Implement `handleLiveWs`**

Replace the stub:

```js
import { watch as fsWatch, existsSync, readFileSync, statSync, openSync, readSync, closeSync } from 'fs';

function handleLiveWs(ws, url) {
  const token = url.searchParams.get('token');
  const data = token ? verifyToken(token) : null;
  if (!data || !data.liveCmdId || !data.logPath) {
    ws.close(1008, 'invalid token');
    return;
  }
  const { logPath, doneSentinelPath } = data;

  let offset = 0;
  let watcher = null;
  let doneWatcher = null;
  let closed = false;

  function send(msg) {
    if (closed) return;
    try { ws.send(JSON.stringify(msg)); } catch {}
  }

  // Synchronous read: advancing `offset` to `st.size` happens BEFORE control
  // returns, so concurrent pump() invocations can't re-read the same bytes,
  // and any final flush from checkDone() completes before `complete` is sent.
  function pump() {
    if (closed || !existsSync(logPath)) return;
    let st;
    try { st = statSync(logPath); } catch { return; }
    if (st.size <= offset) return;
    let data;
    try {
      const fd = openSync(logPath, 'r');
      try {
        const buf = Buffer.alloc(st.size - offset);
        readSync(fd, buf, 0, buf.length, offset);
        data = buf;
      } finally {
        closeSync(fd);
      }
    } catch {
      return;
    }
    offset = st.size;
    send({ type: 'data', chunk: data.toString('utf-8') });
  }

  function checkDone() {
    if (!existsSync(doneSentinelPath)) return;
    pump(); // final flush — synchronous, so any pending bytes are sent before complete
    let payload;
    try { payload = JSON.parse(readFileSync(doneSentinelPath, 'utf-8')); }
    catch { payload = { exitCode: null, denied: false, truncated: false }; }
    send({ type: 'complete', ...payload });
    closeAll();
  }

  function closeAll() {
    if (closed) return;
    closed = true;
    try { watcher?.close(); } catch {}
    try { doneWatcher?.close(); } catch {}
    try { ws.close(1000, 'done'); } catch {}
  }

  pump();
  checkDone();

  if (existsSync(logPath)) {
    watcher = fsWatch(logPath, { persistent: false }, () => pump());
  }
  const parentDir = path.dirname(logPath);
  const doneBasename = path.basename(doneSentinelPath);
  doneWatcher = fsWatch(parentDir, { persistent: false }, (event, filename) => {
    if (filename === doneBasename) checkDone();
  });

  ws.on('close', closeAll);
  ws.on('error', closeAll);
}
```

- [ ] **Step 4: Run test, confirm it passes**

Run: `npx vitest run test/viewer-live-ws.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add viewer/server.js test/viewer-live-ws.test.js
git commit -m "feat(viewer): /live/ws streams log + closes on done sentinel"
```

---

## Phase 7 — Matron-web custom renderer

**Working directory:** `/home/danbarker/matronhq/matron-web` (separate repo). All paths in this phase are relative to that repo.

### Task 7.1: Create the module package skeleton

**Files (in matron-web):**
- Create: `packages/matron-live-output/package.json`
- Create: `packages/matron-live-output/src/index.tsx`
- Create: `packages/matron-live-output/src/LiveOutputTile.tsx`
- Create: `packages/matron-live-output/tsconfig.json`

- [ ] **Step 1: Verify upstream Element module-system contract**

```bash
cd ~/matronhq/matron-web
cat src/modules/customComponentApi.ts | head -80
ls module_system/
```

Read enough to confirm `registerMessageRenderer(eventType, component)` is the right API and what bundle hook loads modules.

- [ ] **Step 2: Create package.json**

```json
{
  "name": "@matron/live-output",
  "version": "0.1.0",
  "main": "src/index.tsx",
  "private": true
}
```

- [ ] **Step 3: Create tsconfig.json**

Copy from `packages/shared-components/tsconfig.json` (existing package); adjust paths.

- [ ] **Step 4: Commit**

```bash
git add packages/matron-live-output/
git commit -m "feat(live-output): package skeleton"
```

### Task 7.2: Implement `LiveOutputTile` component

**Files (in matron-web):**
- Modify: `packages/matron-live-output/src/LiveOutputTile.tsx`

- [ ] **Step 1: Implement the component**

```tsx
// packages/matron-live-output/src/LiveOutputTile.tsx
import React, { useEffect, useState } from 'react';
import type { MatrixEvent } from 'matrix-js-sdk';

interface LiveOutputContent {
  tool_use_id: string;
  command: string;
  viewer_url: string;
  expires_at: number;
}

interface Props {
  mxEvent: MatrixEvent;
}

export function LiveOutputTile({ mxEvent }: Props): JSX.Element {
  const content = mxEvent.getContent()['com.matron.live_output'] as LiveOutputContent | undefined;
  const [expanded, setExpanded] = useState(false);
  const [expired, setExpired] = useState(false);

  useEffect(() => {
    if (!content) return;
    const remaining = content.expires_at * 1000 - Date.now();
    if (remaining <= 0) { setExpired(true); return; }
    const t = setTimeout(() => setExpired(true), remaining);
    return () => clearTimeout(t);
  }, [content?.expires_at]);

  if (!content) return <div className="mx_LiveOutput--invalid">Live output (invalid event)</div>;

  return (
    <div className="mx_LiveOutput">
      <div className="mx_LiveOutput_header">
        <code className="mx_LiveOutput_command">$ {content.command}</code>
        <button
          className="mx_LiveOutput_toggle"
          onClick={() => setExpanded(e => !e)}
          aria-label={expanded ? 'Collapse' : 'Expand'}
        >
          {expanded ? '▾' : '▸'}
        </button>
      </div>
      {expired ? (
        <div className="mx_LiveOutput_expired">Output expired</div>
      ) : (
        <iframe
          className="mx_LiveOutput_iframe"
          src={content.viewer_url}
          sandbox="allow-scripts"
          style={{ height: expanded ? 600 : 240, width: '100%', border: 'none', background: '#0d1117' }}
          title={`Live output for ${content.command}`}
        />
      )}
    </div>
  );
}
```

- [ ] **Step 2: Sanity check (TypeScript)**

```bash
cd ~/matronhq/matron-web
pnpm tsc --noEmit -p packages/matron-live-output
```

- [ ] **Step 3: Commit**

```bash
git add packages/matron-live-output/src/LiveOutputTile.tsx
git commit -m "feat(live-output): LiveOutputTile component with expand/collapse"
```

### Task 7.3: Module entrypoint registers the renderer

**Files (in matron-web):**
- Modify: `packages/matron-live-output/src/index.tsx`

- [ ] **Step 1: Implement the entrypoint**

```tsx
// packages/matron-live-output/src/index.tsx
import { ModuleApi } from '@matrix-org/react-sdk-module-api/lib/ModuleApi';
import { LiveOutputTile } from './LiveOutputTile';

export default function register(api: ModuleApi): void {
  api.customComponents.registerMessageRenderer(
    'com.matron.live_output.v1',
    (event) => <LiveOutputTile mxEvent={event} />
  );
}
```

(Adjust the `registerMessageRenderer` signature to match the actual API in `src/modules/customComponentApi.ts:69-75` — confirm whether it expects `(event) => ReactNode` or a component class.)

- [ ] **Step 2: Wire the module into the build**

In matron-web's existing module bundle config (`module_system/...`), add the new package to the list of registered modules. (Pattern is established by existing modules; mirror it.)

- [ ] **Step 3: Build & dev-run**

```bash
cd ~/matronhq/matron-web
pnpm build
```

- [ ] **Step 4: Commit**

```bash
git add packages/matron-live-output/src/index.tsx
git commit -m "feat(live-output): register custom renderer for com.matron.live_output.v1"
```

### Task 7.4: Add minimal CSS

**Files (in matron-web):**
- Create: `packages/matron-live-output/src/LiveOutputTile.css`

- [ ] **Step 1: Write styles**

```css
.mx_LiveOutput {
  border: 1px solid var(--cpd-color-border-interactive-secondary, #30363d);
  border-radius: 8px;
  margin: 4px 0;
  overflow: hidden;
}
.mx_LiveOutput_header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 6px 10px;
  background: var(--cpd-color-bg-subtle-secondary, #161b22);
  font-size: 12px;
}
.mx_LiveOutput_command {
  font-family: 'SF Mono', 'Fira Code', monospace;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.mx_LiveOutput_toggle {
  background: none;
  border: none;
  color: inherit;
  cursor: pointer;
  font-size: 14px;
  padding: 0 4px;
}
.mx_LiveOutput_iframe { display: block; }
.mx_LiveOutput_expired {
  padding: 16px;
  text-align: center;
  color: var(--cpd-color-text-secondary, #8b949e);
  font-style: italic;
}
.mx_LiveOutput--invalid {
  padding: 12px;
  color: var(--cpd-color-text-critical-primary, #f85149);
}
```

- [ ] **Step 2: Import the CSS in LiveOutputTile.tsx**

```tsx
import './LiveOutputTile.css';
```

- [ ] **Step 3: Commit**

```bash
git add packages/matron-live-output/src/LiveOutputTile.css packages/matron-live-output/src/LiveOutputTile.tsx
git commit -m "feat(live-output): styles"
```

---

## Phase 8 — End-to-end manual validation

### Task 8.1: Run the full manual checklist

**Setup:**
- claude-matrix-bridge built from this branch and running (`sudo systemctl restart claude-matrix-bridge.service`)
- matron-web built with the new module and running locally
- A test Matrix room with `showBashOutput=true`

- [ ] **Step 1: Fast command** — Ask Claude to run `ls -la`. Tile appears, completes within ~1s, badge shows ✓ exit 0, output is visible inside the iframe.

- [ ] **Step 2: Long command** — `sleep 5; echo done`. Tile appears immediately, "running…" badge stays for 5s, then "done" appears, badge flips to ✓ exit 0.

- [ ] **Step 3: Big output** — `seq 1 100000`. Tile is scrollable inside the iframe. Chat layout is not broken. Expand toggle grows the iframe.

- [ ] **Step 4: Failing command** — `false`. Badge shows ✗ exit 1.

- [ ] **Step 5: Cap test** — `yes | head -c 60M`. Tile shows truncation marker; badge shows `· truncated`.

- [ ] **Step 6: Permission-denied** — Configure Claude to require permission for some Bash command in a way that triggers a denial. Tile shows ✗ not executed.

- [ ] **Step 7: Expiry** — Set `MATRON_LIVE_OUTPUT_TTL=60` for the test, run a command, wait 70 s, refresh the room. Tile shows "Output expired"; `/tmp/matron-cmd-*.log` is gone (verify with `ls /tmp/matron-cmd-*.log`).

- [ ] **Step 8: Toggle off** — Set `showBashOutput=false`. Run `ls`. Indicator line `🔧 \`ls\`` posts; no live-output tile. `/tmp/matron-cmd-*.log` is NOT created (verify).

- [ ] **Step 9: Federated client** — Open the same room in regular Element (not Matron). Confirm the live-output messages appear as plain links to the viewer URL.

- [ ] **Step 10: Subagent Bash** — Ask Claude to dispatch a Task subagent that runs Bash. Confirm a tile appears for the subagent's Bash too.

- [ ] **Step 11: Open PR**

```bash
cd ~/claude-matrix-bridge
git push -u origin feat/live-bash-output-design
gh pr create --title "feat: live bash output tiles" --body "$(cat <<'EOF'
## Summary
- New PreToolUse hook + matron-tee wrapper captures Bash output to a per-command log
- Bridge posts a `com.matron.live_output.v1` Matrix event for each Bash call (when per-room `showBashOutput` is on)
- Viewer streams the log over WebSocket
- Logs auto-delete after `MATRON_LIVE_OUTPUT_TTL` (default 4h) — never persisted in chat history
- Companion matron-web module renders a sandboxed iframe inline

Spec: docs/plans/2026-05-02-live-bash-output-tile-design.md

## Test plan
- [x] Fast command
- [x] Long command (live tail visible)
- [x] Big output (scrollable, doesn't break chat)
- [x] Failing command (exit 1)
- [x] Output cap (truncation marker)
- [x] Permission denial (not executed)
- [x] Expiry (tile shows "Output expired", /tmp clean)
- [x] Toggle off (no tile, no log file)
- [x] Federated non-Matron client (plain link fallback)

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

## Self-review notes

**Spec coverage check** (against `2026-05-02-live-bash-output-tile-design.md`):

- ✅ Bash tool only, extensible: design's event format is renderer-agnostic; only Bash is wired in v1.
- ✅ Element Web/Desktop only: matron-web changes covered; Element X explicitly out of scope.
- ✅ Hard expiry, no persistence: Phase 3 GC + Task 8.1 step 7 verifies.
- ✅ Always live (hook + tee): Phases 1-2 + Phase 4 wiring.
- ✅ Per-room `showBashOutput`: Task 4.2.
- ✅ 4-hour default TTL: `MATRON_LIVE_OUTPUT_TTL=14400` in Task 4.3.
- ✅ Iframe sandboxed: Task 7.2 uses `sandbox="allow-scripts"`.
- ✅ Indicator line preserved: Task 4.3 shows both indicator + tile.
- ✅ Fallback body for non-Matron clients: Task 4.3 sendLiveOutputEvent.
- ✅ Restart recovery: `sweepOrphanedLogs` in Task 3.4 + invocation in Task 4.3.
- ✅ Test coverage: Phases 1-6 are TDD; Phase 7 is manual smoke (per spec).
- ✅ Phase 0 explicitly validates the riskiest assumption first.
