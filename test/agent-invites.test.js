import { describe, it, expect, vi, afterEach } from 'vitest';
import { createAgentInvites } from '../lib/agent-invites.js';
import { createAgentRooms } from '../lib/agent-rooms.js';

// Awaited stages inside invite()/join() resume on microtasks; drain a few
// ticks so the next waiter is registered before the next frame is driven.
const flush = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); };

function makeInvites(overrides = {}) {
  const sendRoomOp = overrides.sendRoomOp ?? vi.fn(() => true);
  const rooms = overrides.rooms ?? createAgentRooms({ log: { warn: () => {} } });
  const injectRequestTurn = overrides.injectRequestTurn ?? vi.fn();
  const notifyRoom = overrides.notifyRoom ?? vi.fn();
  const log = overrides.log ?? { warn: vi.fn() };
  const inv = createAgentInvites({ sendRoomOp, rooms, injectRequestTurn, notifyRoom, log });
  return { inv, sendRoomOp, rooms, injectRequestTurn, notifyRoom, log };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('createAgentInvites', () => {
  describe('invite()', () => {
    it('happy path: delivered -> idle ack -> accept answer, registry joined', async () => {
      const { inv, sendRoomOp, rooms } = makeInvites();
      rooms.record('r1', { role: 'owner', state: 'pending', sessionRoomId: '!sess' });

      const p = inv.invite({ roomId: 'r1', targetDeviceId: 7, topic: 'ci triage', justification: 'need eyes' });
      expect(sendRoomOp).toHaveBeenCalledWith({
        op: 'agent_invite', room_id: 'r1', target_device_id: 7, topic: 'ci triage', justification: 'need eyes',
      });

      inv.onInviteFrame({ kind: 'invite', event: 'delivered', room_id: 'r1' });
      await flush();
      inv.onInviteFrame({ kind: 'invite', event: 'ack', room_id: 'r1', session_state: 'idle' });
      await flush();
      inv.onInviteFrame({ kind: 'invite', event: 'answer', room_id: 'r1', accept: true, peer_device_id: 7, from_device_id: 7 });

      await expect(p).resolves.toEqual({ kind: 'accepted', peerDeviceId: 7 });
      expect(rooms.get('r1').state).toBe('joined');
    });

    it('omits topic when not given', async () => {
      const { inv, sendRoomOp } = makeInvites({ sendRoomOp: vi.fn(() => false) });
      await inv.invite({ roomId: 'r1', targetDeviceId: 7, justification: 'j' });
      expect(sendRoomOp).toHaveBeenCalledWith({ op: 'agent_invite', room_id: 'r1', target_device_id: 7, justification: 'j' });
      expect(sendRoomOp.mock.calls[0][0]).not.toHaveProperty('topic');
    });

    it('busy ack resolves pending_busy', async () => {
      const { inv } = makeInvites();
      const p = inv.invite({ roomId: 'r1', targetDeviceId: 7, justification: 'j' });
      inv.onInviteFrame({ kind: 'invite', event: 'delivered', room_id: 'r1' });
      await flush();
      inv.onInviteFrame({ kind: 'invite', event: 'ack', room_id: 'r1', session_state: 'busy' });
      await expect(p).resolves.toEqual({ kind: 'pending_busy' });
    });

    it('refusal with reason resolves refused and marks the registry', async () => {
      const { inv, rooms, notifyRoom } = makeInvites();
      rooms.record('r1', { role: 'owner', state: 'pending', sessionRoomId: '!sess' });
      const p = inv.invite({ roomId: 'r1', targetDeviceId: 7, justification: 'j' });
      inv.onInviteFrame({ kind: 'invite', event: 'delivered', room_id: 'r1' });
      await flush();
      inv.onInviteFrame({ kind: 'invite', event: 'answer', room_id: 'r1', accept: false, reason: 'heads-down', peer_device_id: 7, from_device_id: 7 });
      await expect(p).resolves.toEqual({ kind: 'refused', reason: 'heads-down', peerDeviceId: 7 });
      expect(rooms.get('r1').state).toBe('refused');
      expect(notifyRoom).not.toHaveBeenCalled(); // a waiter consumed the answer
    });

    it('expiry answer (no from_device_id) yields reason expired and state expired', async () => {
      const { inv, rooms } = makeInvites();
      rooms.record('r1', { role: 'owner', state: 'pending', sessionRoomId: '!sess' });
      const p = inv.invite({ roomId: 'r1', targetDeviceId: 7, justification: 'j' });
      inv.onInviteFrame({ kind: 'invite', event: 'delivered', room_id: 'r1' });
      await flush();
      inv.onInviteFrame({ kind: 'invite', event: 'answer', room_id: 'r1', accept: false });
      await expect(p).resolves.toEqual({ kind: 'refused', reason: 'expired', peerDeviceId: undefined });
      expect(rooms.get('r1').state).toBe('expired');
    });

    it('offline error frame resolves {kind:error, code:offline}', async () => {
      const { inv } = makeInvites();
      const p = inv.invite({ roomId: 'r1', targetDeviceId: 7, justification: 'j' });
      inv.onOpError({ code: 'offline', ref: 'agent_invite', detail: 'peer offline' });
      await expect(p).resolves.toEqual({ kind: 'error', code: 'offline', detail: 'peer offline' });
    });

    it('ignores op errors with an unrelated ref', async () => {
      const { inv } = makeInvites();
      const p = inv.invite({ roomId: 'r1', targetDeviceId: 7, justification: 'j' });
      inv.onOpError({ code: 'bad_request', ref: 'convo_upsert' });
      inv.onInviteFrame({ kind: 'invite', event: 'delivered', room_id: 'r1' });
      await flush();
      inv.onInviteFrame({ kind: 'invite', event: 'answer', room_id: 'r1', accept: true, peer_device_id: 7, from_device_id: 7 });
      await expect(p).resolves.toEqual({ kind: 'accepted', peerDeviceId: 7 });
    });

    it('no delivered/error within the deliver window resolves pending_quiet (a documented outcome, not a raw timeout)', async () => {
      vi.useFakeTimers();
      const { inv } = makeInvites();
      const p = inv.invite({ roomId: 'r1', targetDeviceId: 7, justification: 'j' });
      await vi.advanceTimersByTimeAsync(5_000);
      await expect(p).resolves.toEqual({ kind: 'pending_quiet' });
    });

    it('delivered but silence resolves pending_quiet', async () => {
      vi.useFakeTimers();
      const { inv } = makeInvites();
      const p = inv.invite({ roomId: 'r1', targetDeviceId: 7, justification: 'j' });
      inv.onInviteFrame({ kind: 'invite', event: 'delivered', room_id: 'r1' });
      // Stage waiters are armed up front, so the ack/answer window is
      // DELIVER+ANSWER from the send, not ANSWER from the delivered frame.
      await vi.advanceTimersByTimeAsync(15_000);
      await expect(p).resolves.toEqual({ kind: 'pending_quiet' });
    });

    it('idle ack but no answer resolves pending_idle', async () => {
      vi.useFakeTimers();
      const { inv } = makeInvites();
      const p = inv.invite({ roomId: 'r1', targetDeviceId: 7, justification: 'j' });
      inv.onInviteFrame({ kind: 'invite', event: 'delivered', room_id: 'r1' });
      await flush();
      inv.onInviteFrame({ kind: 'invite', event: 'ack', room_id: 'r1', session_state: 'idle' });
      // Answer waiter budget is DELIVER + 2*ANSWER from the send.
      await vi.advanceTimersByTimeAsync(25_000);
      await expect(p).resolves.toEqual({ kind: 'pending_idle' });
    });

    it('sendRoomOp false resolves journal_unreachable without waiting', async () => {
      const { inv } = makeInvites({ sendRoomOp: vi.fn(() => false) });
      await expect(inv.invite({ roomId: 'r1', targetDeviceId: 7, justification: 'j' }))
        .resolves.toEqual({ kind: 'error', code: 'journal_unreachable' });
    });
  });

  // ws emits every message from one TCP chunk synchronously in one tick, so
  // lifecycle frames can land back-to-back with no microtask gap. These tests
  // deliberately do NOT flush() between frames: every stage waiter must
  // already be armed when the batch drains.
  describe('same-tick frame batches', () => {
    it('invite: delivered+ack(idle)+answer(accept) in one tick returns the accept (no leak to notifyRoom)', async () => {
      const { inv, rooms, notifyRoom } = makeInvites();
      rooms.record('r1', { role: 'owner', state: 'pending', sessionRoomId: '!sess' });
      const p = inv.invite({ roomId: 'r1', targetDeviceId: 7, justification: 'j' });
      inv.onInviteFrame({ kind: 'invite', event: 'delivered', room_id: 'r1' });
      inv.onInviteFrame({ kind: 'invite', event: 'ack', room_id: 'r1', session_state: 'idle' });
      inv.onInviteFrame({ kind: 'invite', event: 'answer', room_id: 'r1', accept: true, peer_device_id: 7, from_device_id: 7 });
      await expect(p).resolves.toEqual({ kind: 'accepted', peerDeviceId: 7 });
      expect(rooms.get('r1').state).toBe('joined');
      expect(notifyRoom).not.toHaveBeenCalled();
    });

    it('invite: delivered+answer in one tick (no ack) returns the answer', async () => {
      const { inv, rooms, notifyRoom } = makeInvites();
      rooms.record('r1', { role: 'owner', state: 'pending', sessionRoomId: '!sess' });
      const p = inv.invite({ roomId: 'r1', targetDeviceId: 7, justification: 'j' });
      inv.onInviteFrame({ kind: 'invite', event: 'delivered', room_id: 'r1' });
      inv.onInviteFrame({ kind: 'invite', event: 'answer', room_id: 'r1', accept: false, reason: 'heads-down', peer_device_id: 7, from_device_id: 7 });
      await expect(p).resolves.toEqual({ kind: 'refused', reason: 'heads-down', peerDeviceId: 7 });
      expect(rooms.get('r1').state).toBe('refused');
      expect(notifyRoom).not.toHaveBeenCalled();
    });

    it('join: delivered+ack(idle)+answer(accept) in one tick returns the accept', async () => {
      const { inv, notifyRoom } = makeInvites();
      const p = inv.join({ roomId: 'r2', justification: 'j' });
      inv.onInviteFrame({ kind: 'invite', event: 'delivered', room_id: 'r2' });
      inv.onInviteFrame({ kind: 'invite', event: 'ack', room_id: 'r2', session_state: 'idle' });
      inv.onInviteFrame({ kind: 'invite', event: 'answer', room_id: 'r2', accept: true, peer_device_id: 3, from_device_id: 3 });
      await expect(p).resolves.toEqual({ kind: 'accepted', peerDeviceId: 3 });
      expect(notifyRoom).not.toHaveBeenCalled();
    });

    it('frames settle only their own room; op errors fan out to every in-flight invite (coarse, pinned)', async () => {
      const { inv } = makeInvites();
      const p1 = inv.invite({ roomId: 'r1', targetDeviceId: 7, justification: 'j' });
      const p2 = inv.invite({ roomId: 'r2', targetDeviceId: 8, justification: 'j' });
      inv.onInviteFrame({ kind: 'invite', event: 'delivered', room_id: 'r1' });
      inv.onInviteFrame({ kind: 'invite', event: 'ack', room_id: 'r1', session_state: 'idle' });
      inv.onInviteFrame({ kind: 'invite', event: 'answer', room_id: 'r1', accept: true, peer_device_id: 7, from_device_id: 7 });
      await expect(p1).resolves.toEqual({ kind: 'accepted', peerDeviceId: 7 });
      // r2 was untouched by r1's frames. The error correlation is ref-level
      // (no room_id in error frames): it settles EVERY in-flight invite —
      // acceptable for v1 because room ops serialize per tool call.
      inv.onOpError({ code: 'offline', ref: 'agent_invite', detail: 'peer offline' });
      await expect(p2).resolves.toEqual({ kind: 'error', code: 'offline', detail: 'peer offline' });
    });
  });

  describe('join()', () => {
    it('happy path: delivered -> idle ack -> accept answer', async () => {
      const { inv, sendRoomOp } = makeInvites();
      const p = inv.join({ roomId: 'r2', justification: 'saw the roster entry' });
      expect(sendRoomOp).toHaveBeenCalledWith({ op: 'agent_join', room_id: 'r2', justification: 'saw the roster entry' });
      inv.onInviteFrame({ kind: 'invite', event: 'delivered', room_id: 'r2' });
      await flush();
      inv.onInviteFrame({ kind: 'invite', event: 'ack', room_id: 'r2', session_state: 'idle' });
      await flush();
      inv.onInviteFrame({ kind: 'invite', event: 'answer', room_id: 'r2', accept: true, peer_device_id: 3, from_device_id: 3 });
      await expect(p).resolves.toEqual({ kind: 'accepted', peerDeviceId: 3 });
    });

    it('busy ack resolves pending_busy', async () => {
      const { inv } = makeInvites();
      const p = inv.join({ roomId: 'r2', justification: 'j' });
      inv.onInviteFrame({ kind: 'invite', event: 'delivered', room_id: 'r2' });
      await flush();
      inv.onInviteFrame({ kind: 'invite', event: 'ack', room_id: 'r2', session_state: 'busy' });
      await expect(p).resolves.toEqual({ kind: 'pending_busy' });
    });

    it('correlates error frames via ref agent_join', async () => {
      const { inv } = makeInvites();
      const p = inv.join({ roomId: 'r2', justification: 'j' });
      inv.onOpError({ code: 'not_found', ref: 'agent_join' });
      await expect(p).resolves.toEqual({ kind: 'error', code: 'not_found', detail: undefined });
    });

    it('sendRoomOp false resolves journal_unreachable without waiting', async () => {
      const { inv } = makeInvites({ sendRoomOp: vi.fn(() => false) });
      await expect(inv.join({ roomId: 'r2', justification: 'j' }))
        .resolves.toEqual({ kind: 'error', code: 'journal_unreachable' });
    });

    it('no delivered/error within the deliver window resolves pending_quiet', async () => {
      vi.useFakeTimers();
      const { inv } = makeInvites();
      const p = inv.join({ roomId: 'r2', justification: 'j' });
      await vi.advanceTimersByTimeAsync(5_000);
      await expect(p).resolves.toEqual({ kind: 'pending_quiet' });
    });

    it('delivered but silence resolves pending_quiet', async () => {
      vi.useFakeTimers();
      const { inv } = makeInvites();
      const p = inv.join({ roomId: 'r2', justification: 'j' });
      inv.onInviteFrame({ kind: 'invite', event: 'delivered', room_id: 'r2' });
      await vi.advanceTimersByTimeAsync(15_000);
      await expect(p).resolves.toEqual({ kind: 'pending_quiet' });
    });

    it('idle ack but no answer resolves pending_idle', async () => {
      vi.useFakeTimers();
      const { inv } = makeInvites();
      const p = inv.join({ roomId: 'r2', justification: 'j' });
      inv.onInviteFrame({ kind: 'invite', event: 'delivered', room_id: 'r2' });
      await flush();
      inv.onInviteFrame({ kind: 'invite', event: 'ack', room_id: 'r2', session_state: 'idle' });
      await vi.advanceTimersByTimeAsync(25_000);
      await expect(p).resolves.toEqual({ kind: 'pending_idle' });
    });
  });

  describe('ack / answer / leave senders', () => {
    it('ack sends session_state and includes peer_device_id only when given', () => {
      const { inv, sendRoomOp } = makeInvites();
      expect(inv.ack({ roomId: 'r1', peerDeviceId: 7, sessionState: 'busy' })).toBe(true);
      expect(sendRoomOp).toHaveBeenLastCalledWith({ op: 'agent_invite_ack', room_id: 'r1', peer_device_id: 7, session_state: 'busy' });
      inv.ack({ roomId: 'r1', sessionState: 'idle' });
      expect(sendRoomOp).toHaveBeenLastCalledWith({ op: 'agent_invite_ack', room_id: 'r1', session_state: 'idle' });
    });

    it('answer sends accept and includes reason/peer_device_id only when given', () => {
      const { inv, sendRoomOp } = makeInvites();
      inv.answer({ roomId: 'r1', peerDeviceId: 7, accept: false, reason: 'busy week' });
      expect(sendRoomOp).toHaveBeenLastCalledWith({ op: 'agent_invite_answer', room_id: 'r1', peer_device_id: 7, accept: false, reason: 'busy week' });
      inv.answer({ roomId: 'r1', accept: true });
      expect(sendRoomOp).toHaveBeenLastCalledWith({ op: 'agent_invite_answer', room_id: 'r1', accept: true });
    });

    it('leave sends agent_leave and returns the publisher result', () => {
      const { inv, sendRoomOp } = makeInvites({ sendRoomOp: vi.fn(() => false) });
      expect(inv.leave({ roomId: 'r1' })).toBe(false);
      expect(sendRoomOp).toHaveBeenCalledWith({ op: 'agent_leave', room_id: 'r1' });
    });
  });

  describe('onInviteFrame (inbound, no waiter)', () => {
    it('late accept answer with no waiter notifies the room', () => {
      const { inv, rooms, notifyRoom } = makeInvites();
      rooms.record('r1', { role: 'owner', state: 'pending', sessionRoomId: '!sess' });
      inv.onInviteFrame({ kind: 'invite', event: 'answer', room_id: 'r1', accept: true, peer_device_id: 7, from_device_id: 7 });
      expect(notifyRoom).toHaveBeenCalledWith('r1', 'accepted the chat');
      expect(rooms.get('r1').state).toBe('joined');
    });

    it('late refusal with no waiter notifies with the reason', () => {
      const { inv, rooms, notifyRoom } = makeInvites();
      rooms.record('r1', { role: 'owner', state: 'pending', sessionRoomId: '!sess' });
      inv.onInviteFrame({ kind: 'invite', event: 'answer', room_id: 'r1', accept: false, reason: 'nope', peer_device_id: 7, from_device_id: 7 });
      expect(notifyRoom).toHaveBeenCalledWith('r1', 'refused the chat: nope');
      expect(rooms.get('r1').state).toBe('refused');
    });

    it('a replayed/duplicate answer does not resurrect a terminal room', () => {
      const { inv, rooms, notifyRoom } = makeInvites();
      rooms.record('r1', { role: 'owner', state: 'pending', sessionRoomId: '!sess' });
      rooms.setState('r1', 'joined');
      rooms.record('r1', { role: 'owner', state: 'left', sessionRoomId: '!sess' }); // chatLeave stamped it
      inv.onInviteFrame({ kind: 'invite', event: 'answer', room_id: 'r1', accept: true, peer_device_id: 7, from_device_id: 7 });
      expect(rooms.get('r1').state).toBe('left');
      // Late-answer notify still fires; only the state transition is gated.
      expect(notifyRoom).toHaveBeenCalledWith('r1', 'accepted the chat');
    });

    it('a peer refusal whose reason text is literally "expired" is refused, not expired', () => {
      const { inv, rooms } = makeInvites();
      rooms.record('r1', { role: 'owner', state: 'pending', sessionRoomId: '!sess' });
      inv.onInviteFrame({ kind: 'invite', event: 'answer', room_id: 'r1', accept: false, reason: 'expired', peer_device_id: 7, from_device_id: 7 });
      expect(rooms.get('r1').state).toBe('refused');
    });

    it('left marks a known room state=left so it goes inactive (routing/chatSend stop)', () => {
      const { inv, rooms, notifyRoom } = makeInvites();
      rooms.record('r1', { role: 'owner', state: 'joined', sessionRoomId: '!sess' });
      inv.onInviteFrame({ kind: 'invite', event: 'left', room_id: 'r1', from_device_id: 7 });
      expect(rooms.get('r1').state).toBe('left');
      expect(rooms.isActive('r1')).toBe(false);
      expect(notifyRoom).toHaveBeenCalledWith('r1', 'left the room');
    });

    it('answer for an unknown room settles nothing and never notifies', () => {
      const { inv, notifyRoom, rooms } = makeInvites();
      expect(() => inv.onInviteFrame({ kind: 'invite', event: 'answer', room_id: 'ghost', accept: true, peer_device_id: 7 })).not.toThrow();
      expect(notifyRoom).not.toHaveBeenCalled();
      expect(rooms.get('ghost')).toBeNull();
    });

    it('request and join_request are handed to injectRequestTurn with the frame', () => {
      const { inv, injectRequestTurn } = makeInvites();
      const req = { kind: 'invite', event: 'request', room_id: 'r1', from_device_id: 7, justification: 'j' };
      const joinReq = { kind: 'invite', event: 'join_request', room_id: 'r1', from_device_id: 8, justification: 'k' };
      inv.onInviteFrame(req);
      inv.onInviteFrame(joinReq);
      expect(injectRequestTurn).toHaveBeenNthCalledWith(1, req);
      expect(injectRequestTurn).toHaveBeenNthCalledWith(2, joinReq);
    });

    it('a throwing injectRequestTurn is swallowed and warned', () => {
      const { inv, log } = makeInvites({ injectRequestTurn: vi.fn(() => { throw new Error('boom'); }) });
      expect(() => inv.onInviteFrame({ kind: 'invite', event: 'request', room_id: 'r1' })).not.toThrow();
      expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('boom'));
    });

    it('left notifies known rooms only and swallows a throwing notifyRoom', () => {
      const { inv, rooms, notifyRoom } = makeInvites({ notifyRoom: vi.fn(() => { throw new Error('down'); }) });
      rooms.record('r1', { role: 'owner', state: 'joined', sessionRoomId: '!sess' });
      expect(() => inv.onInviteFrame({ kind: 'invite', event: 'left', room_id: 'r1', from_device_id: 7 })).not.toThrow();
      expect(notifyRoom).toHaveBeenCalledWith('r1', 'left the room');
      notifyRoom.mockClear();
      inv.onInviteFrame({ kind: 'invite', event: 'left', room_id: 'ghost', from_device_id: 7 });
      expect(notifyRoom).not.toHaveBeenCalled();
    });

    it('unknown events are ignored', () => {
      const { inv } = makeInvites();
      expect(() => inv.onInviteFrame({ kind: 'invite', event: 'mystery', room_id: 'r1' })).not.toThrow();
    });
  });

  describe('waiter cleanup', () => {
    it('replaying every frame after resolution is a safe no-op (waiters drained)', async () => {
      const { inv, notifyRoom } = makeInvites(); // room never recorded -> answer path settles only
      const p = inv.invite({ roomId: 'r1', targetDeviceId: 7, justification: 'j' });
      const frames = [
        { kind: 'invite', event: 'delivered', room_id: 'r1' },
        { kind: 'invite', event: 'ack', room_id: 'r1', session_state: 'idle' },
        { kind: 'invite', event: 'answer', room_id: 'r1', accept: true, peer_device_id: 7, from_device_id: 7 },
      ];
      for (const f of frames) { inv.onInviteFrame(f); await flush(); }
      await expect(p).resolves.toEqual({ kind: 'accepted', peerDeviceId: 7 });
      // Double-settle safety: nothing is waiting anymore, so replays do nothing.
      expect(() => { for (const f of frames) inv.onInviteFrame(f); }).not.toThrow();
      expect(() => inv.onOpError({ code: 'offline', ref: 'agent_invite' })).not.toThrow();
      expect(notifyRoom).not.toHaveBeenCalled();
    });

    it('timed-out and cancelled waiters are unhooked: late frames after a deliver timeout settle nothing', async () => {
      vi.useFakeTimers();
      const { inv, notifyRoom } = makeInvites();
      const p = inv.invite({ roomId: 'r1', targetDeviceId: 7, justification: 'j' });
      await vi.advanceTimersByTimeAsync(5_000);
      await expect(p).resolves.toEqual({ kind: 'pending_quiet' });
      // The up-front outcome/answer waiters must be cancelled on this path too.
      expect(() => {
        inv.onInviteFrame({ kind: 'invite', event: 'delivered', room_id: 'r1' });
        inv.onInviteFrame({ kind: 'invite', event: 'ack', room_id: 'r1', session_state: 'idle' });
        inv.onInviteFrame({ kind: 'invite', event: 'answer', room_id: 'r1', accept: true, peer_device_id: 7, from_device_id: 7 });
      }).not.toThrow();
      expect(notifyRoom).not.toHaveBeenCalled(); // room never recorded
    });

    it('after pending_busy the abandoned answer waiter is cancelled: a late answer surfaces via notifyRoom', async () => {
      const { inv, rooms, notifyRoom } = makeInvites();
      rooms.record('r1', { role: 'owner', state: 'pending', sessionRoomId: '!sess' });
      const p = inv.invite({ roomId: 'r1', targetDeviceId: 7, justification: 'j' });
      inv.onInviteFrame({ kind: 'invite', event: 'delivered', room_id: 'r1' });
      await flush();
      inv.onInviteFrame({ kind: 'invite', event: 'ack', room_id: 'r1', session_state: 'busy' });
      await expect(p).resolves.toEqual({ kind: 'pending_busy' });
      // If the armed answer waiter leaked, settleReturns would report true
      // and this genuinely late answer would be swallowed silently.
      inv.onInviteFrame({ kind: 'invite', event: 'answer', room_id: 'r1', accept: true, peer_device_id: 7, from_device_id: 7 });
      expect(notifyRoom).toHaveBeenCalledWith('r1', 'accepted the chat');
      expect(rooms.get('r1').state).toBe('joined');
    });
  });
});
