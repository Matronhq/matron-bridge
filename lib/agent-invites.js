// Invite lifecycle + correlation for agent-chat rooms. Owns (a) building and
// sending the five room-op frames via the publisher, (b) one-shot waiters so
// tool calls can await delivered/ack/answer, (c) inbound kind:'invite' frame
// handling -> registry updates + request-turn injection. All side effects are
// injected (spec: agent chat phase 3, "Room lifecycle" / "Error handling").

const DEFAULT_ANSWER_WAIT_MS = 10_000;   // idle peer: wait briefly for the answer
const DEFAULT_DELIVER_WAIT_MS = 5_000;   // delivered/offline/error resolution

// deps:
//   sendRoomOp(frame) -> bool        (publisher, Task 2d)
//   onOpError(cb)                    (wired by index.js from publisher option)
//   rooms                            (agent-rooms registry, Task 3)
//   injectRequestTurn(frame)         frame.event: 'request'|'join_request'
//   notifyRoom(roomId, text)         inject an FYI turn into the bound session
//   log
export function createAgentInvites({ sendRoomOp, rooms, injectRequestTurn, notifyRoom, log = console } = {}) {
  // waiters: roomId -> [{events:Set<string>, resolve, timer}]
  const waiters = new Map();

  function awaitEvent(roomId, events, timeoutMs) {
    return new Promise((resolve) => {
      const entry = { events: new Set(events), resolve, timer: null };
      entry.timer = setTimeout(() => {
        unhook(roomId, entry);
        resolve({ kind: 'timeout' });
      }, timeoutMs);
      entry.timer.unref?.();
      if (!waiters.has(roomId)) waiters.set(roomId, []);
      waiters.get(roomId).push(entry);
    });
  }
  function unhook(roomId, entry) {
    const list = waiters.get(roomId) || [];
    const i = list.indexOf(entry);
    if (i >= 0) list.splice(i, 1);
    if (list.length === 0) waiters.delete(roomId);
  }
  function settle(roomId, key, value) {
    for (const entry of [...(waiters.get(roomId) || [])]) {
      if (entry.events.has(key)) {
        clearTimeout(entry.timer);
        unhook(roomId, entry);
        entry.resolve(value);
      }
    }
  }
  // settle() variant that reports whether anyone was waiting.
  function settleReturns(roomId, key, value) {
    const had = (waiters.get(roomId) || []).some((e) => e.events.has(key));
    settle(roomId, key, value);
    return had;
  }

  return {
    // ---- outbound (tool-call side) ----
    async invite({ roomId, targetDeviceId, topic, justification }) {
      if (!sendRoomOp({ op: 'agent_invite', room_id: roomId, target_device_id: targetDeviceId, ...(topic ? { topic } : {}), justification })) {
        return { kind: 'error', code: 'journal_unreachable' };
      }
      // Journal answers with EITHER an error frame (ref:'agent_invite') OR
      // {event:'delivered'}; then ack/answer follow on their own schedule.
      const delivered = await awaitEvent(roomId, ['delivered', 'error:agent_invite'], DEFAULT_DELIVER_WAIT_MS);
      if (delivered.kind !== 'delivered') return delivered;
      const outcome = await awaitEvent(roomId, ['ack', 'answer'], DEFAULT_ANSWER_WAIT_MS);
      if (outcome.kind === 'ack' && outcome.sessionState === 'busy') return { kind: 'pending_busy' };
      if (outcome.kind === 'ack') {
        // idle ack — the real answer should be close behind; wait once more
        const answer = await awaitEvent(roomId, ['answer'], DEFAULT_ANSWER_WAIT_MS);
        return answer.kind === 'timeout' ? { kind: 'pending_idle' } : answer;
      }
      if (outcome.kind === 'timeout') return { kind: 'pending_quiet' };
      return outcome; // answer
    },
    async join({ roomId, justification }) {
      if (!sendRoomOp({ op: 'agent_join', room_id: roomId, justification })) {
        return { kind: 'error', code: 'journal_unreachable' };
      }
      const delivered = await awaitEvent(roomId, ['delivered', 'error:agent_join'], DEFAULT_DELIVER_WAIT_MS);
      if (delivered.kind !== 'delivered') return delivered;
      const outcome = await awaitEvent(roomId, ['ack', 'answer'], DEFAULT_ANSWER_WAIT_MS);
      if (outcome.kind === 'ack' && outcome.sessionState === 'busy') return { kind: 'pending_busy' };
      if (outcome.kind === 'ack') {
        const answer = await awaitEvent(roomId, ['answer'], DEFAULT_ANSWER_WAIT_MS);
        return answer.kind === 'timeout' ? { kind: 'pending_idle' } : answer;
      }
      if (outcome.kind === 'timeout') return { kind: 'pending_quiet' };
      return outcome;
    },
    ack({ roomId, peerDeviceId = null, sessionState }) {
      return sendRoomOp({ op: 'agent_invite_ack', room_id: roomId, ...(peerDeviceId != null ? { peer_device_id: peerDeviceId } : {}), session_state: sessionState });
    },
    answer({ roomId, peerDeviceId = null, accept, reason }) {
      return sendRoomOp({ op: 'agent_invite_answer', room_id: roomId, ...(peerDeviceId != null ? { peer_device_id: peerDeviceId } : {}), accept, ...(reason ? { reason } : {}) });
    },
    leave({ roomId }) {
      return sendRoomOp({ op: 'agent_leave', room_id: roomId });
    },

    // ---- inbound (wired as publisher onInviteFrame / onOpError) ----
    onInviteFrame(frame) {
      const { event, room_id: roomId } = frame;
      if (event === 'delivered') { settle(roomId, 'delivered', { kind: 'delivered' }); return; }
      if (event === 'ack') { settle(roomId, 'ack', { kind: 'ack', sessionState: frame.session_state }); return; }
      if (event === 'answer') {
        const value = frame.accept
          ? { kind: 'accepted', peerDeviceId: frame.peer_device_id }
          : { kind: 'refused', reason: frame.reason || (frame.from_device_id == null ? 'expired' : ''), peerDeviceId: frame.peer_device_id };
        const room = rooms.get(roomId);
        if (room) {
          rooms.setState(roomId, frame.accept ? 'joined' : (value.reason === 'expired' ? 'expired' : 'refused'));
          // Late answers (after the tool stopped waiting) surface as a turn.
          if (!settleReturns(roomId, 'answer', value) && notifyRoom) {
            const what = frame.accept ? 'accepted the chat' : `refused the chat${value.reason ? `: ${value.reason}` : ''}`;
            try { notifyRoom(roomId, what); } catch { }
          }
        } else {
          settle(roomId, 'answer', value);
        }
        return;
      }
      if (event === 'request' || event === 'join_request') {
        try { injectRequestTurn(frame); } catch (e) { try { log.warn(`[agent-invites] injectRequestTurn threw: ${e.message}`); } catch { } }
        return;
      }
      if (event === 'left') {
        const room = rooms.get(roomId);
        if (room && notifyRoom) { try { notifyRoom(roomId, 'left the room'); } catch { } }
        return;
      }
    },
    onOpError({ code, ref, detail }) {
      // Correlate op errors back to the newest waiter for that op family.
      // Room ops are serialized per tool call, so ref-level granularity is
      // enough; the roomId isn't in the error frame.
      if (ref !== 'agent_invite' && ref !== 'agent_join') return;
      for (const [roomId] of waiters) {
        settle(roomId, `error:${ref}`, { kind: 'error', code, detail });
      }
    },
  };
}
