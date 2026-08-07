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

// The journal's own invite-field caps (matron-journal src/ws.js
// INVITE_TOPIC_MAX_CHARS / INVITE_TEXT_MAX_CHARS). The journal REJECTS
// over-length fields with bad_request, so clamp client-side — before any
// side effect — instead of letting a long topic strand a half-created room.
const INVITE_TOPIC_MAX_CHARS = 200;
const INVITE_TEXT_MAX_CHARS = 1000;

// Shared participant/state gate for room-scoped operations — exported so
// lib/send-attachment.js applies the EXACT same rules (one fix site, not
// two). Returns null when access is allowed, else an {status, body} error.
// modes:
//   'send' (default): posting into the room. Requires state 'joined', or an
//     owner whose room is still 'pending' (post-chatStart, pre-accept). An
//     owner who left, was refused, or expired may NOT keep posting — the
//     owner exemption exists only for the pending window.
//   'read': transcript read. Requires PROVEN membership: owner, joined, or
//     'left' (post-leave catch-up). A never-joined pending/refused/expired
//     binding gets the same 404 as a stranger — a speculative chatJoin
//     record must never unlock another convo's transcript.
//   'any': just the participant binding (chatLeave).
export function roomAccessError(rooms, chatRoomId, sessionRoomId, { mode = 'send' } = {}) {
  if (!chatRoomId || typeof chatRoomId !== 'string') return { status: 400, body: { error: 'room_id is required' } };
  const room = rooms?.get(chatRoomId) || null;
  if (!room || room.sessionRoomId !== sessionRoomId) return { status: 404, body: { error: `not a participant of room ${chatRoomId}` } };
  if (mode === 'send' && room.state !== 'joined' && !(room.role === 'owner' && room.state === 'pending')) {
    return { status: 409, body: { error: `room ${chatRoomId} is ${room.state} — not joined` } };
  }
  if (mode === 'read' && room.role !== 'owner' && room.state !== 'joined' && room.state !== 'left') {
    return { status: 404, body: { error: `not a participant of room ${chatRoomId}` } };
  }
  return null;
}

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

  function boundRoom(chatRoomId, sessionKey, opts) {
    const err = roomAccessError(rooms, chatRoomId, sessionKey, opts);
    if (err) return { err };
    return { room: rooms.get(chatRoomId) };
  }

  return {
    async roster(data) {
      const { err } = callerSession(data);
      if (err) return err;
      const r = await publisher.fetchRoster();
      if (!r) return { status: 502, body: { error: 'journal unreachable' } };
      const self = publisher.identity();
      // Fail CLOSED on unknown identity (global constraint 8): without our
      // own device id we can't exclude ourselves, and a self-entry here is a
      // self-invite trap. Conversations stay listed (informational only —
      // chatStart independently refuses to run without identity).
      return { status: 200, body: {
        self: self ? { device_id: self.deviceId, name: self.name } : null,
        ...(self ? {} : { note: 'own identity unknown (no hello_ok yet) — agent list withheld' }),
        agents: self ? (r.agents || []).filter((a) => a.device_id !== self.deviceId) : [],
        conversations: (r.conversations || []).map((c) => ({
          id: c.id, title: c.title, session_state: c.session_state,
          summary: c.summary || '', agent_device_id: c.agent_device_id, last_ts: c.last_ts,
        })),
      } };
    },

    async chatStart(data) {
      const { sessionKey, err } = callerSession(data);
      if (err) return err;
      const { target_convo_id: targetConvoId, justification, message } = data;
      if (!targetConvoId || typeof targetConvoId !== 'string') return { status: 400, body: { error: 'target_convo_id is required — pick one from agent_roster' } };
      if (!justification || typeof justification !== 'string') return { status: 400, body: { error: 'justification is required' } };
      if (!message || typeof message !== 'string') return { status: 400, body: { error: 'message is required — the opening message for the room' } };
      // Type/length discipline BEFORE any side effect: the journal rejects
      // over-length topic/justification with bad_request, which would strand
      // a just-created room; a non-string topic would render
      // "[object Object]" into the user's chat list via the title.
      if (data.topic !== undefined && typeof data.topic !== 'string') return { status: 400, body: { error: 'topic must be a string' } };
      const topic = data.topic ? data.topic.slice(0, INVITE_TOPIC_MAX_CHARS) : data.topic;
      const cleanJustification = justification.slice(0, INVITE_TEXT_MAX_CHARS);
      const r = await publisher.fetchRoster();
      if (!r) return { status: 502, body: { error: 'journal unreachable' } };
      const target = (r.conversations || []).find((c) => c.id === targetConvoId);
      if (!target) return { status: 404, body: { error: `no conversation ${targetConvoId} in the roster` } };
      if (!Number.isInteger(target.agent_device_id)) return { status: 409, body: { error: 'that conversation has no owning agent to invite' } };
      const self = publisher.identity();
      // Fail CLOSED on unknown identity: without our own device id the
      // self-target guard below can't run, and a self-invite would wedge.
      if (!self) return { status: 503, body: { error: 'own identity unknown yet (no hello_ok from the journal) — cannot safely start an agent chat; try again shortly' } };
      if (target.agent_device_id === self.deviceId) return { status: 400, body: { error: 'that conversation is on this bridge — talk to it directly' } };

      const chatRoomId = randomUUID();
      const targetAgent = (r.agents || []).find((a) => a.device_id === target.agent_device_id);
      const title = `${self.name || serverLabel || 'agent'} ↔ ${targetAgent?.name || `device ${target.agent_device_id}`}${topic ? ` — ${topic}` : ''}`.slice(0, ROOM_TITLE_MAX);
      publisher.upsertConvo(chatRoomId, { title, sessionState: 'running' });
      publisher.publishText(chatRoomId, { body: message, from: 'agent' });
      rooms.record(chatRoomId, { role: 'owner', state: 'pending', sessionRoomId: sessionKey, peerDeviceId: target.agent_device_id, peerName: targetAgent?.name || null, topic: topic || null, title });

      const outcome = await invites.invite({ roomId: chatRoomId, targetDeviceId: target.agent_device_id, topic, justification: cleanJustification });
      if (outcome.kind === 'error') {
        // The invite never took (journal error/offline): don't leave a ghost
        // "running" one-message convo in the user's list or a registry entry
        // that stays routable for the whole invite TTL.
        rooms.setState(chatRoomId, 'expired');
        publisher.upsertConvo(chatRoomId, { title, sessionState: 'ended' });
      }
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
      // A room already bound to ANOTHER session must not be re-bound:
      // record() merges, so joining a known room id would overwrite its
      // sessionRoomId — locking the real participant out of its own room and
      // rerouting the peer's messages here. Same 404 a stranger gets.
      const prior = rooms.get(chatRoomId);
      if (prior && prior.sessionRoomId !== sessionKey) return { status: 404, body: { error: `not a participant of room ${chatRoomId}` } };
      rooms.record(chatRoomId, { role: 'guest', state: 'pending', sessionRoomId: sessionKey });
      const outcome = await invites.join({ roomId: chatRoomId, justification: justification.slice(0, INVITE_TEXT_MAX_CHARS) });
      // Roll back a speculative binding the journal rejected outright —
      // otherwise the pending entry sticks for the invite TTL and (before
      // chatRead's proven-membership gate, exploitable; still misleading
      // after) shows up as a bound room that never existed.
      if (outcome.kind === 'error' && !prior) rooms.remove(chatRoomId);
      return mapStartOutcome(chatRoomId, outcome);
    },

    async chatLeave(data) {
      const { sessionKey, err } = callerSession(data);
      if (err) return err;
      const { room_id: chatRoomId } = data;
      const b = boundRoom(chatRoomId, sessionKey, { mode: 'any' });
      if (b.err) return b.err;
      // If the leave frame never left the socket the peer was NOT told —
      // marking the room left anyway would report a leave that didn't
      // happen. Keep the state and let the agent retry.
      if (!invites.leave({ roomId: chatRoomId })) {
        return { status: 502, body: { error: 'journal unreachable — the peer was not told; try again' } };
      }
      // setState refuses transitions out of terminal states (refused/expired)
      // and returns null there — leaving an already-dead room is still ok.
      rooms.setState(chatRoomId, 'left');
      return { status: 200, body: { ok: true } };
    },

    async chatRead(data) {
      const { sessionKey, err } = callerSession(data);
      if (err) return err;
      const { room_id: chatRoomId, limit } = data;
      // 'read' demands PROVEN membership (owner / joined / left — the last
      // for post-leave catch-up). A pending binding is NOT proof: chatJoin
      // records speculatively before the journal answers, and this bridge's
      // device authorization on the journal side covers every convo it owns
      // — so an unproven binding here would be a cross-session transcript
      // read (spec invariant: no cross-agent transcript reads in v1).
      const b = boundRoom(chatRoomId, sessionKey, { mode: 'read' });
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
    // Same wire discipline as chatStart's topic: the journal bad_requests an
    // over-length reason, which would fail the whole answer.
    if (reason !== undefined && typeof reason !== 'string') return { status: 400, body: { error: 'reason must be a string' } };
    const room = rooms.get(chatRoomId);
    if (!room || room.sessionRoomId !== sessionKey) return { status: 404, body: { error: `no pending invite for room ${chatRoomId}` } };
    if (room.state !== 'pending') return { status: 409, body: { error: `room ${chatRoomId} is ${room.state} — nothing to answer` } };
    const ok = invites.answer({
      roomId: chatRoomId,
      // Owner answering a join_request names the requester; a guest answering
      // an invite addressed to itself omits peer_device_id (protocol.md).
      peerDeviceId: room.role === 'owner' ? room.peerDeviceId : null,
      accept, reason: reason ? reason.slice(0, INVITE_TEXT_MAX_CHARS) : reason,
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
