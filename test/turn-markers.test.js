import { describe, it, expect } from 'vitest';
import {
  NOTICE, TURN_ORIGIN, controlTurnOrigin, canAnnounceTurn, announceTurnStart, turnSeq,
  noteTurnDispatch, takeTurnStart, withTurnStart, markTurnOrigin, turnOriginOf,
  mergedTurnOrigin, TURN_EVENT_METHODS,
} from '../lib/turn-markers.js';

const text = (t) => [{ type: 'text', text: t }];

describe('wire values', () => {
  it('pins the notice classes clients key on', () => {
    expect({ ...NOTICE }).toEqual({
      COMPACTION: 'compaction',
      RESTART: 'restart',
      CRASH_RESTART: 'crash_restart',
      DELIVERY_FAILED: 'delivery_failed',
      SLOW_TOOL: 'slow_tool',
      CONTROL: 'control',
    });
  });
  it('pins the turn origins', () => {
    expect({ ...TURN_ORIGIN }).toEqual({
      ROUTINE: 'routine',
      REMINDER: 'reminder',
      NUDGE: 'nudge',
      ALERT: 'alert',
      CARRY_ON: 'carry_on',
      PEER: 'peer',
      CONSENT: 'consent',
      USAGE_LIMIT: 'usage_limit',
      COMPACT: 'compact',
      COORDINATOR: 'coordinator',
      ITEM: 'item',
      SECRET: 'secret',
      SPAWN: 'spawn',
    });
  });
  it('maps session-control actions to the turn they start', () => {
    expect(controlTurnOrigin('carry_on')).toBe('carry_on');
    expect(controlTurnOrigin('alert')).toBe('alert');
    expect(controlTurnOrigin('routine')).toBe('routine');
    expect(controlTurnOrigin('compact')).toBe('compact');
    expect(controlTurnOrigin('set_model')).toBeNull();
    expect(controlTurnOrigin(undefined)).toBeNull();
  });
});

describe('canAnnounceTurn', () => {
  it('is true only for a live session that is not inside a turn or a prompt', () => {
    expect(canAnnounceTurn({ alive: true })).toBe(true);
    expect(canAnnounceTurn({ alive: true, _awaitingInputReady: true })).toBe(true);
    expect(canAnnounceTurn({ alive: true, busy: true })).toBe(false);
    expect(canAnnounceTurn({ alive: true, waitingForAnswer: 'text-reply' })).toBe(false);
    expect(canAnnounceTurn({ alive: true, pendingInteractivePrompt: {} })).toBe(false);
    expect(canAnnounceTurn(null)).toBe(false);
  });

  it('is false where sendToSession would refuse the turn up front', () => {
    expect(canAnnounceTurn({})).toBe(false);
    expect(canAnnounceTurn({ alive: false })).toBe(false);
    expect(canAnnounceTurn({ alive: true, _autoStopped: true })).toBe(false);
    const codex = { transport: 'app-server' };
    expect(canAnnounceTurn({ alive: true, codex, _codexLoginId: 'login-1' })).toBe(false);
    expect(canAnnounceTurn({ alive: true, codex, _codexAccountCommandPending: true })).toBe(false);
    expect(canAnnounceTurn({ alive: true, codex })).toBe(true);
  });
});

describe('turn_start arming', () => {
  it('a dispatch with an origin marks exactly the next agent event', () => {
    const s = {};
    noteTurnDispatch(s, 'routine');
    expect(withTurnStart(s, 'publishText', { body: 'a', from: 'assistant' }))
      .toEqual({ body: 'a', from: 'assistant', turn_start: { origin: 'routine' } });
    expect(withTurnStart(s, 'publishText', { body: 'b', from: 'assistant' }))
      .toEqual({ body: 'b', from: 'assistant' });
  });

  it('an announced notice carries it, and the matching dispatch does not re-arm', () => {
    const s = {};
    expect(announceTurnStart(s, 'reminder')).toBe(true);
    expect(withTurnStart(s, 'publishText', { body: '⏰', from: 'assistant', notice: 'control' }))
      .toEqual({ body: '⏰', from: 'assistant', notice: 'control', turn_start: { origin: 'reminder' } });
    noteTurnDispatch(s, 'reminder');
    expect(withTurnStart(s, 'publishText', { body: 'reply', from: 'assistant' }))
      .toEqual({ body: 'reply', from: 'assistant' });
  });

  it('a dispatch with a different origin re-arms', () => {
    const s = {};
    announceTurnStart(s, 'reminder');
    takeTurnStart(s);
    noteTurnDispatch(s, 'peer');
    expect(takeTurnStart(s)).toEqual({ origin: 'peer' });
  });

  it('a second dispatch of the same origin is its own turn', () => {
    const s = {};
    noteTurnDispatch(s, 'peer');
    takeTurnStart(s);
    noteTurnDispatch(s, 'peer');
    expect(takeTurnStart(s)).toEqual({ origin: 'peer' });
  });

  it('a user-started dispatch clears any arm', () => {
    const s = {};
    noteTurnDispatch(s, 'routine'); // injected turn that published nothing
    noteTurnDispatch(s, null);
    expect(takeTurnStart(s)).toBeNull();
    announceTurnStart(s, 'reminder');
    noteTurnDispatch(s, undefined);
    expect(takeTurnStart(s)).toBeNull();
  });

  it('never marks a user-mirrored row, nor non-event frames', () => {
    const s = {};
    noteTurnDispatch(s, 'carry_on');
    expect(withTurnStart(s, 'publishText', { body: 'u', from: 'user' })).toEqual({ body: 'u', from: 'user' });
    expect(withTurnStart(s, 'upsertConvo', { title: 't' })).toEqual({ title: 't' });
    expect(withTurnStart(s, 'markRead', undefined)).toBeUndefined();
    expect(withTurnStart(s, 'publishDiff', { from: 'assistant' })).toEqual({ from: 'assistant', turn_start: { origin: 'carry_on' } });
  });

  it('does not mutate the caller payload', () => {
    const s = {};
    noteTurnDispatch(s, 'alert');
    const p = { body: 'x', from: 'assistant' };
    withTurnStart(s, 'publishText', p);
    expect(p).toEqual({ body: 'x', from: 'assistant' });
  });

  it('covers every row-producing publish method', () => {
    expect([...TURN_EVENT_METHODS].sort()).toEqual([
      'publishDiff', 'publishFile', 'publishImage', 'publishPrompt',
      'publishText', 'publishToolOutput',
    ]);
  });

  it('a late turn-end summary never takes the next turn marker', () => {
    const s = {};
    noteTurnDispatch(s, 'routine');
    expect(withTurnStart(s, 'publishSummary', { summary: 'previous turn', from: 'assistant' }))
      .toEqual({ summary: 'previous turn', from: 'assistant' });
    expect(takeTurnStart(s)).toEqual({ origin: 'routine' });
  });

  it('turnSeq moves on every dispatch decision', () => {
    const s = {};
    expect(turnSeq(s)).toBe(0);
    noteTurnDispatch(s, 'peer');
    noteTurnDispatch(s, null);
    expect(turnSeq(s)).toBe(2);
    expect(turnSeq(null)).toBe(0);
  });

  it('is inert without a session or an origin', () => {
    expect(announceTurnStart(null, 'routine')).toBe(false);
    expect(announceTurnStart({}, '')).toBe(false);
    expect(takeTurnStart(undefined)).toBeNull();
    expect(withTurnStart(undefined, 'publishText', { body: 'x' })).toEqual({ body: 'x' });
  });
});

describe('queued origin tags', () => {
  it('rides a blocks array without leaking into JSON', () => {
    const b = markTurnOrigin(text('hi'), 'peer');
    expect(turnOriginOf(b)).toBe('peer');
    expect(JSON.stringify(b)).toBe('[{"type":"text","text":"hi"}]');
    expect(turnOriginOf(text('x'))).toBeNull();
    expect(turnOriginOf(null)).toBeNull();
  });

  it('a merged flush is injected only when every entry is', () => {
    expect(mergedTurnOrigin([markTurnOrigin(text('a'), 'nudge'), markTurnOrigin(text('b'), 'peer')])).toBe('nudge');
    expect(mergedTurnOrigin([markTurnOrigin(text('a'), 'nudge'), text('user typed')])).toBeNull();
    expect(mergedTurnOrigin([])).toBeNull();
    expect(mergedTurnOrigin(null)).toBeNull();
  });
});
