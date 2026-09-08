// Loopback handlers behind the item_* MCP tools (spec: Agent tools).
// HTTP-agnostic, same {status, body} contract as lib/agent-chat.js and
// lib/send-attachment.js; index.js mounts them with respondAgentChatRoute.
const KINDS = new Set(['task', 'question', 'decision']);
const RESOLUTIONS = new Set(['done', 'answered', 'decided', 'reversed', 'cancelled']);
const AWAITING = new Set(['user', 'agent']);
const TITLE_MAX = 200;
const BODY_MAX = 32768;

const bad = (error) => ({ status: 400, body: { error } });

function passthrough(r) {
  if (r.status === 0) return { status: 502, body: { error: 'journal unreachable' } };
  return { status: r.status, body: r.data };
}

// awaiting is nullable (null clears the waiting state), so undefined is the
// only "not provided" sentinel — distinguish it from null explicitly rather
// than with a falsy check.
function validAwaiting(v) {
  return v === null || AWAITING.has(v);
}

export function createItemsHandlers({ sessions, journalConvoIdFor, client, uploadLocalFile }) {
  function callerSession(data) {
    const roomId = data?.roomId;
    if (!roomId || typeof roomId !== 'string') return { err: bad('roomId is required') };
    const session = sessions.get(roomId);
    if (!session) return { err: { status: 404, body: { error: `no active session for chat ${roomId}` } } };
    const convoId = journalConvoIdFor(session);
    if (!convoId) return { err: { status: 409, body: { error: 'journal conversation not established yet — try again shortly' } } };
    return { session, convoId };
  }

  async function uploadAll(session, paths) {
    if (paths === undefined) return { ok: true, attachments: [] };
    if (!Array.isArray(paths) || paths.some((p) => typeof p !== 'string' || !p)) return { ok: false, err: bad('attachments must be an array of file paths') };
    if (paths.length > 20) return { ok: false, err: bad('at most 20 attachments') };
    const out = [];
    for (const p of paths) {
      const r = await uploadLocalFile(session, p);
      if (!r.ok) return { ok: false, err: { status: r.status, body: r.body } };
      out.push({ blob_ref: r.media.blob_ref, mime: r.media.mime, name: r.media.name, size: r.media.size });
    }
    return { ok: true, attachments: out };
  }

  const optStr = (v, name, max) => {
    if (v === undefined) return { ok: true };
    if (typeof v !== 'string' || v.length > max) return { ok: false, err: bad(`${name} must be a string of at most ${max} characters`) };
    return { ok: true };
  };

  const requireId = (data) => (typeof data.id === 'string' && data.id) || Number.isInteger(data.id) ? { ok: true } : { ok: false, err: bad('id is required') };

  return {
    async create(data) {
      const { err, session, convoId } = callerSession(data);
      if (err) return err;
      if (!KINDS.has(data.kind)) return bad("kind must be 'task', 'question' or 'decision'");
      if (typeof data.title !== 'string' || !data.title.trim() || data.title.trim().length > TITLE_MAX) return bad(`title is required (at most ${TITLE_MAX} characters)`);
      const b = optStr(data.body, 'body', BODY_MAX); if (!b.ok) return b.err;
      if (data.awaiting !== undefined && !validAwaiting(data.awaiting)) return bad("awaiting must be 'user', 'agent' or null");
      if (data.position !== undefined && data.position !== 'top' && data.position !== 'bottom') return bad("position must be 'top' or 'bottom'");
      if (data.on_behalf_of !== undefined && data.on_behalf_of !== 'user') return bad("on_behalf_of may only be 'user'");
      const up = await uploadAll(session, data.attachments);
      if (!up.ok) return up.err;
      const body = { kind: data.kind, title: data.title.trim(), convo_id: convoId };
      if (data.body !== undefined) body.body = data.body;
      if (data.labels !== undefined) body.labels = data.labels;
      if (data.links !== undefined) body.links = data.links;
      if (up.attachments.length) body.attachments = up.attachments;
      if (data.awaiting !== undefined) body.awaiting = data.awaiting;
      if (data.position !== undefined) body.position = data.position;
      if (data.supersedes !== undefined) body.supersedes = data.supersedes;
      if (data.on_behalf_of !== undefined) body.on_behalf_of = data.on_behalf_of;
      return passthrough(await client.create(body, { idemKey: typeof data.idem_key === 'string' ? data.idem_key : null }));
    },

    async list(data) {
      const { err, convoId } = callerSession(data);
      if (err) return err;
      const scope = data.scope ?? 'convo';
      if (scope !== 'convo' && scope !== 'all') return bad("scope must be 'convo' or 'all'");
      const state = data.state ?? 'open';
      if (state !== 'open' && state !== 'closed' && state !== 'any') return bad("state must be 'open', 'closed' or 'any'");
      if (data.kind !== undefined && !KINDS.has(data.kind)) return bad('kind is invalid');
      if (data.awaiting !== undefined && !AWAITING.has(data.awaiting)) return bad('awaiting is invalid');
      return passthrough(await client.list({
        convo: scope === 'convo' ? convoId : undefined,
        kind: data.kind, state: state === 'any' ? undefined : state, awaiting: data.awaiting,
        label: data.label, since: data.since, sort: 'rank', limit: data.limit, cursor: data.cursor,
      }));
    },

    async get(data) {
      const { err } = callerSession(data);
      if (err) return err;
      const idOk = requireId(data); if (!idOk.ok) return idOk.err;
      return passthrough(await client.get(data.id));
    },

    async comment(data) {
      const { err, session } = callerSession(data);
      if (err) return err;
      const idOk = requireId(data); if (!idOk.ok) return idOk.err;
      const b = optStr(data.body, 'body', BODY_MAX); if (!b.ok) return b.err;
      if (data.awaiting !== undefined && !validAwaiting(data.awaiting)) return bad("awaiting must be 'user', 'agent' or null");
      const up = await uploadAll(session, data.attachments);
      if (!up.ok) return up.err;
      const text = typeof data.body === 'string' ? data.body : '';
      if (!text.trim() && up.attachments.length === 0) return bad('body or attachments is required');
      const body = { body: text };
      if (up.attachments.length) body.attachments = up.attachments;
      const r = passthrough(await client.comment(data.id, body, { idemKey: typeof data.idem_key === 'string' ? data.idem_key : null }));
      if (data.awaiting !== undefined && (r.status === 200 || r.status === 201)) {
        const ur = await client.update(data.id, { awaiting: data.awaiting });
        if (ur.status !== 200 && ur.status !== 204) {
          r.body = { ...r.body, awaiting_error: ur.status === 0 ? 'journal unreachable' : ur.data?.error };
        }
      }
      return r;
    },

    async close(data) {
      const { err } = callerSession(data);
      if (err) return err;
      const idOk = requireId(data); if (!idOk.ok) return idOk.err;
      if (!RESOLUTIONS.has(data.resolution)) return bad('resolution must be one of done, answered, decided, reversed, cancelled');
      const c = optStr(data.comment, 'comment', BODY_MAX); if (!c.ok) return c.err;
      const body = { resolution: data.resolution };
      if (data.comment !== undefined) body.comment = data.comment;
      return passthrough(await client.close(data.id, body));
    },

    async reopen(data) {
      const { err } = callerSession(data);
      if (err) return err;
      const idOk = requireId(data); if (!idOk.ok) return idOk.err;
      const c = optStr(data.comment, 'comment', BODY_MAX); if (!c.ok) return c.err;
      const body = {};
      if (data.comment !== undefined) body.comment = data.comment;
      return passthrough(await client.reopen(data.id, body));
    },

    async reorder(data) {
      const { err } = callerSession(data);
      if (err) return err;
      const idOk = requireId(data); if (!idOk.ok) return idOk.err;
      const provided = ['position', 'after', 'before'].filter((k) => data[k] !== undefined);
      if (provided.length !== 1) return bad('exactly one of position, after or before is required');
      const body = {};
      if (data.position !== undefined) {
        if (data.position !== 'top' && data.position !== 'bottom') return bad("position must be 'top' or 'bottom'");
        body.position = data.position;
      }
      if (data.after !== undefined) body.after = data.after;
      if (data.before !== undefined) body.before = data.before;
      return passthrough(await client.rank(data.id, body));
    },
  };
}
