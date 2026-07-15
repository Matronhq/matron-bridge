import { describe, it, expect } from 'vitest';
import { isSidechainEvent } from '../lib/session-status.js';

// 2026-07-15 live repro: the parent's stream-json stdout carries the
// subagent's own assistant/user events, tagged parent_tool_use_id (plus
// subagent_type / task_description sidecar fields). handleClaudeEvent had no
// guard, so every subagent narration was ALSO published to the parent convo —
// duplicating everything the watcher was already routing to the child.
describe('isSidechainEvent', () => {
  it('is true for parent_tool_use_id-tagged stream events (assistant and user)', () => {
    expect(isSidechainEvent({
      type: 'assistant',
      parent_tool_use_id: 'toolu_01FpULRSmdt7JZN2w8gTZy6S',
      subagent_type: 'Explore',
      message: { content: [{ type: 'text', text: 'There are 7 files' }] },
    })).toBe(true);
    expect(isSidechainEvent({
      type: 'user',
      parent_tool_use_id: 'toolu_01FpULRSmdt7JZN2w8gTZy6S',
      message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_inner' }] },
    })).toBe(true);
  });

  it('is true for isSidechain-tagged transcript events (iv-mode source)', () => {
    expect(isSidechainEvent({ type: 'assistant', isSidechain: true, message: {} })).toBe(true);
  });

  it('is false for ordinary parent events — including explicit null tags', () => {
    expect(isSidechainEvent({ type: 'assistant', parent_tool_use_id: null, message: {} })).toBe(false);
    expect(isSidechainEvent({ type: 'user', message: {} })).toBe(false);
    expect(isSidechainEvent({ type: 'result', result: 'done' })).toBe(false);
    expect(isSidechainEvent({ type: 'system', subtype: 'task_started', tool_use_id: 't', task_id: 'a' })).toBe(false);
  });

  it('never throws on junk', () => {
    expect(isSidechainEvent(null)).toBe(false);
    expect(isSidechainEvent(undefined)).toBe(false);
    expect(isSidechainEvent('nope')).toBe(false);
  });
});
