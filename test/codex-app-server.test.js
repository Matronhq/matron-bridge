import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import {
  fetchCodexAccountStatus,
  fetchCodexMcpStatus,
  normalizeCodexRateLimits,
  queryCodexAppServer,
} from '../lib/codex-app-server.js';

function fakeAppServer(responses) {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = vi.fn(() => true);
  let input = '';
  child.stdin.on('data', (chunk) => {
    input += chunk.toString();
    const lines = input.split('\n');
    input = lines.pop();
    for (const line of lines) {
      if (!line) continue;
      const message = JSON.parse(line);
      if (message.id === 0) {
        child.stdout.write(`${JSON.stringify({ id: 0, result: { userAgent: 'test' } })}\n`);
      } else if (message.id != null) {
        child.stdout.write(`${JSON.stringify({ id: message.id, result: responses[message.method] })}\n`);
      }
    }
  });
  return child;
}

describe('Codex app-server queries', () => {
  it('performs the documented initialize handshake and returns keyed responses', async () => {
    const child = fakeAppServer({ 'account/read': { account: { type: 'chatgpt', email: 'dev@example.com' } } });
    const spawnImpl = vi.fn(() => child);
    const result = await queryCodexAppServer({
      cwd: '/repo',
      spawnImpl,
      requests: [{ method: 'account/read', key: 'account', params: { refreshToken: false } }],
    });

    expect(spawnImpl).toHaveBeenCalledWith('codex', ['app-server'], expect.objectContaining({ cwd: '/repo' }));
    expect(result.account.account.email).toBe('dev@example.com');
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
  });

  it('fetches account limits/email and normalizes the public app-server schema', async () => {
    const child = fakeAppServer({
      'account/rateLimits/read': {
        rateLimits: {
          limitId: 'codex',
          primary: { usedPercent: 42.4, windowDurationMins: 300, resetsAt: 1_800_000_000 },
          secondary: { usedPercent: 17, windowDurationMins: 10_080, resetsAt: 1_800_600_000 },
        },
        rateLimitsByLimitId: null,
      },
      'account/read': {
        account: { type: 'chatgpt', email: 'dev@example.com', planType: 'pro' },
        requiresOpenaiAuth: true,
      },
    });
    const result = await fetchCodexAccountStatus({ cwd: '/repo', spawnImpl: () => child });
    expect(result).toEqual({
      email: 'dev@example.com',
      planType: 'pro',
      limits: [
        { label: '5-hour', percent: 42, resets: '2027-01-15T08:00:00.000Z', resets_at: '2027-01-15T08:00:00.000Z' },
        { label: 'Weekly', percent: 17, resets: '2027-01-22T06:40:00.000Z', resets_at: '2027-01-22T06:40:00.000Z' },
      ],
    });
  });

  it('normalizes snake_case rollout snapshots and preserves named model buckets', () => {
    expect(normalizeCodexRateLimits({
      limit_id: 'codex_fast',
      limit_name: 'Fast',
      primary: { used_percent: 75, window_minutes: 10_080, resets_at: 1_800_000_000 },
    })).toEqual([
      { label: 'Fast Weekly', percent: 75, resets: '2027-01-15T08:00:00.000Z', resets_at: '2027-01-15T08:00:00.000Z' },
    ]);
  });

  it('returns live MCP inventory from app-server', async () => {
    const child = fakeAppServer({
      'mcpServerStatus/list': {
        data: [{ name: 'github', serverInfo: { name: 'github' }, tools: { search: { name: 'search' } }, authStatus: 'oAuth' }],
        nextCursor: null,
      },
    });
    const result = await fetchCodexMcpStatus({ cwd: '/repo', spawnImpl: () => child });
    expect(result[0]).toMatchObject({ name: 'github', authStatus: 'oAuth' });
    expect(Object.keys(result[0].tools)).toEqual(['search']);
  });
});
