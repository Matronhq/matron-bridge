import { describe, expect, it } from 'vitest';
import {
  AGENT_CLAUDE,
  AGENT_CODEX,
  agentLabel,
  extractAgentFlag,
  normalizeAgent,
  resolveAgent,
} from '../lib/agent-backend.js';

describe('agent backend selection', () => {
  it('normalizes and resolves explicit, persisted, then fallback values', () => {
    expect(normalizeAgent(' CODEX ')).toBe(AGENT_CODEX);
    expect(normalizeAgent('unknown')).toBeNull();
    expect(resolveAgent({ option: 'codex', persisted: 'claude', fallback: 'claude' })).toBe(AGENT_CODEX);
    expect(resolveAgent({ persisted: 'codex', fallback: 'claude' })).toBe(AGENT_CODEX);
    expect(resolveAgent({ fallback: 'nonsense' })).toBe(AGENT_CLAUDE);
    expect(agentLabel('codex')).toBe('Codex');
  });

  it('extracts agent flags in any position and preserves other tokens', () => {
    expect(extractAgentFlag(['/repo', '--codex', 'now'])).toEqual({
      agent: AGENT_CODEX,
      rest: ['/repo', 'now'],
      error: null,
    });
    expect(extractAgentFlag(['--agent=claude', '/repo'])).toEqual({
      agent: AGENT_CLAUDE,
      rest: ['/repo'],
      error: null,
    });
  });

  it('accepts mobile autocorrected unicode dashes', () => {
    expect(extractAgentFlag(['—codex'])).toEqual({ agent: AGENT_CODEX, rest: [], error: null });
  });

  it('rejects unknown or conflicting agent flags', () => {
    expect(extractAgentFlag(['--agent=gemini']).error).toMatch(/Unknown agent/);
    expect(extractAgentFlag(['--codex', '--claude']).error).toMatch(/only one agent/);
  });
});

