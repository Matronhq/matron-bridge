// What started a session's turn. The bridge records it when a turn begins —
// the user's message, a tap or reply on a tracker item, a routine firing, a
// room message, a spawn outcome, a reminder — and sends it as `causes` on the
// asks the agent makes during that turn, so the journal can check an ask
// against the thing that actually prompted it rather than taking the agent's
// word for it. Pure helpers only: index.js and the turn routers own the
// session state and call these to build, merge and read it.

// The shared vocabulary with the journal. A kind the journal does not know is
// a bug here, not data, so cause() throws on one rather than sending it.
export const CAUSE_KINDS = [
  'user_message', 'item_reply', 'item_tap', 'routine', 'spawn_outcome',
  'room_message', 'reminder', 'carry_on', 'alert', 'handoff', 'other',
];
const KIND_SET = new Set(CAUSE_KINDS);

// One turn can be started by several things at once (queued messages flushed
// together, a batch of room messages); the journal only needs enough to find
// the one that matters, so the list is capped rather than grown without bound.
export const CAUSES_MAX = 8;
// A ref is an id, never prose; the cap keeps a peer-supplied id (a room id,
// a routine name) from blowing up every ask the turn makes.
export const CAUSE_REF_MAX = 200;

export function cause(kind, ref = null) {
  if (!KIND_SET.has(kind)) throw new Error(`unknown cause kind: ${kind}`);
  const c = { kind };
  if (ref != null) c.ref = String(ref).slice(0, CAUSE_REF_MAX);
  c.at = Date.now();
  return c;
}

export function userMessageCause(convoId, seq) {
  return cause('user_message', `${convoId}:${seq}`);
}

// The label the user tapped, if the comment is a one-tap reply. It lives on
// the COMMENT (`comment.action`, or `comment.meta.action` from a journal a
// version behind) — the same rule as lib/items-turn.js's tappedLabel. The
// marker's own `payload.action` is the event verb ('commented', 'created'…),
// a string on every marker, so it cannot tell a tap from a typed reply.
function isTap(comment) {
  if (!comment || typeof comment !== 'object') return false;
  if (typeof comment.action === 'string' && comment.action.trim()) return true;
  const meta = comment.meta;
  return !!(meta && typeof meta === 'object' && typeof meta.action === 'string' && meta.action.trim());
}

// ref `item:<num>@<created_at>` names the exact comment the journal can look
// up (the item number plus the comment's created_at, in ms, as item_get prints
// it). Without both there is nothing to look up, so there is no cause.
export function itemCause(payload) {
  if (!payload || typeof payload !== 'object') return null;
  const num = payload.num;
  const createdAt = payload.comment?.created_at;
  if (!Number.isInteger(num) || typeof createdAt !== 'number' || !Number.isFinite(createdAt)) return null;
  const d = new Date(createdAt);
  if (Number.isNaN(d.getTime())) return null;
  return cause(isTap(payload.comment) ? 'item_tap' : 'item_reply', `item:${num}@${d.toISOString()}`);
}

// firedAt is the journal's own ISO string, passed through untouched so the
// journal matches it byte for byte against its fire log.
export function routineCause({ name, firedAt } = {}) {
  return cause('routine', `routine:${name}@${firedAt}`);
}

export function spawnOutcomeCause(requestId) {
  return cause('spawn_outcome', `spawn:${requestId}`);
}

export function roomMessageCause(roomId) {
  return cause('room_message', `room:${roomId}`);
}

// reminder / carry_on / alert / handoff / other: nothing the journal could
// look up, so the kind alone.
export function plainCause(kind) {
  return cause(kind);
}

// Lists (or single causes) -> one list: flattened one level, falsy and
// malformed entries dropped, deduped by kind+ref keeping the first, capped.
// null when nothing is left, so "no causes" has exactly one shape.
export function mergeCauses(lists) {
  const out = [];
  const seen = new Set();
  for (const entry of Array.isArray(lists) ? lists : []) {
    for (const c of Array.isArray(entry) ? entry : [entry]) {
      if (!c || typeof c !== 'object' || !KIND_SET.has(c.kind)) continue;
      const key = `${c.kind}\0${c.ref ?? ''}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(c);
      if (out.length >= CAUSES_MAX) return out;
    }
  }
  return out.length ? out : null;
}

// The causes of a session's queued entries (each may carry `cause`), for the
// turn that flushes them together.
export function queueCauses(queued) {
  return mergeCauses((queued || []).map((e) => e?.cause));
}

export function beginTurn(session, causes) {
  session.currentTurn = { causes: mergeCauses([causes]), startedAt: Date.now() };
}

export function endTurn(session) {
  session.currentTurn = null;
}

export function causesForAsk(session) {
  return session?.currentTurn?.causes ?? null;
}
