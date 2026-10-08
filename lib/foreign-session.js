// The stateful half of foreign turns (lib/foreign-turn.js is the pure
// policy): which session is in a turn another person started, the one-shot
// approvals its user granted, the "Allow once" asks waiting on a tap, and the
// person-room context the journal gives each room. Everything I/O-shaped is
// injected so this is testable without a journal or a claude process.
//
// deps:
//   sharing.personRoom(roomId) -> {status, data:{person_room}}
//   items.get(id) / items.create(body) / items.close(id, body) -> {status, data}
//   journalConvoIdFor(session) -> convo id the session publishes into
//   sendText(session, text) -> bool       (inject a turn, skipJournalMirror)
//   publishNotice(convoId, text)
//   isOccupied(session) -> bool           (busy / prompt open)
//   flag: { set(roomKey), clear(roomKey) } (set throws when it cannot write)
//   store: { load() -> object, save(object) }  (pending asks, survives restarts)
//   now() -> ms
import {
  decideForeignCall, foreignRouteAllowed, foreignTurnBanner, allowanceTurnText, actionRequestItem, actionHash,
} from './foreign-turn.js';

// An "Allow once" item nobody tapped is forgotten after a week.
export const ACTION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
// A room's person-room context is re-read at most this often.
const CONTEXT_TTL_MS = 30_000;

export const ALLOW_LABEL = 'Allow once';
export const DECLINE_LABEL = 'Decline';

export function createForeignSessions({ sharing, items, journalConvoIdFor, sendText, publishNotice, isOccupied, flag, store, now = Date.now, log = console } = {}) {
  // journal room id -> {at, row|null}
  const contexts = new Map();
  // session roomKey -> {allow: Map(hash -> itemId), parked: [{turn, text, hash?, itemId}], routeOnce: number}
  const perSession = new Map();
  let pending = loadPending();

  const state = (key) => {
    if (!perSession.has(key)) perSession.set(key, { allow: new Map(), parked: [], routeOnce: 0 });
    return perSession.get(key);
  };

  function loadPending() {
    let raw;
    try { raw = store?.load?.() || {}; } catch { raw = {}; }
    const out = new Map();
    const cutoff = now() - ACTION_TTL_MS;
    for (const [id, v] of Object.entries(raw)) {
      if (v && typeof v === 'object' && v.createdAt > cutoff) out.set(id, v);
    }
    return out;
  }
  function savePending() {
    try { store?.save?.(Object.fromEntries(pending)); } catch (e) { try { log.warn(`[foreign] saving pending asks failed: ${e.message}`); } catch { } }
  }

  // The person-room row for a journal room, as the journal sees it now.
  // Cached briefly; a failed read leaves the turn at its narrowest (room
  // only), never wider.
  async function refreshContext(roomId) {
    try {
      const r = await sharing.personRoom(roomId);
      const row = r?.status === 200 ? (r.data?.person_room ?? null) : null;
      contexts.set(roomId, { at: now(), row });
      return row;
    } catch {
      contexts.set(roomId, { at: now(), row: null });
      return null;
    }
  }
  async function contextFor(roomId) {
    const c = contexts.get(roomId);
    if (c && now() - c.at < CONTEXT_TTL_MS) return c.row;
    return refreshContext(roomId);
  }

  // The turn object the gate decides on. `person` comes from the frame (the
  // journal's own stamp); role and mission from the person-room row.
  function turnFor(roomId, person, row) {
    const mission = row?.mission && Number.isInteger(row.mission.num) ? { id: row.mission.id, num: row.mission.num, owner: row.mission.owner, title: row.mission.title } : null;
    return { roomId, person, role: row?.role === 'owner' ? 'owner' : 'guest', mission };
  }

  function begin(session, turn) {
    try { flag.set(session.roomId); } catch (e) {
      try { log.warn(`[foreign] could not arm the gate for ${session.roomId}: ${e.message} — not delivering`); } catch { }
      return false;
    }
    session.foreignTurn = turn;
    return true;
  }

  function end(session) {
    if (!session) return;
    if (session.foreignTurn) {
      session.foreignTurn = null;
      const st = perSession.get(session.roomId);
      if (st) { st.allow.clear(); st.routeOnce = 0; }
    }
    // Cleared even without a turn on record: a flag left by a previous
    // process must never outlive the turn it was for.
    try { flag.clear(session.roomId); } catch { }
  }

  // Inject one foreign turn: arm the gate, then send. A send the session
  // refuses disarms again.
  function inject(session, text, turn) {
    if (!begin(session, turn)) return false;
    let ok;
    try { ok = sendText(session, `${foreignTurnBanner(turn)}\n${text}`); } catch { ok = false; }
    if (!ok) end(session);
    return ok;
  }

  return {
    refreshContext,
    contextFor,
    // The last context read for a room, synchronously (null when never read
    // or the read failed: the narrowest turn).
    cachedContext: (roomId) => contexts.get(roomId)?.row ?? null,
    turnFor,
    begin,
    end,
    inject,

    // POST /foreign-check: the hook's question for one tool call.
    async check(session, hookInput) {
      const turn = session?.foreignTurn;
      if (!turn) return { decision: 'allow' };
      const st = state(session.roomId);
      const d = await decideForeignCall({
        turn,
        toolName: hookInput?.tool_name,
        toolInput: hookInput?.tool_input,
        allowances: st.allow,
        lookupItem: async (id) => {
          const r = await items.get(id);
          return r?.status === 200 ? (r.data?.item ?? null) : null;
        },
      });
      if (d.decision === 'allow' && d.consume) {
        st.allow.delete(d.consume);
        // The approved call may be one of the bridge's own routes: let the
        // next one through the route layer, once.
        st.routeOnce += 1;
      }
      return d;
    },

    // The route layer's question (index.js, before dispatching an ask-user
    // route).
    routeAllowed(session, pathname, data) {
      const turn = session?.foreignTurn;
      if (!turn) return true;
      if (foreignRouteAllowed(turn, pathname, data)) return true;
      const st = state(session.roomId);
      if (st.routeOnce > 0) { st.routeOnce -= 1; return true; }
      return false;
    },

    // foreign_action_request: file the "Allow once" item for the user.
    async requestAction(session, { tool_name: toolName, tool_input: toolInput, why }) {
      const turn = session?.foreignTurn;
      if (!turn) return { status: 409, body: { error: 'Only needed in a turn another person started. In your own user\'s turns, just make the call.' } };
      if (typeof toolName !== 'string' || !toolName || toolName.length > 200) return { status: 400, body: { error: 'tool_name is required' } };
      if (toolInput != null && typeof toolInput !== 'object') return { status: 400, body: { error: 'tool_input must be an object' } };
      const spec = actionRequestItem({ turn, toolName, toolInput: toolInput ?? {}, why });
      const convoId = journalConvoIdFor(session);
      const r = await items.create({ ...spec, convo_id: convoId, awaiting: 'user', position: 'top' });
      const item = r?.data?.item;
      if (!(r?.status >= 200 && r.status < 300) || !item?.id) {
        return { status: 502, body: { error: `could not file the request: ${r?.data?.error ?? 'journal unreachable'}` } };
      }
      pending.set(item.id, {
        roomKey: session.roomId, toolName, toolInput: toolInput ?? {}, hash: actionHash(toolName, toolInput ?? {}),
        why: typeof why === 'string' ? why.slice(0, 1000) : '', turn, num: item.num ?? null, createdAt: now(),
      });
      savePending();
      return { status: 200, body: { ok: true, item: item.num != null ? `#${item.num}` : item.id, note: 'Filed for your user. Tell the other side you have asked; if your user allows it, you get a turn to make exactly that call.' } };
    },

    // A user marker on an item. Returns true when it was an answer to an
    // "Allow once" ask and has been handled here (no 📌 turn for it).
    onItemReply(session, payload) {
      const id = payload?.item_id;
      if (typeof id !== 'string' || !pending.has(id)) return false;
      if (payload.action !== 'commented') return false;
      const label = typeof payload.comment?.action === 'string' ? payload.comment.action.trim()
        : (typeof payload.comment?.meta?.action === 'string' ? payload.comment.meta.action.trim() : null);
      // Typed prose on the item is the user talking to their own agent: an
      // ordinary 📌 turn, and the ask stays open for a tap.
      if (label !== ALLOW_LABEL && label !== DECLINE_LABEL) return false;
      const ask = pending.get(id);
      pending.delete(id);
      savePending();
      const allowIt = label === ALLOW_LABEL;
      Promise.resolve(items.close(id, { resolution: 'answered', comment: allowIt ? 'Allowed once.' : 'Declined.' })).catch(() => {});
      const st = state(session.roomId);
      const text = allowanceTurnText(ask.turn, { toolName: ask.toolName, decision: allowIt ? 'allow' : 'decline', why: ask.why });
      // Answers queue: a second tap while the session is busy must not
      // overwrite the first (its item is already closed).
      st.parked.push({ turn: ask.turn, text, hash: allowIt ? ask.hash : null, itemId: id });
      this.drainParked(session);
      return true;
    },

    // Start the oldest parked continuation when the session is free, one
    // per turn. Returns true when a turn started.
    drainParked(session) {
      const st = perSession.get(session?.roomId);
      if (!st?.parked.length || isOccupied(session)) return false;
      const p = st.parked.shift();
      if (!begin(session, p.turn)) return false;
      if (p.hash) st.allow.set(p.hash, p.itemId);
      let ok;
      try { ok = sendText(session, p.text); } catch { ok = false; }
      if (!ok) {
        end(session);
        try { publishNotice(journalConvoIdFor(session), '⚠️ Could not hand your answer to the agent — the session is not available. Nothing ran.'); } catch { }
      }
      return ok;
    },

    hasParked: (session) => !!perSession.get(session?.roomId)?.parked.length,
    pendingCount: () => pending.size,
  };
}
