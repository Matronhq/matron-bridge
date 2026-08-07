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

  // Returns { promise, cancel }. The waiter is registered synchronously so
  // callers can arm several stages up front; cancel() (clearTimeout + unhook)
  // MUST be called on any armed waiter a caller abandons, otherwise a later
  // frame settles into the void instead of taking the late-answer path.
  function awaitEvent(roomId, events, timeoutMs) {
    const entry = { events: new Set(events), resolve: null, timer: null };
    const promise = new Promise((resolve) => {
      entry.resolve = resolve;
      entry.timer = setTimeout(() => {
        unhook(roomId, entry);
        resolve({ kind: 'timeout' });
      }, timeoutMs);
      entry.timer.unref?.();
      if (!waiters.has(roomId)) waiters.set(roomId, []);
      waiters.get(roomId).push(entry);
    });
    return { promise, cancel: () => { clearTimeout(entry.timer); unhook(roomId, entry); } };
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
      // ALL stage waiters are armed before the first await: ws can emit a
      // whole batch of frames in one synchronous tick (delivered+ack+answer
      // back-to-back from one TCP chunk), and a waiter created only after
      // that batch drains would miss its frame. Each stage's timeout covers
      // the full elapsed budget since arming. Waiters abandoned on an early
      // return are cancelled so a genuinely late answer still surfaces via
      // the notifyRoom path instead of settling into the void.
      const deliveredW = awaitEvent(roomId, ['delivered', 'error:agent_invite'], DEFAULT_DELIVER_WAIT_MS);
      const outcomeW = awaitEvent(roomId, ['ack', 'answer'], DEFAULT_DELIVER_WAIT_MS + DEFAULT_ANSWER_WAIT_MS);
      const answerW = awaitEvent(roomId, ['answer'], DEFAULT_DELIVER_WAIT_MS + 2 * DEFAULT_ANSWER_WAIT_MS);
      const delivered = await deliveredW.promise;
      if (delivered.kind !== 'delivered') {
        outcomeW.cancel(); answerW.cancel();
        // A slow-but-healthy round trip is "quiet", not a raw timeout.
        return delivered.kind === 'timeout' ? { kind: 'pending_quiet' } : delivered;
      }
      const outcome = await outcomeW.promise;
      if (outcome.kind === 'timeout') { answerW.cancel(); return { kind: 'pending_quiet' }; }
      if (outcome.kind === 'ack' && outcome.sessionState === 'busy') { answerW.cancel(); return { kind: 'pending_busy' }; }
      if (outcome.kind === 'ack') {
        // idle ack — the real answer should be close behind; wait once more
        const answer = await answerW.promise;
        return answer.kind === 'timeout' ? { kind: 'pending_idle' } : answer;
      }
      return outcome; // answer — the same frame settled answerW, nothing left to cancel
    },
    async join({ roomId, justification }) {
      if (!sendRoomOp({ op: 'agent_join', room_id: roomId, justification })) {
        return { kind: 'error', code: 'journal_unreachable' };
      }
      // Same up-front arming + cancellation discipline as invite() above.
      const deliveredW = awaitEvent(roomId, ['delivered', 'error:agent_join'], DEFAULT_DELIVER_WAIT_MS);
      const outcomeW = awaitEvent(roomId, ['ack', 'answer'], DEFAULT_DELIVER_WAIT_MS + DEFAULT_ANSWER_WAIT_MS);
      const answerW = awaitEvent(roomId, ['answer'], DEFAULT_DELIVER_WAIT_MS + 2 * DEFAULT_ANSWER_WAIT_MS);
      const delivered = await deliveredW.promise;
      if (delivered.kind !== 'delivered') {
        outcomeW.cancel(); answerW.cancel();
        return delivered.kind === 'timeout' ? { kind: 'pending_quiet' } : delivered;
      }
      const outcome = await outcomeW.promise;
      if (outcome.kind === 'timeout') { answerW.cancel(); return { kind: 'pending_quiet' }; }
      if (outcome.kind === 'ack' && outcome.sessionState === 'busy') { answerW.cancel(); return { kind: 'pending_busy' }; }
      if (outcome.kind === 'ack') {
        const answer = await answerW.promise;
        return answer.kind === 'timeout' ? { kind: 'pending_idle' } : answer;
      }
      return outcome;
    },
    ack({ roomId, peerDeviceId = null, sessionState }) {
      return sendRoomOp({ op: 'agent_invite_ack', room_id: roomId, ...(peerDeviceId != null ? { peer_device_id: peerDeviceId } : {}), session_state: sessionState });
    },
    answer({ roomId, peerDeviceId = null, accept, reason }) {
      return sendRoomOp({ op: 'agent_invite_answer', room_id: roomId, ...(peerDeviceId != null ? { peer_device_id: peerDeviceId } : {}), accept, ...(reason ? { reason } : {}) });
    },
    async leave({ roomId }) {
      if (!sendRoomOp({ op: 'agent_leave', room_id: roomId })) {
        return { kind: 'error', code: 'journal_unreachable' };
      }
      // The journal answers agent_leave ONLY on failure (fail() stamps
      // ref:'agent_leave' — e.g. conflict "not a joined participant", which
      // is what a room OWNER always gets: it has no convo_agents row to
      // leave). Success is silent to the leaver (only the remaining
      // participant hears 'left'), so arm an error waiter and treat its
      // timeout as the leave having taken (whole-branch review, C2).
      const errW = awaitEvent(roomId, ['error:agent_leave'], DEFAULT_DELIVER_WAIT_MS);
      const res = await errW.promise;
      return res.kind === 'timeout' ? { kind: 'left' } : res;
    },

    // ---- inbound (wired as publisher onInviteFrame / onOpError) ----
    onInviteFrame(frame) {
      const { event, room_id: roomId } = frame;
      if (event === 'delivered') { settle(roomId, 'delivered', { kind: 'delivered' }); return; }
      if (event === 'ack') { settle(roomId, 'ack', { kind: 'ack', sessionState: frame.session_state }); return; }
      if (event === 'answer') {
        // A server-side expiry answer has no from_device_id; a peer refusal
        // does (even one whose reason text happens to say "expired").
        const expired = !frame.accept && frame.from_device_id == null;
        const value = frame.accept
          ? { kind: 'accepted', peerDeviceId: frame.peer_device_id }
          : { kind: 'refused', reason: frame.reason || (expired ? 'expired' : ''), peerDeviceId: frame.peer_device_id };
        const room = rooms.get(roomId);
        if (room) {
          // Only a pending room transitions on an answer: a duplicate or
          // out-of-order answer must not resurrect a refused/left room.
          // Waiters are still settled and late answers still notify.
          if (room.state === 'pending') {
            rooms.setState(roomId, frame.accept ? 'joined' : (expired ? 'expired' : 'refused'));
          }
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
        if (room) {
          // v1 rooms are pairwise: the peer leaving ends the room. Mark it
          // so isActive/chatSend stop treating it as live (chatRead still
          // works — it does not require 'joined').
          rooms.setState(roomId, 'left');
          if (notifyRoom) { try { notifyRoom(roomId, 'left the room'); } catch { } }
        }
        return;
      }
    },
    onOpError({ code, ref, detail }) {
      // Correlate op errors back to the newest waiter for that op family.
      // Room ops are serialized per tool call, so ref-level granularity is
      // enough; the roomId isn't in the error frame.
      if (ref !== 'agent_invite' && ref !== 'agent_join' && ref !== 'agent_leave') return;
      for (const [roomId] of waiters) {
        settle(roomId, `error:${ref}`, { kind: 'error', code, detail });
      }
    },
  };
}
