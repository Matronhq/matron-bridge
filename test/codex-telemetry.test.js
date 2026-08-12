import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  clearCodexRolloutPathCache,
  findCodexRolloutPath,
  parseCodexRolloutTelemetry,
  readCodexRolloutTelemetry,
} from '../lib/codex-telemetry.js';

const temporaryDirectories = [];

afterEach(() => {
  clearCodexRolloutPathCache();
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function rolloutText() {
  return [
    JSON.stringify({ type: 'session_meta', payload: { id: 'thread-123' } }),
    JSON.stringify({ type: 'turn_context', payload: { model: 'gpt-5.6-sol' } }),
    JSON.stringify({
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: {
          total_token_usage: {
            input_tokens: 200_000,
            cached_input_tokens: 150_000,
            output_tokens: 2_000,
            reasoning_output_tokens: 500,
            total_tokens: 202_000,
          },
          last_token_usage: {
            input_tokens: 90_000,
            cached_input_tokens: 80_000,
            output_tokens: 500,
            reasoning_output_tokens: 100,
            total_tokens: 90_500,
          },
          model_context_window: 258_400,
        },
        rate_limits: {
          limit_id: 'codex',
          primary: { used_percent: 12, window_minutes: 300, resets_at: 1_800_000_000 },
        },
      },
    }),
    '',
  ].join('\n');
}

describe('Codex rollout telemetry', () => {
  it('extracts exact context, model, cumulative usage, and limits', () => {
    expect(parseCodexRolloutTelemetry(rolloutText())).toEqual({
      model: 'gpt-5.6-sol',
      contextTokens: 90_500,
      contextWindow: 258_400,
      limits: [{
        label: '5-hour',
        percent: 12,
        resets: '2027-01-15T08:00:00.000Z',
        resets_at: '2027-01-15T08:00:00.000Z',
      }],
      totalUsage: {
        input_tokens: 200_000,
        output_tokens: 2_000,
        cache_read: 150_000,
        cache_create: 0,
        cost_usd: 0,
      },
    });
  });

  it('finds date-partitioned session files under CODEX_HOME and reads them', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'matron-codex-telemetry-'));
    temporaryDirectories.push(root);
    const sessionDir = path.join(root, 'sessions', '2026', '07', '20');
    fs.mkdirSync(sessionDir, { recursive: true });
    const filePath = path.join(sessionDir, 'rollout-2026-07-20T12-00-00-thread-123.jsonl');
    fs.writeFileSync(filePath, rolloutText());

    expect(findCodexRolloutPath('thread-123', { env: { CODEX_HOME: root } })).toBe(filePath);
    expect(readCodexRolloutTelemetry('thread-123', { env: { CODEX_HOME: root } })).toMatchObject({
      model: 'gpt-5.6-sol',
      contextTokens: 90_500,
      contextWindow: 258_400,
    });
  });

  it('fails open for missing or malformed telemetry', () => {
    expect(parseCodexRolloutTelemetry('not json\n')).toBeNull();
    expect(readCodexRolloutTelemetry('missing', { env: { CODEX_HOME: '/does/not/exist' } })).toBeNull();
  });
});
