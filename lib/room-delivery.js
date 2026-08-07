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

// Per-session-key cap on the pending inbox: a chatty peer must not grow an
// unbounded coalesced turn. Oldest messages are evicted first and surfaced
// as an "omitted" line per room; the journal keeps the full history.
const MAX_PENDING = 50;

export function createRoomDelivery({ isBusy, injectTurn, log = console } = {}) {
  // sessionKey -> [{roomId, roomTitle, from, body}]
  const pending = new Map();
  // sessionKey -> Map(roomId -> count of messages evicted by the MAX_PENDING cap)
  const dropped = new Map();

  // Room bodies/senders are untrusted peer input pasted into a line-structured
  // format: flatten every interpolated field to exactly one line so no message
  // can forge a `[room "..."]` header or another sender's line.
  const oneLine = (s) => String(s ?? '').replace(/\s*\r?\n\s*/g, ' ⏎ ');

  function formatOne(m) {
    return `[room "${oneLine(m.roomTitle || m.roomId)}"] ${oneLine(m.from || 'unknown')}: ${oneLine(m.body)}`;
  }

  // One-attempt injection: never throws (injectTurn is real PTY/journal work),
  // warns with room ids + dropped count when the attempt is lost.
  function tryInject(session, text, roomIds, count) {
    let ok = false;
    try { ok = injectTurn(session, text); }
    catch (e) { try { log.warn(`[room-delivery] injectTurn threw: ${e.message}`); } catch { } }
    if (!ok) {
      try { log.warn(`[room-delivery] dropped ${count} message(s) for room(s) ${roomIds.join(', ')} (inject failed; journal has the copy)`); } catch { }
    }
    return ok;
  }

  return {
    deliver(session, sessionKey, m) {
      if (!session || !session.alive) return false;
      if (isBusy(session)) {
        if (!pending.has(sessionKey)) pending.set(sessionKey, []);
        const list = pending.get(sessionKey);
        list.push(m);
        while (list.length > MAX_PENDING) {
          const evicted = list.shift();
          if (!dropped.has(sessionKey)) dropped.set(sessionKey, new Map());
          const perRoom = dropped.get(sessionKey);
          perRoom.set(evicted.roomId, (perRoom.get(evicted.roomId) || 0) + 1);
        }
        return true;
      }
      return tryInject(session, formatOne(m), [m.roomId], 1);
    },
    // Called from every turn-end seam AFTER session.busy goes false and the
    // ordinary busy-queue flush ran (room updates yield to Dan's queued input).
    flush(session, sessionKey) {
      const list = pending.get(sessionKey);
      const droppedByRoom = dropped.get(sessionKey);
      pending.delete(sessionKey);
      dropped.delete(sessionKey);
      if (!list || list.length === 0) return false;
      if (!session || !session.alive) return false;
      const byRoom = new Map();
      for (const m of list) {
        if (!byRoom.has(m.roomId)) byRoom.set(m.roomId, []);
        byRoom.get(m.roomId).push(m);
      }
      const sections = [...byRoom.entries()].map(([roomId, ms]) => {
        const omitted = droppedByRoom?.get(roomId) || 0;
        const lines = [`[room "${oneLine(ms[ms.length - 1].roomTitle || roomId)}"] ${ms.length} message${ms.length === 1 ? '' : 's'} while you were working:`];
        if (omitted) lines.push(`  … ${omitted} earlier message(s) omitted — use agent_chat_read("${oneLine(roomId)}")`);
        for (const m of ms) lines.push(`  ${oneLine(m.from || 'unknown')}: ${oneLine(m.body)}`);
        return lines.join('\n');
      });
      return tryInject(session, sections.join('\n\n'), [...byRoom.keys()], list.length);
    },
    pendingCount(sessionKey) { return pending.get(sessionKey)?.length || 0; },
    dropSession(sessionKey) { pending.delete(sessionKey); dropped.delete(sessionKey); },
  };
}
