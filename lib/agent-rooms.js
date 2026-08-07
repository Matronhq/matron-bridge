// Persisted registry of agent-chat rooms this bridge participates in.
// A "room" here is a journal conversation (top-level UUID) plus this
// bridge's relationship to it: which local session it is bound to, whether
// we created it (owner) or were invited (guest), and where the invite
// lifecycle stands. Survives restarts so room delivery resumes (spec:
// agent chat phase 3, "Room↔session mapping persisted to disk").
export function createAgentRooms({ load, save, log = console } = {}) {
  let rooms = {};
  try { rooms = load?.() || {}; } catch { rooms = {}; }
  if (typeof rooms !== 'object' || rooms === null || Array.isArray(rooms)) rooms = {};

  function persist() {
    try { save?.(rooms); } catch (e) { try { log.warn(`[agent-rooms] persist failed: ${e.message}`); } catch { } }
  }

  return {
    // role: 'owner'|'guest'; state: 'pending'|'joined'|'refused'|'left'|'expired'
    record(roomId, { role, state, sessionRoomId, peerDeviceId = null, peerName = null, topic = null, title = null }) {
      rooms[roomId] = {
        ...rooms[roomId],
        role, state, sessionRoomId,
        peerDeviceId, peerName, topic, title,
        updatedAt: Date.now(),
        createdAt: rooms[roomId]?.createdAt ?? Date.now(),
      };
      persist();
      return rooms[roomId];
    },
    setState(roomId, state) {
      if (!rooms[roomId]) return null;
      rooms[roomId] = { ...rooms[roomId], state, updatedAt: Date.now() };
      persist();
      return rooms[roomId];
    },
    rebindSession(fromSessionRoomId, toSessionRoomId) {
      // Session respawn carry-forward (same reason as queueRelease.carryForward).
      let n = 0;
      for (const [id, r] of Object.entries(rooms)) {
        if (r.sessionRoomId === fromSessionRoomId) { rooms[id] = { ...r, sessionRoomId: toSessionRoomId }; n++; }
      }
      if (n) persist();
      return n;
    },
    get(roomId) { return rooms[roomId] || null; },
    isActive(roomId) {
      const r = rooms[roomId];
      return !!r && (r.state === 'joined' || r.state === 'pending');
    },
    forSession(sessionRoomId) {
      return Object.entries(rooms)
        .filter(([, r]) => r.sessionRoomId === sessionRoomId)
        .map(([id, r]) => ({ roomId: id, ...r }));
    },
    remove(roomId) { if (rooms[roomId]) { delete rooms[roomId]; persist(); } },
    list() { return Object.entries(rooms).map(([id, r]) => ({ roomId: id, ...r })); },
  };
}
