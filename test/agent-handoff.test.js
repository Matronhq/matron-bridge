import { describe, expect, it } from 'vitest';
import {
  buildAgentHandoffPrompt,
  canSwitchAgent,
  getPersistedAgentState,
  mergeAgentStates,
  normalizeHistoryCursor,
  prependHandoffPrompt,
  snapshotAgentState,
} from '../lib/agent-handoff.js';

describe('canSwitchAgent', () => {
  const idleClaude = { alive: true, agent: 'claude', busy: false };

  it('allows an idle provider handoff', () => {
    expect(canSwitchAgent(idleClaude, 'codex')).toEqual({ ok: true, target: 'codex' });
  });

  it('rejects the active provider and unknown providers', () => {
    expect(canSwitchAgent(idleClaude, 'claude').message).toContain('Already using Claude');
    expect(canSwitchAgent(idleClaude, 'gemini').message).toContain('/switch');
  });

  it('blocks turns, queues, prompts, and plans', () => {
    expect(canSwitchAgent({ ...idleClaude, busy: true }, 'codex').ok).toBe(false);
    expect(canSwitchAgent({ ...idleClaude, queuedMessages: [{}] }, 'codex').ok).toBe(false);
    expect(canSwitchAgent({ ...idleClaude, waitingForAnswer: {} }, 'codex').message).toContain('pending question');
    expect(canSwitchAgent({ ...idleClaude, pendingPlan: 'plan' }, 'codex').message).toContain('pending plan');
  });
});

describe('agent handoff persistence', () => {
  it('reads legacy active-agent fields without requiring a migration', () => {
    const state = getPersistedAgentState({
      agent: 'claude',
      sessionId: 'claude-1',
      model: 'sonnet',
      interactiveMode: true,
      mcpExtras: ['browser'],
      totalUsage: { input_tokens: 0, output_tokens: 0, cache_read: 0, cache_create: 0, cost_usd: 0 },
      turnCount: 0,
      lastUsed: 12,
    }, 'claude', 8);

    expect(state).toEqual({
      sessionId: 'claude-1',
      historyCursor: 8,
      model: 'sonnet',
      interactiveMode: true,
      mcpExtras: ['browser'],
      totalUsage: { input_tokens: 0, output_tokens: 0, cache_read: 0, cache_create: 0, cost_usd: 0 },
      turnCount: 0,
      lastUsed: 12,
    });
  });

  it('treats pre-agent persistence entries as Claude sessions', () => {
    expect(getPersistedAgentState({ sessionId: 'legacy-claude' }, 'claude', 0).sessionId)
      .toBe('legacy-claude');
    expect(getPersistedAgentState({ sessionId: 'legacy-claude' }, 'codex', 0).sessionId)
      .toBeNull();
  });

  it('prefers provider-specific state and clamps its cursor', () => {
    const state = getPersistedAgentState({
      agent: 'claude',
      sessionId: 'claude-1',
      agentSessions: {
        codex: { sessionId: 'codex-1', historyCursor: 99, model: 'gpt-test' },
      },
    }, 'codex', 4);

    expect(state.sessionId).toBe('codex-1');
    expect(state.historyCursor).toBe(4);
    expect(state.model).toBe('gpt-test');
  });

  it('does not leak the active provider model into a fresh target provider', () => {
    const codex = getPersistedAgentState({
      agent: 'claude',
      sessionId: 'claude-1',
      model: 'sonnet',
    }, 'codex', 2);

    expect(codex.sessionId).toBeNull();
    expect(codex.model).toBeNull();
    expect(codex.historyCursor).toBe(0);
  });

  it('snapshots and merges native state independently', () => {
    const claude = snapshotAgentState({
      agent: 'claude',
      claudeSessionId: 'c1',
      currentModel: 'sonnet',
      iv: {},
      mcpExtras: ['browser'],
      chatHistory: [{}, {}, {}],
    });
    const merged = mergeAgentStates({ codex: { sessionId: 'x1', historyCursor: 1 } }, { claude });

    expect(merged.codex.sessionId).toBe('x1');
    expect(merged.claude).toMatchObject({
      sessionId: 'c1',
      historyCursor: 3,
      model: 'sonnet',
      interactiveMode: true,
      mcpExtras: ['browser'],
      totalUsage: { input_tokens: 0, output_tokens: 0, cache_read: 0, cache_create: 0, cost_usd: 0 },
      turnCount: 0,
    });
  });

  it('normalizes invalid cursors', () => {
    expect(normalizeHistoryCursor(-5, 3)).toBe(0);
    expect(normalizeHistoryCursor(9, 3)).toBe(3);
    expect(normalizeHistoryCursor(undefined, 3)).toBe(0);
  });
});

describe('buildAgentHandoffPrompt', () => {
  it('labels providers and includes only the unseen transcript delta', () => {
    const result = buildAgentHandoffPrompt({
      fromAgent: 'claude',
      toAgent: 'codex',
      workdir: '/repo',
      history: [
        { role: 'user', text: 'already known' },
        { role: 'assistant', agent: 'claude', text: 'implemented the parser' },
        { role: 'user', text: 'now add tests' },
      ],
      startIndex: 1,
    });

    expect(result.fromIndex).toBe(1);
    expect(result.toIndex).toBe(3);
    expect(result.prompt).not.toContain('already known');
    expect(result.prompt).toContain('Claude Code to Codex');
    expect(result.prompt).toContain('ASSISTANT (Claude Code):\nimplemented the parser');
    expect(result.prompt).toContain('USER:\nnow add tests');
    expect(result.prompt).toContain('/repo');
  });

  it('prepends context without mutating the real user blocks', () => {
    const userBlocks = [{ type: 'text', text: 'fix the tests' }];
    const result = prependHandoffPrompt(userBlocks, { prompt: 'prior context' });

    expect(result).toEqual([
      { type: 'text', text: 'prior context' },
      { type: 'text', text: 'fix the tests' },
    ]);
    expect(userBlocks).toEqual([{ type: 'text', text: 'fix the tests' }]);
  });

  it('bounds long handoffs from the oldest side', () => {
    const history = Array.from({ length: 8 }, (_, i) => ({ role: 'user', text: `message-${i}` }));
    const result = buildAgentHandoffPrompt({
      fromAgent: 'codex',
      toAgent: 'claude',
      history,
      maxEntries: 3,
      maxChars: 2_000,
    });

    expect(result.prompt).not.toContain('message-4');
    expect(result.prompt).toContain('message-5');
    expect(result.prompt).toContain('message-7');
    expect(result.omittedMessages).toBe(5);
  });
});
