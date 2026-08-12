import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { normalizeCodexRateLimits } from './codex-app-server.js';

const DEFAULT_TAIL_BYTES = 8 * 1024 * 1024;
const rolloutPathCache = new Map();

function firstNumber(value, ...names) {
  for (const name of names) {
    const candidate = value?.[name];
    if (typeof candidate === 'number' && Number.isFinite(candidate)) return candidate;
  }
  return null;
}

export function parseCodexRolloutTelemetry(text) {
  const lines = String(text ?? '').split('\n');
  let tokenCount = null;
  let model = null;

  for (let i = lines.length - 1; i >= 0 && (!tokenCount || !model); i--) {
    const line = lines[i].trim();
    if (!line) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (!tokenCount && event?.type === 'event_msg' && event.payload?.type === 'token_count') {
      tokenCount = event.payload;
    }
    if (!model && event?.type === 'turn_context' && typeof event.payload?.model === 'string') {
      model = event.payload.model;
    }
  }

  if (!tokenCount && !model) return null;
  const info = tokenCount?.info;
  const last = info?.last_token_usage || info?.last || null;
  const total = info?.total_token_usage || info?.total || null;
  const contextTokens = firstNumber(last, 'total_tokens', 'totalTokens');
  const contextWindow = firstNumber(info, 'model_context_window', 'modelContextWindow');
  const totalUsage = total ? {
    input_tokens: firstNumber(total, 'input_tokens', 'inputTokens') || 0,
    output_tokens: firstNumber(total, 'output_tokens', 'outputTokens') || 0,
    cache_read: firstNumber(total, 'cached_input_tokens', 'cachedInputTokens') || 0,
    cache_create: 0,
    cost_usd: 0,
  } : null;

  return {
    model,
    contextTokens: contextTokens > 0 ? contextTokens : null,
    contextWindow: contextWindow > 0 ? contextWindow : null,
    limits: normalizeCodexRateLimits(tokenCount?.rate_limits || tokenCount?.rateLimits),
    totalUsage,
  };
}

function findInTree(directory, suffix) {
  let entries;
  try {
    entries = fs.readdirSync(directory, { withFileTypes: true });
  } catch {
    return null;
  }
  // Date partitions sort naturally; newest-first finds active sessions with
  // very little traversal while still allowing old resumed threads.
  entries.sort((a, b) => b.name.localeCompare(a.name));
  for (const entry of entries) {
    const candidate = path.join(directory, entry.name);
    if (entry.isFile() && entry.name.endsWith(suffix)) return candidate;
    if (entry.isDirectory()) {
      const nested = findInTree(candidate, suffix);
      if (nested) return nested;
    }
  }
  return null;
}

export function findCodexRolloutPath(threadId, { env = process.env, homeDir = os.homedir() } = {}) {
  if (typeof threadId !== 'string' || !threadId || /[\\/]/.test(threadId)) return null;
  const cached = rolloutPathCache.get(threadId);
  if (cached && fs.existsSync(cached)) return cached;
  const stateRoot = env.CODEX_HOME || path.join(homeDir, '.codex');
  const found = findInTree(path.join(stateRoot, 'sessions'), `${threadId}.jsonl`);
  if (found) rolloutPathCache.set(threadId, found);
  return found;
}

function readTail(filePath, maxBytes) {
  const fd = fs.openSync(filePath, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const length = Math.min(size, maxBytes);
    const offset = size - length;
    const buffer = Buffer.allocUnsafe(length);
    fs.readSync(fd, buffer, 0, length, offset);
    let text = buffer.toString('utf8');
    if (offset > 0) {
      const firstNewline = text.indexOf('\n');
      text = firstNewline >= 0 ? text.slice(firstNewline + 1) : '';
    }
    return text;
  } finally {
    fs.closeSync(fd);
  }
}

export function readCodexRolloutTelemetry(threadId, options = {}) {
  const filePath = options.filePath || findCodexRolloutPath(threadId, options);
  if (!filePath) return null;
  try {
    return parseCodexRolloutTelemetry(readTail(filePath, options.maxBytes || DEFAULT_TAIL_BYTES));
  } catch {
    // Telemetry is additive UI data. A concurrent rollout write, older Codex
    // format, or missing file must never fail the actual remote-control turn.
    return null;
  }
}

export function clearCodexRolloutPathCache() {
  rolloutPathCache.clear();
}
