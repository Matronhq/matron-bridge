import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  CAUSE_KINDS, CAUSES_MAX, CAUSE_REF_MAX,
  cause, userMessageCause, itemCause, routineCause, spawnOutcomeCause, roomMessageCause, plainCause,
  mergeCauses, queueCauses, beginTurn, endTurn, causesForAsk,
} from '../lib/turn-cause.js';

const NOW = Date.UTC(2026, 0, 2, 3, 4, 5, 678);

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(NOW); });
afterEach(() => { vi.useRealTimers(); });

describe('constants', () => {
  it('the shared vocabulary, in order', () => {
    expect(CAUSE_KINDS).toEqual(['user_message', 'item_reply', 'item_tap', 'routine', 'spawn_outcome',
      'room_message', 'reminder', 'carry_on', 'alert', 'handoff', 'other']);
    expect(CAUSES_MAX).toBe(8);
    expect(CAUSE_REF_MAX).toBe(200);
  });
});

describe('cause', () => {
  it('stamps kind, ref and at', () => {
    expect(cause('reminder', 'x')).toEqual({ kind: 'reminder', ref: 'x', at: NOW });
  });

  it('omits ref when none is given', () => {
    const c = cause('other');
    expect(c).toEqual({ kind: 'other', at: NOW });
    expect('ref' in c).toBe(false);
  });

  it('truncates an over-long ref to CAUSE_REF_MAX', () => {
    const c = cause('room_message', 'r'.repeat(500));
    expect(c.ref).toHaveLength(CAUSE_REF_MAX);
  });

  it('throws on an unknown kind', () => {
    expect(() => cause('telepathy')).toThrow(/unknown cause kind/);
    expect(() => cause(undefined)).toThrow();
  });
});

describe('builders', () => {
  it('userMessageCause: <convoId>:<seq>', () => {
    expect(userMessageCause('convo-a', 42)).toEqual({ kind: 'user_message', ref: 'convo-a:42', at: NOW });
  });

  it('routineCause: routine:<name>@<firedAt>, firedAt passed through as given', () => {
    expect(routineCause({ name: 'morning-sweep', firedAt: '2026-01-02T03:00:00.000Z' }))
      .toEqual({ kind: 'routine', ref: 'routine:morning-sweep@2026-01-02T03:00:00.000Z', at: NOW });
  });

  it('spawnOutcomeCause: spawn:<id>', () => {
    expect(spawnOutcomeCause('sp_1')).toEqual({ kind: 'spawn_outcome', ref: 'spawn:sp_1', at: NOW });
  });

  it('roomMessageCause: room:<id>', () => {
    expect(roomMessageCause('room-1')).toEqual({ kind: 'room_message', ref: 'room:room-1', at: NOW });
  });

  it('plainCause: kind only', () => {
    for (const k of ['reminder', 'carry_on', 'alert', 'handoff', 'other']) {
      expect(plainCause(k)).toEqual({ kind: k, at: NOW });
    }
    expect(() => plainCause('nope')).toThrow();
  });
});

describe('itemCause', () => {
  const at = Date.UTC(2026, 0, 1, 12, 0, 0, 5);
  const iso = '2026-01-01T12:00:00.005Z';

  it('a typed reply is item_reply with item:<num>@<created_at ISO ms Z>', () => {
    const p = { action: 'commented', num: 12, comment: { body: 'use A', created_at: at } };
    expect(itemCause(p)).toEqual({ kind: 'item_reply', ref: `item:12@${iso}`, at: NOW });
  });

  it('a one-tap reply (comment.action) is item_tap', () => {
    const p = { action: 'commented', num: 12, comment: { body: 'Go', action: 'Go', created_at: at } };
    expect(itemCause(p)).toEqual({ kind: 'item_tap', ref: `item:12@${iso}`, at: NOW });
  });

  it('a tap label still nested under comment.meta (older journal) is item_tap', () => {
    const p = { action: 'commented', num: 12, comment: { meta: { action: 'Go' }, created_at: at } };
    expect(itemCause(p).kind).toBe('item_tap');
  });

  it('the marker verb in payload.action does not make a reply a tap', () => {
    const p = { action: 'commented', num: 3, comment: { body: 'hi', created_at: at } };
    expect(itemCause(p).kind).toBe('item_reply');
  });

  it('a blank action label is a reply', () => {
    const p = { action: 'commented', num: 3, comment: { body: 'hi', action: '  ', created_at: at } };
    expect(itemCause(p).kind).toBe('item_reply');
  });

  it('null when the number or the comment created_at is missing', () => {
    expect(itemCause(null)).toBeNull();
    expect(itemCause({})).toBeNull();
    expect(itemCause({ num: 12 })).toBeNull();
    expect(itemCause({ num: 12, comment: {} })).toBeNull();
    expect(itemCause({ num: 12, comment: { created_at: 'yesterday' } })).toBeNull();
    expect(itemCause({ comment: { created_at: at } })).toBeNull();
    expect(itemCause({ num: '12', comment: { created_at: at } })).toBeNull();
  });
});

describe('mergeCauses', () => {
  const a = { kind: 'user_message', ref: 'c:1', at: 1 };
  const b = { kind: 'item_reply', ref: 'item:1@x', at: 2 };

  it('flattens lists and single causes, dropping falsy entries', () => {
    expect(mergeCauses([[a], null, b, undefined, []])).toEqual([a, b]);
  });

  it('dedupes by kind+ref, keeping the first', () => {
    const a2 = { ...a, at: 99 };
    const sameRefOtherKind = { kind: 'item_tap', ref: 'item:1@x', at: 3 };
    expect(mergeCauses([[a, b], [a2, sameRefOtherKind]])).toEqual([a, b, sameRefOtherKind]);
  });

  it('dedupes ref-less causes of the same kind', () => {
    const r1 = { kind: 'reminder', at: 1 };
    const r2 = { kind: 'reminder', at: 2 };
    expect(mergeCauses([[r1, r2]])).toEqual([r1]);
  });

  it('caps at CAUSES_MAX (8) causes, keeping the first', () => {
    const many = Array.from({ length: 12 }, (_, i) => ({ kind: 'room_message', ref: `room:${i}`, at: i }));
    const out = mergeCauses([many]);
    expect(out).toHaveLength(CAUSES_MAX);
    expect(out.map((c) => c.ref)).toEqual(many.slice(0, 8).map((c) => c.ref));
  });

  it('null when nothing is left', () => {
    expect(mergeCauses([])).toBeNull();
    expect(mergeCauses([null, [], undefined])).toBeNull();
    expect(mergeCauses(null)).toBeNull();
    expect(mergeCauses(undefined)).toBeNull();
  });
});

describe('queueCauses', () => {
  it('collects the causes of queued entries, in order, skipping entries without one', () => {
    const c1 = userMessageCause('c', 1);
    const c2 = roomMessageCause('r');
    expect(queueCauses([{ text: 'a', cause: c1 }, { text: 'b' }, { text: 'c', cause: c2 }])).toEqual([c1, c2]);
  });

  it('null when no entry has a cause', () => {
    expect(queueCauses([{ text: 'a' }, { text: 'b' }])).toBeNull();
    expect(queueCauses([])).toBeNull();
    expect(queueCauses(null)).toBeNull();
    expect(queueCauses([null])).toBeNull();
  });
});

describe('turn state', () => {
  it('beginTurn records merged causes and the start time; causesForAsk reads them', () => {
    const s = {};
    const c = userMessageCause('c', 7);
    beginTurn(s, [c, c]);
    expect(s.currentTurn).toEqual({ causes: [c], startedAt: NOW });
    expect(causesForAsk(s)).toEqual([c]);
  });

  it('beginTurn with no causes leaves causes null', () => {
    const s = {};
    beginTurn(s, null);
    expect(s.currentTurn).toEqual({ causes: null, startedAt: NOW });
    expect(causesForAsk(s)).toBeNull();
    beginTurn(s, []);
    expect(s.currentTurn.causes).toBeNull();
  });

  it('endTurn clears the turn; causesForAsk is then null', () => {
    const s = {};
    beginTurn(s, [plainCause('alert')]);
    endTurn(s);
    expect(s.currentTurn).toBeNull();
    expect(causesForAsk(s)).toBeNull();
  });

  it('causesForAsk is null for a session that never began a turn', () => {
    expect(causesForAsk({})).toBeNull();
    expect(causesForAsk(null)).toBeNull();
  });
});
