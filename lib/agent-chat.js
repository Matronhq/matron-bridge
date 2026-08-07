import { randomUUID } from 'crypto';

// Loopback handlers for the eight agent-chat room tools (spec: agent chat
// phase 3, "Bridge changes"). One factory returning all handlers, each
// async (data) => ({status, body}) — HTTP-agnostic so they are fully
// unit-testable; index.js mounts each as a thin adapter on the loopback API
// server (the /send-attachment pattern). Room lifecycle side effects go
// through the injected invites manager (lib/agent-invites.js) and rooms
// registry (lib/agent-rooms.js); journal traffic goes through the publisher.

const ROOM_TITLE_MAX = 120;
const WAIT_SECONDS_CAP = 60;

// deps: sessions, publisher, rooms, invites,
//       awaitRoomMessage(chatRoomId, ms) -> Promise<{from, body}|null>
//         (index.js seam fed from journalOnRoomFrame; null on timeout),
//       serverLabel (bridge host label, e.g. '2'), log
export function createAgentChatHandlers({ sessions, publisher, rooms, invites, awaitRoomMessage = async () => null, serverLabel = '', log = console } = {}) {

  function callerSession(data) {
    const { roomId } = data || {};
    if (!roomId || typeof roomId !== 'string') return { err: { status: 400, body: { error: 'roomId is required' } } };
    const session = sessions.get(roomId);
    if (!session) return { err: { status: 404, body: { error: `no active session for chat ${roomId}` } } };
    return { session, sessionKey: roomId };
  }

  function boundRoom(chatRoomId, sessionKey, { mustBeJoined = true } = {}) {
    if (!chatRoomId || typeof chatRoomId !== 'string') return { err: { status: 400, body: { error: 'room_id is required' } } };
    const room = rooms.get(chatRoomId);
    if (!room || room.sessionRoomId !== sessionKey) return { err: { status: 404, body: { error: `not a participant of room ${chatRoomId}` } } };
    if (mustBeJoined && room.state !== 'joined' && room.role !== 'owner') {
      return { err: { status: 409, body: { error: `room ${chatRoomId} is ${room.state} — not joined` } } };
    }
    return { room };
  }

  return {
    async roster(data) {
      const { err } = callerSession(data);
      if (err) return err;
      const r = await publisher.fetchRoster();
      if (!r) return { status: 502, body: { error: 'journal unreachable' } };
      const self = publisher.identity();
      return { status: 200, body: {
        self: self ? { device_id: self.deviceId, name: self.name } : null,
        agents: (r.agents || []).filter((a) => !self || a.device_id !== self.deviceId),
        conversations: (r.conversations || []).map((c) => ({
          id: c.id, title: c.title, session_state: c.session_state,
          summary: c.summary || '', agent_device_id: c.agent_device_id, last_ts: c.last_ts,
        })),
      } };
    },

    async chatStart(data) {
      const { sessionKey, err } = callerSession(data);
      if (err) return err;
      const { target_convo_id: targetConvoId, topic, justification, message } = data;
      if (!targetConvoId || typeof targetConvoId !== 'string') return { status: 400, body: { error: 'target_convo_id is required — pick one from agent_roster' } };
      if (!justification || typeof justification !== 'string') return { status: 400, body: { error: 'justification is required' } };
      if (!message || typeof message !== 'string') return { status: 400, body: { error: 'message is required — the opening message for the room' } };
      const r = await publisher.fetchRoster();
      if (!r) return { status: 502, body: { error: 'journal unreachable' } };
      const target = (r.conversations || []).find((c) => c.id === targetConvoId);
      if (!target) return { status: 404, body: { error: `no conversation ${targetConvoId} in the roster` } };
      if (!Number.isInteger(target.agent_device_id)) return { status: 409, body: { error: 'that conversation has no owning agent to invite' } };
      const self = publisher.identity();
      if (self && target.agent_device_id === self.deviceId) return { status: 400, body: { error: 'that conversation is on this bridge — talk to it directly' } };

      const chatRoomId = randomUUID();
      const targetAgent = (r.agents || []).find((a) => a.device_id === target.agent_device_id);
      const title = `${self?.name || serverLabel || 'agent'} ↔ ${targetAgent?.name || `device ${target.agent_device_id}`}${topic ? ` — ${topic}` : ''}`.slice(0, ROOM_TITLE_MAX);
      publisher.upsertConvo(chatRoomId, { title, sessionState: 'running' });
      publisher.publishText(chatRoomId, { body: message, from: 'agent' });
      rooms.record(chatRoomId, { role: 'owner', state: 'pending', sessionRoomId: sessionKey, peerDeviceId: target.agent_device_id, peerName: targetAgent?.name || null, topic: topic || null, title });

      const outcome = await invites.invite({ roomId: chatRoomId, targetDeviceId: target.agent_device_id, topic, justification });
      return mapStartOutcome(chatRoomId, outcome);
    },

    async chatSend(data) {
      const { sessionKey, err } = callerSession(data);
      if (err) return err;
      const { room_id: chatRoomId, message, wait_seconds: waitSeconds } = data;
      const b = boundRoom(chatRoomId, sessionKey);
      if (b.err) return b.err;
      if (!message || typeof message !== 'string') return { status: 400, body: { error: 'message is required' } };
      publisher.publishText(chatRoomId, { body: message, from: 'agent' });
      // Optional short reply wait: purely convenience — replies always arrive
      // as turns regardless, so a timeout here loses nothing.
      const wait = Math.min(Math.max(Number(waitSeconds) || 0, 0), WAIT_SECONDS_CAP);
      if (wait > 0) {
        const reply = await awaitRoomMessage(chatRoomId, wait * 1000);
        if (reply) return { status: 200, body: { ok: true, reply } };
      }
      return { status: 200, body: { ok: true, note: 'sent — any reply will arrive as a later turn' } };
    },

    async chatAccept(data)  { return answerInvite(data, true); },
    async chatRefuse(data)  { return answerInvite(data, false); },

    async chatJoin(data) {
      const { sessionKey, err } = callerSession(data);
      if (err) return err;
      const { room_id: chatRoomId, justification } = data;
      if (!chatRoomId || typeof chatRoomId !== 'string') return { status: 400, body: { error: 'room_id is required' } };
      if (!justification || typeof justification !== 'string') return { status: 400, body: { error: 'justification is required' } };
      rooms.record(chatRoomId, { role: 'guest', state: 'pending', sessionRoomId: sessionKey });
      const outcome = await invites.join({ roomId: chatRoomId, justification });
      return mapStartOutcome(chatRoomId, outcome);
    },

    async chatLeave(data) {
      const { sessionKey, err } = callerSession(data);
      if (err) return err;
      const { room_id: chatRoomId } = data;
      const b = boundRoom(chatRoomId, sessionKey, { mustBeJoined: false });
      if (b.err) return b.err;
      invites.leave({ roomId: chatRoomId });
      // setState refuses transitions out of terminal states (refused/expired)
      // and returns null there — leaving an already-dead room is still ok.
      rooms.setState(chatRoomId, 'left');
      return { status: 200, body: { ok: true } };
    },

    async chatRead(data) {
      const { sessionKey, err } = callerSession(data);
      if (err) return err;
      const { room_id: chatRoomId, limit } = data;
      const b = boundRoom(chatRoomId, sessionKey, { mustBeJoined: false });
      if (b.err) return b.err;
      const res = await publisher.fetchMessages(chatRoomId, { limit: Math.min(Math.max(Number(limit) || 50, 1), 200) });
      if (!res) return { status: 502, body: { error: 'journal unreachable or read refused' } };
      const messages = (res.events || [])
        .filter((e) => e.type === 'text' || e.type === 'file' || e.type === 'image')
        .map((e) => ({ sender: e.sender, type: e.type, ts: e.ts,
          body: e.type === 'text' ? e.payload?.body : `[${e.type} "${e.payload?.name || 'unnamed'}"]`,
          ...(e.payload?.caption ? { caption: e.payload.caption } : {}) }));
      return { status: 200, body: { room_id: chatRoomId, messages } };
    },
  };

  // Maps an invites.invite()/join() outcome to a tool response. The invites
  // manager maps deliver-window timeouts to pending_quiet itself, so no raw
  // 'timeout' kind ever reaches this switch.
  function mapStartOutcome(chatRoomId, outcome) {
    switch (outcome.kind) {
      case 'accepted':      return { status: 200, body: { room_id: chatRoomId, status: 'accepted' } };
      case 'refused':       return { status: 200, body: { room_id: chatRoomId, status: 'refused', reason: outcome.reason || '' } };
      case 'pending_busy':  return { status: 200, body: { room_id: chatRoomId, status: 'pending_busy', note: 'peer is mid-turn; continue your own work — the answer arrives as a later turn' } };
      case 'pending_idle':
      case 'pending_quiet': return { status: 200, body: { room_id: chatRoomId, status: 'pending', note: 'no answer yet; continue your own work — the answer arrives as a later turn' } };
      case 'error':
        if (outcome.code === 'offline') return { status: 200, body: { room_id: chatRoomId, status: 'offline', error: 'target bridge is offline' } };
        if (outcome.code === 'conflict') return { status: 409, body: { room_id: chatRoomId, error: outcome.detail || 'conflicting invite state' } };
        return { status: 502, body: { room_id: chatRoomId, error: outcome.detail || outcome.code || 'journal error' } };
      default:
        try { log.warn(`[agent-chat] unexpected invite outcome for ${chatRoomId}: ${JSON.stringify(outcome)}`); } catch { }
        return { status: 502, body: { room_id: chatRoomId, error: 'unexpected invite outcome' } };
    }
  }

  async function answerInvite(data, accept) {
    const { sessionKey, err } = callerSession(data);
    if (err) return err;
    const { room_id: chatRoomId, reason } = data;
    const room = rooms.get(chatRoomId);
    if (!room || room.sessionRoomId !== sessionKey) return { status: 404, body: { error: `no pending invite for room ${chatRoomId}` } };
    if (room.state !== 'pending') return { status: 409, body: { error: `room ${chatRoomId} is ${room.state} — nothing to answer` } };
    const ok = invites.answer({
      roomId: chatRoomId,
      // Owner answering a join_request names the requester; a guest answering
      // an invite addressed to itself omits peer_device_id (protocol.md).
      peerDeviceId: room.role === 'owner' ? room.peerDeviceId : null,
      accept, reason,
    });
    // KNOWN v1 GAP (PR #185): sendRoomOp's boolean only proves the frame left
    // the socket — a journal-side rejection of agent_invite_answer (e.g. a
    // server-expired invite) has no correlatable error path back to here, so
    // a false "joined" is possible. Fixing it needs room_id in the journal's
    // fail() frames.
    if (!ok) return { status: 502, body: { error: 'journal unreachable' } };
    rooms.setState(chatRoomId, accept ? 'joined' : 'refused');
    return { status: 200, body: { ok: true, room_id: chatRoomId, ...(accept ? {} : { refused: true }) } };
  }
}
