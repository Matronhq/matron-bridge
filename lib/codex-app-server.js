import { spawn as nodeSpawn } from 'node:child_process';

const DEFAULT_TIMEOUT_MS = 15_000;

// Run a bounded, read-only query against Codex's documented app-server
// protocol. matron-bridge deliberately keeps codex exec as its turn runner;
// app-server is used here for account and MCP metadata that exec's compact
// JSONL stream does not expose.
export function queryCodexAppServer({
  requests,
  cwd,
  env = process.env,
  command = 'codex',
  spawnImpl = nodeSpawn,
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  const queryList = Array.isArray(requests) ? requests : [];
  if (queryList.length === 0) return Promise.resolve({});

  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawnImpl(command, ['app-server'], {
        cwd,
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (error) {
      reject(error);
      return;
    }

    let settled = false;
    let stdoutBuffer = '';
    let stderr = '';
    let timer = null;
    let initialized = false;
    const ids = new Map();
    const results = {};

    const finish = (error = null) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      // All requested responses have arrived. The helper owns this process,
      // so it is safe to stop it instead of leaving one daemon per refresh.
      if (child && typeof child.kill === 'function') child.kill('SIGTERM');
      if (error) reject(error);
      else resolve(results);
    };

    const handleMessage = (message) => {
      if (message?.id === 0 && !initialized) {
        if (message.error) {
          const detail = message.error.message || JSON.stringify(message.error);
          finish(new Error(`Codex app-server initialize failed: ${detail}`));
          return;
        }
        initialized = true;
        write({ method: 'initialized', params: {} });
        queryList.forEach((request, index) => {
          write({ method: request.method, id: index + 1, params: request.params });
        });
        return;
      }
      if (!message || !ids.has(message.id)) return;
      const key = ids.get(message.id);
      if (message.error) {
        const detail = message.error.message || JSON.stringify(message.error);
        finish(new Error(`Codex app-server ${key} failed: ${detail}`));
        return;
      }
      results[key] = message.result;
      ids.delete(message.id);
      if (ids.size === 0) finish();
    };

    const consumeLines = () => {
      const lines = stdoutBuffer.split('\n');
      stdoutBuffer = lines.pop() || '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          handleMessage(JSON.parse(trimmed));
        } catch (error) {
          finish(new Error(`Invalid JSON from Codex app-server: ${error.message}`));
          return;
        }
      }
    };

    timer = setTimeout(() => {
      finish(new Error(`Codex app-server query timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.stdout.on('data', (chunk) => {
      stdoutBuffer += chunk.toString();
      consumeLines();
    });
    child.stderr.on('data', (chunk) => {
      // Keep diagnostics useful without allowing a broken child to retain an
      // unbounded stderr string for the duration of the timeout.
      stderr = (stderr + chunk.toString()).slice(-16_384);
    });
    child.stdin.on('error', (error) => finish(error));
    child.on('error', (error) => finish(error));
    child.on('close', (code, signal) => {
      if (settled) return;
      const tail = stdoutBuffer.trim();
      if (tail) {
        try {
          handleMessage(JSON.parse(tail));
        } catch {
          // The close error below includes stderr and is more actionable than
          // a partial final JSON line.
        }
      }
      if (settled) return;
      const detail = stderr.trim() || `exited with ${signal ? `signal ${signal}` : `code ${code}`}`;
      finish(new Error(`Codex app-server ${detail}`));
    });

    const write = (message) => child.stdin.write(`${JSON.stringify(message)}\n`);
    queryList.forEach((request, index) => {
      const id = index + 1;
      const key = request.key || request.method;
      ids.set(id, key);
    });
    write({
      method: 'initialize',
      id: 0,
      params: {
        clientInfo: {
          name: 'matron_bridge',
          title: 'Matron Bridge',
          version: '1.0.0',
        },
      },
    });
  });
}

function pick(value, camel, snake) {
  return value?.[camel] ?? value?.[snake] ?? null;
}

function durationLabel(minutes, fallback) {
  if (minutes === 300) return '5-hour';
  if (minutes === 1_440) return 'Daily';
  if (minutes === 10_080) return 'Weekly';
  if (typeof minutes === 'number' && minutes > 0) {
    if (minutes % 1_440 === 0) return `${minutes / 1_440}-day`;
    if (minutes % 60 === 0) return `${minutes / 60}-hour`;
    return `${minutes}-minute`;
  }
  return fallback;
}

function resetFields(raw) {
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0) return {};
  const date = new Date(raw * 1_000);
  if (Number.isNaN(date.getTime())) return {};
  const resetsAt = date.toISOString();
  return { resets: resetsAt, resets_at: resetsAt };
}

function windowsFromSnapshot(snapshot, includeName) {
  if (!snapshot || typeof snapshot !== 'object') return [];
  const name = pick(snapshot, 'limitName', 'limit_name');
  const limitId = pick(snapshot, 'limitId', 'limit_id');
  const prefix = includeName
    ? (name || (limitId && limitId !== 'codex' ? limitId : 'Codex'))
    : '';
  const output = [];

  for (const [field, fallback] of [['primary', 'Primary'], ['secondary', 'Secondary']]) {
    const window = snapshot[field];
    if (!window || typeof window !== 'object') continue;
    const rawUsed = pick(window, 'usedPercent', 'used_percent');
    if (rawUsed === null) continue;
    const used = Number(rawUsed);
    if (!Number.isFinite(used)) continue;
    const minutes = Number(pick(window, 'windowDurationMins', 'window_minutes'));
    const descriptor = durationLabel(Number.isFinite(minutes) ? minutes : null, fallback);
    output.push({
      label: [prefix, descriptor].filter(Boolean).join(' '),
      percent: Math.max(0, Math.min(100, Math.round(used))),
      ...resetFields(Number(pick(window, 'resetsAt', 'resets_at'))),
    });
  }
  return output;
}

// Normalize both app-server's camelCase response and the equivalent
// snake_case token_count snapshot persisted by Codex rollouts into Matron's
// existing provider-neutral status limit shape.
export function normalizeCodexRateLimits(payload) {
  if (!payload || typeof payload !== 'object') return [];
  const byId = payload.rateLimitsByLimitId || payload.rate_limits_by_limit_id;
  let snapshots = byId && typeof byId === 'object'
    ? Object.values(byId).filter(Boolean)
    : [];
  if (snapshots.length === 0) {
    const single = payload.rateLimits || payload.rate_limits || payload;
    if (single && typeof single === 'object') snapshots = [single];
  }
  const includeName = snapshots.length > 1 || snapshots.some((snapshot) => {
    const id = pick(snapshot, 'limitId', 'limit_id');
    return id && id !== 'codex';
  });
  return snapshots.flatMap((snapshot) => windowsFromSnapshot(snapshot, includeName));
}

export async function fetchCodexAccountStatus(options = {}) {
  const response = await queryCodexAppServer({
    ...options,
    requests: [
      { method: 'account/rateLimits/read', key: 'rateLimits' },
      { method: 'account/read', key: 'account', params: { refreshToken: false } },
    ],
  });
  const account = response.account?.account;
  return {
    limits: normalizeCodexRateLimits(response.rateLimits),
    email: account?.type === 'chatgpt' && typeof account.email === 'string'
      ? account.email
      : null,
    planType: account?.type === 'chatgpt' ? account.planType || null : null,
  };
}

export async function fetchCodexMcpStatus(options = {}) {
  const response = await queryCodexAppServer({
    ...options,
    requests: [{
      method: 'mcpServerStatus/list',
      key: 'mcp',
      params: { cursor: null, limit: 100, detail: 'toolsAndAuthOnly', threadId: options.threadId || null },
    }],
  });
  return Array.isArray(response.mcp?.data) ? response.mcp.data : [];
}
