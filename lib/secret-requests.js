// The secure-input request lifecycle (tracker item #120).
//
// `request_secret` used to be a blocking tool: it POSTed /secret and then
// polled for five minutes, so the agent sat idle while the user found the
// key — and lost the request entirely if they took longer. Now the tool
// returns immediately, the request lives for 24 hours, it appears in the
// user's tracker as a question, and the submission comes back to the agent as
// a turn whenever it lands.
//
// Everything impure is injected (load/save, now, setTimer/clearTimer, the two
// filesystem calls, the items client, the chat notice and the turn delivery),
// the same discipline as lib/timer-command.js's store and lib/items-turn.js —
// so the whole lifecycle is unit-testable without a bridge, a journal, or a
// session.
//
// SECURITY INVARIANT: the submitted value passes through exactly two places —
// writeSecretFile, and the HTTP response's `path`. It is never logged, never
// persisted, never put in an item body or comment, and never in a turn. The
// persisted record deliberately carries no value and no path.

// Both the request lifetime AND the signed link's expiry. One number: a link
// that outlived its request would render a form whose submission 404s, and a
// link that died first would strand a request nobody can answer.
export const SECRET_REQUEST_TTL_MS = 24 * 60 * 60 * 1000;

// How long a submitted value stays on disk. Unchanged from the original
// implementation — the agent reads the file in the turn it is told about.
export const SECRET_FILE_TTL_MS = 60 * 60 * 1000;

const escapeHtml = (value) => String(value)
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&#39;');

// The chat line. Markdown link in the plain body (the apps render it) and an
// anchor in the HTML variant, exactly as the pre-#120 notice did — plus the
// item number and the window, so the user can see at a glance that this is
// not a five-minute prompt they have already missed.
export function formatSecretChatNotice({ label, link, itemNum }) {
  if (!link) {
    return { plain: `🔐 Secret requested: ${label} (viewer not configured)`, html: null };
  }
  const suffix = Number.isInteger(itemNum) ? `(#${itemNum}, 24 h)` : '(24 h)';
  return {
    plain: `🔐 Secret requested: ${label} — [Enter secret](${link}) ${suffix}`,
    html: `🔐 Secret requested: <b>${escapeHtml(label)}</b> — <a href="${link}">Enter secret</a> ${escapeHtml(suffix)}`,
  };
}

// The tracker item's body. One line saying what is needed and where to put it,
// then the expiry and the promise that the value never enters chat — the
// user is being asked to paste a credential, so the handling has to be stated
// where they are asked, not only in the docs.
export function formatSecretItemBody({ label, link, expiresAt }) {
  const where = link
    ? `[Enter secret](${link})`
    : 'the viewer is not configured on this box, so there is no link — the request cannot be answered until it is';
  return [
    `An agent on this box needs ${label}. ${where}`,
    `Expires ${new Date(expiresAt).toISOString()}. The value is written to a file the agent reads; it never enters chat.`,
  ].join('\n\n');
}

// The ONE transformation applied to a submitted value, and only for a
// multiline request.
//
// The HTML standard's textarea wrapping transformation makes every textarea
// submission CRLF, whatever the user pasted — so by the time the value reaches
// us the original endings are unrecoverable, and "write it verbatim" would
// mean writing CRLF into a PEM, a .env or a JSON key file on a Unix host,
// silently altering it. Normalising to LF is the lesser evil, and it lives
// here rather than in the viewer so that every client of the submit API — the
// form, curl, anything later — puts the same bytes on disk.
//
// A lone \r (not part of \r\n) is left alone: it is not a line ending anyone
// produced by pressing return, so touching it would be a guess. Single-line
// requests are never touched — nothing in one should contain a newline at
// all, and if one does it was put there deliberately.
function normalizeLineEndings(value, multiline) {
  return multiline ? value.replace(/\r\n/g, '\n') : value;
}

// A persisted record is only useful if it can still be expired and answered:
// an id, a label to name it with, and a deadline to arm.
function validRecord(r) {
  return !!r
    && typeof r === 'object'
    && typeof r.secretId === 'string' && r.secretId !== ''
    && typeof r.label === 'string'
    && Number.isFinite(r.expiresAt);
}

// The persisted shape, explicitly. Written as a whitelist rather than a
// blacklist so a field added to the in-memory record later (a path, a convo
// id, anything) cannot reach the file by accident.
const persistable = (r) => ({
  secretId: r.secretId,
  label: r.label,
  roomId: r.roomId ?? null,
  itemId: r.itemId ?? null,
  itemNum: r.itemNum ?? null,
  createdAt: r.createdAt,
  expiresAt: r.expiresAt,
  multiline: !!r.multiline,
});

export function createSecretRequests({
  // () -> persisted blob | null, and (blob) -> void. index.js wires the same
  // read/atomic-write pair TIMERS_FILE and INFLIGHT_FILE use.
  load,
  save,
  now = () => Date.now(),
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  newId,
  // (secretId, value) -> absolute path. Owns the 0600 write; throws on
  // failure, which leaves the request pending so the user can retry.
  writeSecretFile,
  // (path) -> void. The 1 h cleanup.
  removeSecretFile,
  // The lib/items-client.js subset this needs: create + close.
  items,
  // (secretId, { label, roomId, multiline, ttlMs }) -> url | null (null when
  // the viewer is not configured).
  generateLink,
  // (record, { link, itemNum, plain, html }) -> void. Posts the chat line.
  notifyChat,
  // async (record, text) -> void. One synthetic agent turn, delivered through
  // the SAME seams lib/items-turn.js uses (inject / queue / journal notice).
  deliverTurn,
  ttlMs = SECRET_REQUEST_TTL_MS,
  fileTtlMs = SECRET_FILE_TTL_MS,
  log = console,
} = {}) {
  function warn(msg) {
    try { log.warn(msg); } catch { /* logging must never throw */ }
  }

  const loaded = (() => {
    try {
      const raw = load ? load() : null;
      if (raw && Array.isArray(raw.requests)) return raw.requests.filter(validRecord);
    } catch (e) {
      warn(`[secrets] request store load failed: ${e?.message ?? e}`);
    }
    return [];
  })();

  // secretId -> record. Pending only: a submitted request moves to `answered`
  // and leaves the persisted store entirely.
  const pending = new Map(loaded.map((r) => [r.secretId, { ...r, multiline: !!r.multiline }]));
  // secretId -> { path, label }. In memory only, and only until the legacy
  // GET /secret/:id reads it once — kept purely so an older ask-user.js that
  // still polls keeps working through a bridge upgrade.
  const answered = new Map();
  const handles = new Map(); // secretId -> expiry timer handle

  // Background work started by create/submit/expire. Tracked so tests (and a
  // shutdown) can await it; nothing here ever rejects.
  const inFlight = new Set();
  function track(promise) {
    const p = promise.catch((e) => warn(`[secrets] background step failed: ${e?.message ?? e}`));
    inFlight.add(p);
    p.finally(() => inFlight.delete(p));
    return p;
  }

  function persist() {
    try {
      save({ requests: [...pending.values()].map(persistable) });
    } catch (e) {
      warn(`[secrets] request store save failed: ${e?.message ?? e}`);
    }
  }

  function disarm(secretId) {
    const handle = handles.get(secretId);
    if (handle !== undefined) clearTimer(handle);
    handles.delete(secretId);
  }

  function arm(record, delay) {
    handles.set(record.secretId, setTimer(() => { track(expire(record)); }, Math.max(0, delay)));
  }

  // Best-effort item close. A journal that is down must not stop the agent
  // being told what happened — the turn is the part that matters.
  async function closeItem(record, resolution, comment) {
    if (!record.itemId) return;
    try {
      const res = await items.close(record.itemId, { resolution, comment });
      if (res?.status !== 200 && res?.status !== 201 && res?.status !== 204) {
        warn(`[secrets] could not close item ${record.itemId} as ${resolution}: ${res?.data?.error ?? `HTTP ${res?.status}`}`);
      }
    } catch (e) {
      warn(`[secrets] closing item ${record.itemId} threw: ${e?.message ?? e}`);
    }
  }

  async function tell(record, text) {
    try {
      await deliverTurn(record, text);
    } catch (e) {
      warn(`[secrets] could not deliver the turn for ${record.secretId}: ${e?.message ?? e}`);
    }
  }

  // 24 h with no submission. The request is gone, the question is closed as
  // cancelled, and the agent is told — a silent expiry would leave it waiting
  // for a turn that is never coming.
  async function expire(record) {
    handles.delete(record.secretId);
    if (pending.get(record.secretId) !== record && pending.has(record.secretId)) return;
    if (!pending.delete(record.secretId)) return;
    persist();
    await closeItem(record, 'cancelled', 'Expired without a submission.');
    await tell(record, `🔐 Secret "${record.label}" request expired (24 h) — ask again if still needed.`);
  }

  async function fileItem({ label, convoId, link, expiresAt }) {
    if (!convoId) {
      return { itemId: null, itemNum: null, itemError: 'no journal conversation for this session yet' };
    }
    try {
      const res = await items.create({
        kind: 'question',
        title: `Secret needed: ${label}`,
        body: formatSecretItemBody({ label, link, expiresAt }),
        labels: ['secret'],
        convo_id: convoId,
      });
      const item = res?.data?.item;
      if ((res?.status === 200 || res?.status === 201) && item) {
        return { itemId: item.id ?? null, itemNum: Number.isInteger(item.num) ? item.num : null, itemError: null };
      }
      return {
        itemId: null,
        itemNum: null,
        itemError: res?.data?.error || `HTTP ${res?.status ?? '?'}`,
      };
    } catch (e) {
      return { itemId: null, itemNum: null, itemError: e?.message ?? String(e) };
    }
  }

  return {
    // Re-arm everything persisted from a previous bridge run. Anything that
    // came due while the bridge was down expires now (closing its item), so a
    // restart can never resurrect a dead link. Returns how many are live.
    init() {
      const t = now();
      let live = 0;
      for (const record of [...pending.values()]) {
        if (record.expiresAt <= t) {
          track(expire(record));
          continue;
        }
        arm(record, record.expiresAt - t);
        live++;
      }
      return live;
    },

    async create({ label, roomId, convoId = null, multiline = false }) {
      const secretId = newId();
      const createdAt = now();
      const expiresAt = createdAt + ttlMs;
      const link = generateLink(secretId, { label, roomId, multiline: !!multiline, ttlMs });

      const { itemId, itemNum, itemError } = await fileItem({ label, convoId, link, expiresAt });

      const record = {
        secretId,
        label,
        roomId: roomId ?? null,
        itemId,
        itemNum,
        createdAt,
        expiresAt,
        multiline: !!multiline,
      };
      pending.set(secretId, record);
      persist();
      arm(record, ttlMs);

      const { plain, html } = formatSecretChatNotice({ label, link, itemNum });
      try {
        notifyChat(record, { link, itemNum, plain, html });
      } catch (e) {
        warn(`[secrets] chat notice failed for ${secretId}: ${e?.message ?? e}`);
      }

      return { secretId, itemId, itemNum, itemError, expiresAt, link };
    },

    // The value's only stop on its way to disk. Returns fast — the item close
    // and the agent turn run on `done`, so a slow journal never holds the
    // user's browser open on the submit POST.
    async submit(secretId, value) {
      const record = pending.get(secretId);
      if (!record) return { ok: false, status: 404, error: 'Secret request not found or already submitted' };
      if (typeof value !== 'string' || value === '') return { ok: false, status: 400, error: 'value is required' };

      let path;
      try {
        path = writeSecretFile(secretId, normalizeLineEndings(value, record.multiline));
      } catch (e) {
        // Deliberately leaves the request pending: the link still works, so a
        // transient write failure is retryable rather than terminal.
        return { ok: false, status: 500, error: `Failed to write secret: ${e?.message ?? e}` };
      }

      disarm(secretId);
      pending.delete(secretId);
      persist();
      answered.set(secretId, { path, label: record.label });

      const cleanup = setTimer(() => {
        answered.delete(secretId);
        try { removeSecretFile(path); } catch (e) { warn(`[secrets] cleanup failed: ${e?.message ?? e}`); }
      }, fileTtlMs);
      if (typeof cleanup?.unref === 'function') cleanup.unref();

      const done = track((async () => {
        await closeItem(record, 'answered', `Submitted at ${new Date(now()).toISOString()}.`);
        await tell(record, `🔐 Secret "${record.label}" submitted — read it from ${path}`);
      })());

      return { ok: true, status: 200, path, done };
    },

    // Legacy GET /secret/:id. Pending -> {answered:false}; submitted -> the
    // path, once; anything else -> null (404). Kept for a bridge upgraded
    // under a running ask-user.js that still polls.
    read(secretId) {
      if (pending.has(secretId)) return { answered: false, path: null };
      const done = answered.get(secretId);
      if (!done) return null;
      answered.delete(secretId);
      return { answered: true, path: done.path };
    },

    // Test/introspection only — never returns anything the store does not
    // already persist, so it cannot become a leak.
    peek(secretId) {
      const r = pending.get(secretId);
      return r ? persistable(r) : null;
    },

    // Await whatever background item/turn work is outstanding.
    settled() {
      return Promise.all([...inFlight]);
    },
  };
}
