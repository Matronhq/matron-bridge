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

import { oneLine, quotedField } from './peer-text.js';

// Per-session-key cap on the pending inbox: a chatty peer must not grow an
// unbounded coalesced turn. Oldest messages are evicted first and surfaced
// as an "omitted" line per room; the journal keeps the full history.
const MAX_PENDING = 50;

export function createRoomDelivery({ isBusy, injectTurn, log = console } = {}) {
  // sessionKey -> [{roomId, roomTitle, from, body}]
  const pending = new Map();
  // sessionKey -> Map(roomId -> count of messages evicted by the MAX_PENDING cap)
  const dropped = new Map();

  // Room titles/ids/senders/bodies are untrusted peer input pasted into a
  // line-structured format: flatten every interpolated field to exactly one
  // line so no message can forge a `[room "..."]` header or another sender's
  // line. The flattener itself lives in lib/peer-text.js so the user-facing
  // notices (which have the same forgery problem, in Dan's chat rather than
  // the agent's turn) share ONE implementation.
  //
  // Flattening is not enough for the fields rendered INSIDE quotes (the room
  // title, and the room id in the omitted-messages hint): a `"` there closes
  // the segment and forges the rest of the line, so those go through
  // quotedField. The sender gets it too — it cannot break out of a segment it
  // is not in, but escaping it costs nothing and makes the invariant total and
  // checkable: a rendered header line carries exactly TWO unescaped quotes,
  // its own delimiters.
  //
  // The body deliberately does NOT: it is the message content, it sits at the
  // tail of its own line outside any quoted segment, and escaping every quote
  // in it would corrupt quoted prose and code for no structural gain — a body
  // can neither start a line nor close a delimiter, so header-shaped text in
  // one is visibly mid-line, after a legitimate `sender: ` prefix.

  function formatOne(m) {
    return `[room "${quotedField(m.roomTitle || m.roomId)}"] ${quotedField(m.from || 'unknown')}: ${oneLine(m.body)}`;
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
        const lines = [`[room "${quotedField(ms[ms.length - 1].roomTitle || roomId)}"] ${ms.length} message${ms.length === 1 ? '' : 's'} while you were working:`];
        if (omitted) lines.push(`  … ${omitted} earlier message(s) omitted — use agent_chat_read("${quotedField(roomId)}")`);
        for (const m of ms) lines.push(`  ${quotedField(m.from || 'unknown')}: ${oneLine(m.body)}`);
        return lines.join('\n');
      });
      return tryInject(session, sections.join('\n\n'), [...byRoom.keys()], list.length);
    },
    pendingCount(sessionKey) { return pending.get(sessionKey)?.length || 0; },
    dropSession(sessionKey) { pending.delete(sessionKey); dropped.delete(sessionKey); },
  };
}
