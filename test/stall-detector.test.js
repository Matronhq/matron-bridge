import { describe, it, expect } from 'vitest';
import { stallFromAssistantEvent, stallResetsAt } from '../lib/stall-detector.js';
import { buildSessionStatus, contextGaugeText } from '../lib/session-status.js';

const LIMIT_TEXT = "You've reached your Fable 5 limit. Run /usage-credits to continue or switch models with /model.";
const ev = (text, extra = {}) => ({ type: 'assistant', message: { model: 'claude-fable-5-1', content: [{ type: 'text', text }] }, ...extra });

describe('stallFromAssistantEvent', () => {
  it('recognises the limit message as the sole text block', () => {
    expect(stallFromAssistantEvent(ev(LIMIT_TEXT))).toEqual({ kind: 'usage_limit', model: 'claude-fable-5-1' });
    expect(stallFromAssistantEvent(ev(`Error during compaction: ${LIMIT_TEXT}`))).toEqual({ kind: 'usage_limit', model: 'claude-fable-5-1' });
    expect(stallFromAssistantEvent(ev("You've reached your Opus limit. Run /usage-credits to continue."))).toEqual({ kind: 'usage_limit', model: 'claude-fable-5-1' });
  });
  it('recognises the raw API-error form, and a string content body', () => {
    expect(stallFromAssistantEvent(ev('Claude AI usage limit reached|1790700000', { isApiErrorMessage: true }))).toEqual({ kind: 'usage_limit', model: 'claude-fable-5-1' });
    expect(stallFromAssistantEvent({ type: 'assistant', message: { content: LIMIT_TEXT } })).toEqual({ kind: 'usage_limit' });
  });
  it('does not fire on a message that merely quotes the text, on tool_use, on subagents or on other errors', () => {
    expect(stallFromAssistantEvent(ev(`The spec says the bridge sees "${LIMIT_TEXT}" and reports it.`))).toBeNull();
    expect(stallFromAssistantEvent({ type: 'assistant', message: { content: [{ type: 'text', text: LIMIT_TEXT }, { type: 'tool_use', id: 't', name: 'Bash', input: {} }] } })).toBeNull();
    expect(stallFromAssistantEvent({ ...ev(LIMIT_TEXT), isSidechain: true })).toBeNull();
    expect(stallFromAssistantEvent({ ...ev(LIMIT_TEXT), parent_tool_use_id: 'toolu_1' })).toBeNull();
    expect(stallFromAssistantEvent(ev('API Error: 500 overloaded', { isApiErrorMessage: true }))).toBeNull();
    expect(stallFromAssistantEvent({ type: 'user', message: { content: LIMIT_TEXT } })).toBeNull();
    expect(stallFromAssistantEvent(null)).toBeNull();
  });
});

describe('stallResetsAt', () => {
  it('prefers the session meter, then the first line with a reset time', () => {
    expect(stallResetsAt([{ id: 'week_all', label: 'Week (all models)', percent: 60, resets_at: '2026-10-02T00:00:00.000Z' }, { id: 'session', label: 'Current session', percent: 100, resets_at: '2026-09-29T15:00:00.000Z' }])).toBe('2026-09-29T15:00:00.000Z');
    expect(stallResetsAt([{ id: 'week_all', label: 'Week (all models)', percent: 60, resets_at: '2026-10-02T00:00:00.000Z' }])).toBe('2026-10-02T00:00:00.000Z');
    expect(stallResetsAt([{ id: 'session', label: 'Current session', percent: 100 }])).toBeUndefined();
    expect(stallResetsAt(undefined)).toBeUndefined();
  });
});

describe('buildSessionStatus stall', () => {
  it('passes a stall object through and omits the key otherwise', () => {
    const stall = { kind: 'usage_limit', model: 'claude-fable-5-1', resets_at: '2026-09-29T15:00:00.000Z', since: 1 };
    expect(buildSessionStatus({ model: 'claude-fable-5-1', stall }).stall).toEqual(stall);
    expect('stall' in buildSessionStatus({ model: 'claude-fable-5-1' })).toBe(false);
    expect('stall' in buildSessionStatus({ model: 'claude-fable-5-1', stall: null })).toBe(false);
  });
});

describe('contextGaugeText window override', () => {
  it('uses an explicit window over the model-derived one, and ignores a bad one', () => {
    expect(contextGaugeText(87000, 'claude-opus-5-5', 1000000)).toBe('87k/1m');
    expect(contextGaugeText(87000, 'claude-opus-5-5', 0)).toBe('87k/200k');
    expect(contextGaugeText(87000, 'claude-opus-5-5')).toBe('87k/200k');
  });
});
