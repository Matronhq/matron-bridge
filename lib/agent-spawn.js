// Parent-side agent spawn (spec: docs/superpowers/specs/
// 2026-08-10-agent-spawn-bridge-capacity-design.md): the bridge half of the
// journal's consent-brokered spawn flow. Two loopback handlers backing the
// agent_boxes / agent_session_start MCP tools, plus the kind:'spawn' frame
// consumer. Correlation is a request_id-keyed waiter map in the
// agent-invites style — armed BEFORE the frame is sent, because a frame
// batch can drain in one tick.

import { randomUUID } from 'crypto';

const TASK_MAX_CHARS = 2000;      // journal SPAWN_TASK_MAX_CHARS
const TOPIC_MAX_CHARS = 200;      // journal INVITE_TOPIC_MAX_CHARS
const WORKDIR_MAX_CHARS = 1024;   // journal SPAWN_WORKDIR_MAX_CHARS

// deps: sessions, publisher, rooms, journalConvoIdFor(session) -> convoId|null,
//       notifyParent({session, convoId, text}), targetsTimeoutMs,
//       pendingTimeoutMs, log
export function createAgentSpawnHandlers({
  sessions,
  publisher,
  rooms,
  journalConvoIdFor = () => null,
  notifyParent = () => {},
  targetsTimeoutMs = 10000,
  pendingTimeoutMs = 10000,
  log = console,
} = {}) {
  const waiters = new Map();        // request_id -> {resolve, timer}
  const pendingSpawns = new Map();  // spawn_id -> {sessionKey, convoId, task, topic} | HANDLED

  // Sentinel left in pendingSpawns once an outcome for a spawn id has been
  // notified — a duplicate outcome frame (the journal at-most-once but the
  // wire is not) must produce no second notifyParent. A plain delete can't
  // tell "already handled" apart from "never tracked" (bridge restarted
  // between the ack and the outcome, so the context never existed): both
  // read back as absent. The set only grows with spawn ids this bridge
  // itself acked or that the journal genuinely reported an outcome for —
  // bounded by real spawn/outcome volume, not attacker-controlled.
  const HANDLED = Symbol('handled');

  const await_ = (requestId, timeoutMs) => new Promise((resolve) => {
    const timer = setTimeout(() => { waiters.delete(requestId); resolve({ kind: 'timeout' }); }, timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();
    waiters.set(requestId, { resolve, timer });
  });
  const settle = (requestId, value) => {
    const w = waiters.get(requestId);
    if (!w) return false;
    waiters.delete(requestId);
    clearTimeout(w.timer);
    w.resolve(value);
    return true;
  };

  function callerSession(data) {
    const { roomId } = data || {};
    if (!roomId || typeof roomId !== 'string') return { err: { status: 400, body: { error: 'roomId is required' } } };
    const session = sessions.get(roomId);
    if (!session) return { err: { status: 404, body: { error: `no active session for chat ${roomId}` } } };
    return { session, sessionKey: roomId };
  }

  // Single-line summary published into the parent's session convo when a
  // spawn resolves. `ctx` may be null (bridge restarted between the ack and
  // the outcome frame — the pendingSpawns entry didn't survive), in which
  // case there is no task to prefix. Frame fields are journal-sanitized, but
  // sliced defensively anyway — peer discipline.
  function describeOutcome(frame, ctx) {
    const id = frame.request_id;
    const prefix = ctx && typeof ctx.task === 'string' ? `"${ctx.task.slice(0, 60)}" — ` : '';
    switch (frame.outcome) {
      case 'started':
        return `🚀 Spawn ${id}: ${prefix}session started on the target box. Chat room ${frame.room_id} is the channel; the child was seeded with your task and will report there. Child conversation: ${frame.child_convo_id}.`;
      case 'declined':
        return `🚫 Spawn ${id}: ${prefix}the user declined the request.`;
      case 'expired':
        return `⌛ Spawn ${id}: ${prefix}the request expired unanswered (24h).`;
      case 'failed':
        return `❌ Spawn ${id}: ${prefix}failed (${frame.error_code || 'unknown'}).`;
      default:
        return `Spawn ${id}: ${prefix}${frame.outcome}.`;
    }
  }

  function handleOutcome(frame) {
    const entry = pendingSpawns.get(frame.request_id);
    // Already notified for this spawn id — a duplicate frame is a no-op.
    if (entry === HANDLED) return;
    const ctx = entry || null;
    // Tombstone BEFORE notifying — exactly-once surfacing: a duplicate
    // outcome frame for the same spawn id finds HANDLED, not the context,
    // and returns above without a second notifyParent.
    pendingSpawns.set(frame.request_id, HANDLED);
    if (!ctx) {
      notifyParent({ session: null, convoId: null, text: describeOutcome(frame, null) });
      return;
    }
    const session = sessions.get(ctx.sessionKey) || null;
    if (frame.outcome === 'started' && typeof frame.room_id === 'string' && frame.room_id) {
      // Registry write must not swallow the notify below.
      try {
        rooms.record(frame.room_id, {
          role: 'owner',
          state: 'joined',
          sessionRoomId: ctx.sessionKey,
          topic: ctx.topic,
          title: ctx.topic || (ctx.task || '').slice(0, 80),
        });
      } catch (e) {
        try { log.warn(`[agent-spawn] rooms.record failed: ${e.message}`); } catch { }
      }
    }
    notifyParent({ session, convoId: ctx.convoId, text: describeOutcome(frame, ctx) });
  }

  return {
    async boxes(data) {
      const { err } = callerSession(data);
      if (err) return err;
      if (!publisher.identity()) {
        return { status: 409, body: { error: 'journal identity unknown; try again shortly' } };
      }
      const rid = randomUUID();
      const p = await_(rid, targetsTimeoutMs);
      if (!publisher.sendRoomOp({ op: 'spawn_targets', request_id: rid })) {
        settle(rid, { kind: 'discarded' });
        return { status: 502, body: { error: 'journal unreachable' } };
      }
      const r = await p;
      if (r.kind === 'timeout') return { status: 504, body: { error: 'timed out waiting for the journal' } };
      if (r.kind === 'op_error') return { status: 502, body: { error: r.detail || r.code || 'journal error', code: r.code } };
      return { status: 200, body: { boxes: r.boxes } };
    },

    async sessionStart(data) {
      const { session, err } = callerSession(data);
      if (err) return err;
      const { device_id: deviceId, workdir, task, topic } = data || {};
      if (!Number.isInteger(deviceId)) return { status: 400, body: { error: 'device_id must be an integer' } };
      if (typeof workdir !== 'string' || !workdir || workdir.length > WORKDIR_MAX_CHARS) {
        return { status: 400, body: { error: `workdir is required and must be at most ${WORKDIR_MAX_CHARS} characters` } };
      }
      if (typeof task !== 'string' || !task || task.length > TASK_MAX_CHARS) {
        return { status: 400, body: { error: `task is required and must be at most ${TASK_MAX_CHARS} characters` } };
      }
      if (topic !== undefined && (typeof topic !== 'string' || topic.length > TOPIC_MAX_CHARS)) {
        return { status: 400, body: { error: `topic must be a string of at most ${TOPIC_MAX_CHARS} characters` } };
      }
      const fromConvoId = journalConvoIdFor(session);
      if (!fromConvoId) return { status: 409, body: { error: 'session has no journal conversation yet' } };

      const rid = randomUUID();
      const p = await_(rid, pendingTimeoutMs);
      const frame = {
        op: 'spawn_request',
        request_id: rid,
        from_convo_id: fromConvoId,
        target_device_id: deviceId,
        workdir,
        task,
        ...(topic ? { topic } : {}),
      };
      if (!publisher.sendRoomOp(frame)) {
        settle(rid, { kind: 'discarded' });
        return { status: 502, body: { error: 'journal unreachable' } };
      }
      const r = await p;
      if (r.kind === 'timeout') return { status: 504, body: { error: 'timed out waiting for the journal' } };
      if (r.kind === 'op_error') {
        if (r.code === 'conflict') return { status: 409, body: { error: r.detail || 'conflicting spawn state' } };
        if (r.code === 'agent_unreachable') return { status: 502, body: { error: 'target box is offline' } };
        if (r.code === 'not_found') return { status: 404, body: { error: r.detail || 'target not found' } };
        return { status: 502, body: { error: r.detail || r.code || 'journal error' } };
      }
      if (r.kind === 'pending' && r.spawnId) {
        pendingSpawns.set(r.spawnId, { sessionKey: data.roomId, convoId: fromConvoId, task, topic: topic || '' });
        return { status: 200, body: { status: 'pending', spawn_id: r.spawnId } };
      }
      // 'pending' with a null spawnId — malformed ack; treat like a journal error.
      return { status: 502, body: { error: 'journal returned a malformed spawn ack' } };
    },

    onSpawnFrame(frame) {
      if (!frame || frame.kind !== 'spawn' || typeof frame.event !== 'string') return;
      if (frame.event === 'targets') {
        settle(frame.request_id, { kind: 'targets', boxes: Array.isArray(frame.boxes) ? frame.boxes : [] });
        return;
      }
      if (frame.event === 'pending') {
        settle(frame.request_id, { kind: 'pending', spawnId: typeof frame.spawn_id === 'string' ? frame.spawn_id : null });
        return;
      }
      if (frame.event === 'outcome') {
        handleOutcome(frame);
        return;
      }
    },

    onOpError({ code, ref, detail } = {}) {
      if (typeof ref !== 'string') return false;
      return settle(ref, { kind: 'op_error', code, detail });
    },
  };
}
