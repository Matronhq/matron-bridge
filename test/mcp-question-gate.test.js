import { describe, it, expect } from 'vitest';
import {
  isMcpQuestionAbandoned,
  releaseAbandonedMcpGate,
  MCP_GATE_LIVENESS_MS,
} from '../lib/mcp-question-gate.js';

// The bridge arms `session.waitingForAnswer = 'mcp:<id>'` while an ask_user MCP
// question is outstanding, so the next chat message is consumed as the answer.
// The MCP server only polls for ~5 minutes then silently gives up, without
// telling the bridge. `isMcpQuestionAbandoned` lets the message handler detect
// that no poller is still waiting (timeout, crash, restart) so it releases the
// gate instead of swallowing the user's message.
describe('isMcpQuestionAbandoned', () => {
  it('treats a question polled just now as live (not abandoned)', () => {
    const now = 1_000_000;
    expect(isMcpQuestionAbandoned({ lastPolledAt: now }, now)).toBe(false);
  });

  it('treats a question polled within the liveness window as live', () => {
    const now = 1_000_000;
    const q = { lastPolledAt: now - (MCP_GATE_LIVENESS_MS - 1) };
    expect(isMcpQuestionAbandoned(q, now)).toBe(false);
  });

  it('treats a question not polled since past the liveness window as abandoned', () => {
    const now = 1_000_000;
    const q = { lastPolledAt: now - (MCP_GATE_LIVENESS_MS + 1) };
    expect(isMcpQuestionAbandoned(q, now)).toBe(true);
  });

  it('treats a timed-out question (last polled minutes ago) as abandoned', () => {
    const now = 1_000_000;
    const q = { lastPolledAt: now - 6 * 60_000 };
    expect(isMcpQuestionAbandoned(q, now)).toBe(true);
  });

  it('treats a missing question (already cleaned up / never existed) as abandoned', () => {
    expect(isMcpQuestionAbandoned(undefined, 1_000_000)).toBe(true);
    expect(isMcpQuestionAbandoned(null, 1_000_000)).toBe(true);
  });

  it('treats a question with no lastPolledAt as abandoned (safe default: do not swallow)', () => {
    expect(isMcpQuestionAbandoned({}, 1_000_000)).toBe(true);
  });

  it('honors a custom threshold', () => {
    const now = 1_000_000;
    const q = { lastPolledAt: now - 2000 };
    expect(isMcpQuestionAbandoned(q, now, 1000)).toBe(true);
    expect(isMcpQuestionAbandoned(q, now, 3000)).toBe(false);
  });
});

describe('releaseAbandonedMcpGate', () => {
  const armedSession = (id) => ({
    waitingForAnswer: `mcp:${id}`,
    pendingQuestions: [{ question: 'pick one', options: [{ label: 'a' }] }],
    currentQuestionIndex: 0,
    questionAnswers: ['stale'],
  });

  it('releases the gate and deletes the question when the poller has gone (stale)', () => {
    const now = 1_000_000;
    const questions = new Map([['7', { lastPolledAt: now - 6 * 60_000 }]]);
    const session = armedSession('7');

    expect(releaseAbandonedMcpGate(session, questions, now)).toBe(true);
    expect(session.waitingForAnswer).toBe(null);
    expect(session.pendingQuestions).toBe(null);
    expect(session.currentQuestionIndex).toBe(0);
    expect(session.questionAnswers).toEqual([]);
    expect(questions.has('7')).toBe(false);
  });

  it('releases the gate when the question is already gone from the map', () => {
    const now = 1_000_000;
    const session = armedSession('7');
    expect(releaseAbandonedMcpGate(session, new Map(), now)).toBe(true);
    expect(session.waitingForAnswer).toBe(null);
  });

  it('leaves a live question alone (poller still polling)', () => {
    const now = 1_000_000;
    const questions = new Map([['7', { lastPolledAt: now - 200 }]]);
    const session = armedSession('7');

    expect(releaseAbandonedMcpGate(session, questions, now)).toBe(false);
    expect(session.waitingForAnswer).toBe('mcp:7');
    expect(session.pendingQuestions).not.toBe(null);
    expect(questions.has('7')).toBe(true);
  });

  it('ignores a non-mcp answer-gate (e.g. text-reply)', () => {
    const session = { waitingForAnswer: 'text-reply', pendingQuestions: [{}] };
    expect(releaseAbandonedMcpGate(session, new Map(), 1_000_000)).toBe(false);
    expect(session.waitingForAnswer).toBe('text-reply');
  });

  it('ignores an empty gate', () => {
    const session = { waitingForAnswer: null };
    expect(releaseAbandonedMcpGate(session, new Map(), 1_000_000)).toBe(false);
    expect(session.waitingForAnswer).toBe(null);
  });
});
