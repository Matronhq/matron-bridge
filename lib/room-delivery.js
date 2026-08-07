// Hybrid idle/busy delivery of agent-chat room messages into local sessions
// (spec: agent chat phase 3, "Delivery model"). An idle session gets one
// immediate injected turn per room message; a busy session accumulates
// messages in an in-memory pending inbox that is flushed as ONE coalesced
// "room update" turn when the turn ends. The pending inbox is in-memory only
// (same stance as the router's prompt state): a bridge restart loses pending
// room messages, but the room's content is durable in the journal and
// `agent_chat_read` recovers it. Flush makes exactly one delivery attempt —
// messages are NOT re-queued on an injectTurn refusal; the journal is the
// durable copy.
//
// deps:
//   isBusy(session) -> bool                     (reads session.busy)
//   injectTurn(session, text) -> bool           (sendTextToSession skipJournalMirror)
//   log
export function createRoomDelivery({ isBusy, injectTurn, log = console } = {}) {
  // sessionKey -> [{roomId, roomTitle, from, body, at}]
  const pending = new Map();

  function formatOne(m) {
    return `[room "${m.roomTitle || m.roomId}"] ${m.from}: ${m.body}`;
  }

  return {
    deliver(session, sessionKey, m) {
      if (!session || !session.alive) return false;
      if (isBusy(session)) {
        if (!pending.has(sessionKey)) pending.set(sessionKey, []);
        pending.get(sessionKey).push(m);
        return true;
      }
      return injectTurn(session, formatOne(m));
    },
    // Called from every turn-end seam AFTER session.busy goes false and the
    // ordinary busy-queue flush ran (room updates yield to Dan's queued input).
    flush(session, sessionKey) {
      const list = pending.get(sessionKey);
      if (!list || list.length === 0) return false;
      pending.delete(sessionKey);
      if (!session || !session.alive) return false;
      const byRoom = new Map();
      for (const m of list) {
        if (!byRoom.has(m.roomId)) byRoom.set(m.roomId, []);
        byRoom.get(m.roomId).push(m);
      }
      const sections = [...byRoom.values()].map((ms) =>
        [`[room "${ms[0].roomTitle || ms[0].roomId}"] ${ms.length} message${ms.length === 1 ? '' : 's'} while you were working:`,
          ...ms.map((m) => `  ${m.from}: ${m.body}`)].join('\n'));
      return injectTurn(session, sections.join('\n\n'));
    },
    pendingCount(sessionKey) { return pending.get(sessionKey)?.length || 0; },
    dropSession(sessionKey) { pending.delete(sessionKey); },
    carryForward(fromKey, toKey) {
      const list = pending.get(fromKey);
      if (list) { pending.delete(fromKey); pending.set(toKey, list); }
    },
  };
}
