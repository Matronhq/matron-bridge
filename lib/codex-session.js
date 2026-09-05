import { EventEmitter } from 'node:events';
import { spawn as nodeSpawn } from 'node:child_process';

const SANDBOX_MODES = new Set(['read-only', 'workspace-write', 'danger-full-access']);

export function normalizeCodexSandbox(value) {
  const normalized = String(value ?? '').trim().toLowerCase();
  return SANDBOX_MODES.has(normalized) ? normalized : 'workspace-write';
}

export function contentBlocksToCodexPrompt(contentBlocks = []) {
  return contentBlocks
    .filter(block => block?.type === 'text' && typeof block.text === 'string')
    .map(block => block.text)
    .filter(Boolean)
    .join('\n\n');
}

// Build argv without putting the user prompt on the command line. The prompt
// is written to stdin using "-", which avoids shell quoting, process-list
// exposure, and argv length limits for queued/merged messages.
export function buildCodexExecArgs({
  threadId = null,
  model = null,
  sandbox = 'workspace-write',
  developerInstructions = '',
} = {}) {
  const args = ['exec'];
  if (threadId) args.push('resume');
  args.push('--json', '--skip-git-repo-check');
  args.push('-c', 'approval_policy="never"');
  args.push('-c', `sandbox_mode=${JSON.stringify(normalizeCodexSandbox(sandbox))}`);
  if (developerInstructions) {
    args.push('-c', `developer_instructions=${JSON.stringify(developerInstructions)}`);
  }
  if (model) args.push('--model', model);
  if (threadId) args.push(threadId);
  args.push('-');
  return args;
}

// A logical Codex session is long-lived, but codex exec itself is one process
// per turn. This adapter owns those child processes and emits their JSONL
// events while retaining the thread ID needed by the next turn.
export class CodexExecSession extends EventEmitter {
  constructor({
    cwd,
    threadId = null,
    model = null,
    sandbox = 'workspace-write',
    developerInstructions = '',
    env = process.env,
    spawnImpl = nodeSpawn,
    command = 'codex',
  } = {}) {
    super();
    this.cwd = cwd;
    this.threadId = threadId;
    this.model = model;
    this.sandbox = normalizeCodexSandbox(sandbox);
    this.developerInstructions = developerInstructions;
    this.env = env;
    this.spawnImpl = spawnImpl;
    this.command = command;
    this.child = null;
    this.alive = true;
    this.busy = false;
    this.lastError = null;
  }

  send(contentBlocks) {
    if (!this.alive || this.busy) return false;
    const prompt = contentBlocksToCodexPrompt(contentBlocks);
    if (!prompt) return false;
    this.lastError = null;

    const args = buildCodexExecArgs({
      threadId: this.threadId,
      model: this.model,
      sandbox: this.sandbox,
      developerInstructions: this.developerInstructions,
    });

    let child;
    try {
      child = this.spawnImpl(this.command, args, {
        cwd: this.cwd,
        env: this.env,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (error) {
      this.lastError = error;
      queueMicrotask(() => this.emit('spawn-error', error));
      return false;
    }

    this.child = child;
    this.busy = true;
    this.emit('spawn', { child, args });

    let stdoutBuffer = '';
    let stderr = '';
    let sawTurnCompleted = false;

    child.stdout.on('data', chunk => {
      stdoutBuffer += chunk.toString();
      const lines = stdoutBuffer.split('\n');
      stdoutBuffer = lines.pop();
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const event = JSON.parse(trimmed);
          if (event.type === 'thread.started' && event.thread_id) this.threadId = event.thread_id;
          if (event.type === 'turn.completed') sawTurnCompleted = true;
          this.emit('event', event);
        } catch (error) {
          this.emit('parse-error', { line: trimmed, error });
        }
      }
    });
    child.stderr.on('data', chunk => { stderr += chunk.toString(); });
    child.on('error', error => {
      this.lastError = error;
      this.emit('spawn-error', error);
    });
    child.on('close', (code, signal) => {
      const tail = stdoutBuffer.trim();
      if (tail) {
        try {
          const event = JSON.parse(tail);
          if (event.type === 'thread.started' && event.thread_id) this.threadId = event.thread_id;
          if (event.type === 'turn.completed') sawTurnCompleted = true;
          this.emit('event', event);
        } catch (error) {
          this.emit('parse-error', { line: tail, error });
        }
      }
      if (this.child === child) this.child = null;
      this.busy = false;
      this.emit('turn-exit', { code, signal, stderr: stderr.trim(), sawTurnCompleted });
    });

    child.stdin.end(prompt);
    return true;
  }

  interrupt(signal = 'SIGINT') {
    if (!this.child || !this.busy) return false;
    return this.child.kill(signal);
  }

  kill(signal = 'SIGTERM') {
    this.alive = false;
    if (!this.child) return true;
    return this.child.kill(signal);
  }
}
