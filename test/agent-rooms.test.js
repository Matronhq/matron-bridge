import { describe, it, expect, vi } from 'vitest';
import { createAgentRooms } from '../lib/agent-rooms.js';

// No fs fake needed: the registry takes plain load/save functions, so tests
// record calls directly and round-trip persistence through the save payload.
function makeStore({ initial, load, save } = {}) {
  const saveFn = save ?? vi.fn();
  const loadFn = load ?? (() => initial);
  const rooms = createAgentRooms({ load: loadFn, save: saveFn, log: { warn: () => {} } });
  return { rooms, save: saveFn };
}

const REC = { role: 'owner', state: 'pending', sessionRoomId: '!sess1' };

describe('createAgentRooms', () => {
  it('starts empty with no load/save injected and never throws', () => {
    const rooms = createAgentRooms({ log: { warn: () => {} } });
    expect(rooms.list()).toEqual([]);
    rooms.record('r1', REC); // save is optional too
    expect(rooms.get('r1')).toMatchObject(REC);
  });

  it('round-trips record/get/list', () => {
    const { rooms } = makeStore();
    const rec = rooms.record('r1', {
      role: 'guest', state: 'joined', sessionRoomId: '!sess1',
      peerDeviceId: 7, peerName: 'matron-dev-2', topic: 'ci triage', title: 'CI triage',
    });
    expect(rec).toMatchObject({
      role: 'guest', state: 'joined', sessionRoomId: '!sess1',
      peerDeviceId: 7, peerName: 'matron-dev-2', topic: 'ci triage', title: 'CI triage',
    });
    expect(rec.createdAt).toBeTypeOf('number');
    expect(rec.updatedAt).toBeTypeOf('number');
    expect(rooms.get('r1')).toEqual(rec);
    expect(rooms.get('nope')).toBeNull();
    expect(rooms.list()).toEqual([{ roomId: 'r1', ...rec }]);
  });

  it('defaults optional fields to null and preserves createdAt on re-record', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(1000);
      const { rooms } = makeStore();
      const first = rooms.record('r1', REC);
      expect(first).toMatchObject({ peerDeviceId: null, peerName: null, topic: null, title: null });
      expect(first.createdAt).toBe(1000);
      vi.setSystemTime(2000);
      const second = rooms.record('r1', { ...REC, state: 'joined' });
      expect(second.createdAt).toBe(1000);
      expect(second.updatedAt).toBe(2000);
    } finally {
      vi.useRealTimers();
    }
  });

  it('resumes from a loaded snapshot', () => {
    const { rooms } = makeStore({ initial: { r1: { ...REC, createdAt: 1, updatedAt: 1 } } });
    expect(rooms.get('r1')).toMatchObject(REC);
  });

  it.each([
    ['load throws', () => { throw new Error('corrupt'); }],
    ['load returns null', () => null],
    ['load returns an array', () => ['r1']],
    ['load returns a string', () => 'not a map'],
  ])('starts empty when %s', (_name, load) => {
    const { rooms } = makeStore({ load });
    expect(rooms.list()).toEqual([]);
  });

  it('setState updates state + updatedAt on a known room', () => {
    const { rooms, save } = makeStore();
    rooms.record('r1', REC);
    const updated = rooms.setState('r1', 'joined');
    expect(updated).toMatchObject({ ...REC, state: 'joined' });
    expect(rooms.get('r1').state).toBe('joined');
    expect(save).toHaveBeenCalledTimes(2);
  });

  it('setState on an unknown id returns null and does not persist', () => {
    const { rooms, save } = makeStore();
    expect(rooms.setState('ghost', 'joined')).toBeNull();
    expect(save).not.toHaveBeenCalled();
  });

  it('rebindSession moves every matching room and persists once per call', () => {
    const { rooms, save } = makeStore();
    rooms.record('r1', { role: 'owner', state: 'joined', sessionRoomId: '!old' });
    rooms.record('r2', { role: 'guest', state: 'pending', sessionRoomId: '!old' });
    rooms.record('r3', { role: 'owner', state: 'joined', sessionRoomId: '!other' });
    save.mockClear();

    expect(rooms.rebindSession('!old', '!new')).toBe(2);
    expect(save).toHaveBeenCalledTimes(1);
    expect(rooms.get('r1').sessionRoomId).toBe('!new');
    expect(rooms.get('r2').sessionRoomId).toBe('!new');
    expect(rooms.get('r3').sessionRoomId).toBe('!other');
  });

  it('rebindSession with no matches returns 0 and does not persist', () => {
    const { rooms, save } = makeStore();
    rooms.record('r1', REC);
    save.mockClear();
    expect(rooms.rebindSession('!nobody', '!new')).toBe(0);
    expect(save).not.toHaveBeenCalled();
  });

  it.each([
    ['pending', true],
    ['joined', true],
    ['refused', false],
    ['left', false],
    ['expired', false],
  ])('isActive: state %s -> %s', (state, expected) => {
    const { rooms } = makeStore();
    rooms.record('r1', { ...REC, state });
    expect(rooms.isActive('r1')).toBe(expected);
  });

  it('isActive is false for an unknown room', () => {
    const { rooms } = makeStore();
    expect(rooms.isActive('ghost')).toBe(false);
  });

  it('forSession returns only rooms bound to that session, with roomId', () => {
    const { rooms } = makeStore();
    rooms.record('r1', { role: 'owner', state: 'joined', sessionRoomId: '!a' });
    rooms.record('r2', { role: 'guest', state: 'pending', sessionRoomId: '!b' });
    rooms.record('r3', { role: 'owner', state: 'left', sessionRoomId: '!a' });
    const forA = rooms.forSession('!a');
    expect(forA.map((r) => r.roomId).sort()).toEqual(['r1', 'r3']);
    expect(forA.every((r) => r.sessionRoomId === '!a')).toBe(true);
    expect(rooms.forSession('!nobody')).toEqual([]);
  });

  it('remove deletes a known room and persists; unknown id is a silent no-op', () => {
    const { rooms, save } = makeStore();
    rooms.record('r1', REC);
    save.mockClear();
    rooms.remove('r1');
    expect(rooms.get('r1')).toBeNull();
    expect(save).toHaveBeenCalledTimes(1);
    rooms.remove('ghost');
    expect(save).toHaveBeenCalledTimes(1);
  });

  it('swallows a throwing save (and a throwing logger) on every mutation', () => {
    const save = vi.fn(() => { throw new Error('disk full'); });
    const rooms = createAgentRooms({ load: () => ({}), save, log: { warn: () => { throw new Error('log broke'); } } });
    expect(() => {
      rooms.record('r1', REC);
      rooms.setState('r1', 'joined');
      rooms.rebindSession('!sess1', '!sess2');
      rooms.remove('r1');
    }).not.toThrow();
    expect(save).toHaveBeenCalledTimes(4);
  });

  it('persists on every mutation with the current room map', () => {
    const { rooms, save } = makeStore();
    rooms.record('r1', REC);                 // 1
    rooms.record('r2', { ...REC, sessionRoomId: '!other' }); // 2
    rooms.setState('r1', 'joined');          // 3
    rooms.rebindSession('!other', '!moved'); // 4
    rooms.remove('r2');                      // 5
    expect(save).toHaveBeenCalledTimes(5);
    const lastSnapshot = save.mock.calls.at(-1)[0];
    expect(Object.keys(lastSnapshot)).toEqual(['r1']);
    expect(lastSnapshot.r1).toMatchObject({ ...REC, state: 'joined' });
  });
});
