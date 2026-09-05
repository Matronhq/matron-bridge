import { describe, it, expect } from 'vitest';
import { streamRefFor } from '../lib/journal-stream.js';

describe('streamRefFor', () => {
  it('uses the message id itself as the ref on a fresh overlay', () => {
    expect(streamRefFor(null, null, 'msg_123')).toBe('msg_123');
  });

  it('reuses the same ref while the same message keeps streaming (deltas coalesce under one overlay)', () => {
    const first = streamRefFor(null, null, 'msg_A');
    expect(first).toBe('msg_A');
    // Subsequent partials of the same message keep the ref.
    expect(streamRefFor(first, 'msg_A', 'msg_A')).toBe('msg_A');
  });

  it('mints a new ref when the message id changes (a new message starts a new overlay)', () => {
    const a = streamRefFor(null, null, 'msg_A');
    const b = streamRefFor(a, 'msg_A', 'msg_B');
    expect(b).toBe('msg_B');
    expect(b).not.toBe(a);
  });

  it('falls back to a generated id only when the message id is missing, and does not reuse across missing ids', () => {
    let n = 0;
    const mk = () => `uuid-${++n}`;
    const r1 = streamRefFor(null, null, undefined, mk);
    expect(r1).toBe('uuid-1');
    // prevMsgId is undefined and messageId is undefined: undefined === undefined
    // would wrongly "reuse" without the prevRef guard flow, so assert a fresh
    // id is minted each time there is no stable message id to key on.
    const r2 = streamRefFor(r1, undefined, undefined, mk);
    expect(r2).toBe('uuid-2');
  });

  it('does not carry a ref over from a different previous message even if prevRef is set', () => {
    expect(streamRefFor('msg_A', 'msg_A', 'msg_B')).toBe('msg_B');
  });
});
