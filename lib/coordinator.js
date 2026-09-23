// The user's Coordinator (spec 2026-09-23 coordinator redesign, §2): which
// conversation holds the role, read from the journal, and every decision the
// bridge makes about it. Kept out of index.js so it is unit-testable; the
// wiring there is pinned by source inspection (test/coordinator-wiring.test.js).
//
// The role lives on the journal (GET /coordinator → {convo_id}), one per
// user; a bridge's agent token belongs to exactly one user, so this is one
// cached value per bridge. The answer is filtered by the journal's privacy
// rules: a Coordinator convo on another box's private conversation reads
// as null here — which is fine, because only the bridge that owns that
// room ever needs to know, and it sees the id. Null, a 404 and every
// failure all come out of roleFor() as "not the coordinator": the spawn is
// an ordinary session. createSession is synchronous with a dozen
// callers, so spawns read the cache; it is kept current by a forced refresh
// on every hello_ok, a forced refresh on every `coordinator` event, and a
// throttled refresh kicked behind every spawn. Never throws, never logs the
// token.

const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_MIN_REFRESH_MS = 30_000;

export function createCoordinatorLookup({
  baseUrl,
  token,
  fetchImpl = globalThis.fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  minRefreshMs = DEFAULT_MIN_REFRESH_MS,
  now = () => Date.now(),
  log = console,
} = {}) {
  const base = typeof baseUrl === 'string' ? baseUrl.replace(/\/+$/, '') : '';
  let known = false;
  let convoId = null;
  // Bumped by apply(): a GET that was already in flight when a live event
  // landed carries an answer from before the event, so it must not
  // overwrite what the event just set.
  let epoch = 0;
  let lastAttempt = -Infinity;
  let inFlight = null;
  let warnedFailure = false;
  let warnedLegacy = false;

  function warn(msg) {
    try { log.warn(msg); } catch { /* logging must never throw */ }
  }

  function snapshot() {
    return { known, convoId };
  }

  async function fetchOnce() {
    if (!base) return { ok: false, reason: 'no journal configured' };
    const controller = new AbortController();
    const timer = setTimeout(() => { try { controller.abort(); } catch { /* best effort */ } }, timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();
    try {
      const res = await fetchImpl(`${base}/coordinator`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${token}` },
        signal: controller.signal,
      });
      // A journal that predates the Coordinator has no such route. Until it
      // is deployed nobody can be the Coordinator, so "nobody" is the truth.
      if (res.status === 404) return { ok: true, convoId: null, legacy: true };
      if (!res.ok) return { ok: false, reason: `HTTP ${res.status}` };
      let data = null;
      try { data = await res.json(); } catch { data = null; }
      const value = data?.convo_id;
      if (value === null) return { ok: true, convoId: null };
      if (typeof value === 'string' && value) return { ok: true, convoId: value };
      return { ok: false, reason: 'unreadable response' };
    } catch (e) {
      return { ok: false, reason: e?.name === 'AbortError' ? 'timed out' : 'unreachable' };
    } finally {
      clearTimeout(timer);
    }
  }

  function refresh({ force = false } = {}) {
    // A forced refresh must see the journal AFTER whatever made the caller
    // force it, so it never piggybacks on a request already on the wire.
    if (inFlight) return force ? inFlight.then(() => refresh({ force: true })) : inFlight;
    if (!force && now() - lastAttempt < minRefreshMs) return Promise.resolve({ ...snapshot(), fetched: false });
    lastAttempt = now();
    const startEpoch = epoch;
    inFlight = fetchOnce().then((r) => {
      const current = r.ok && startEpoch === epoch;
      if (current) {
        known = true;
        convoId = r.convoId;
        warnedFailure = false;
        if (r.legacy && !warnedLegacy) {
          warnedLegacy = true;
          warn('[coordinator] this journal predates GET /coordinator — no session is the Coordinator until it is updated');
        }
      } else if (!r.ok && !warnedFailure) {
        warnedFailure = true;
        warn(`[coordinator] GET /coordinator failed (${r.reason}) — ${known
          ? `keeping the last known coordinator (${convoId ?? 'none'})`
          : 'role unknown; sessions start as ordinary sessions until the journal answers'}`);
      }
      return { ...snapshot(), fetched: current };
    }).finally(() => { inFlight = null; });
    return inFlight;
  }

  function apply(id, role) {
    if (typeof id !== 'string' || !id) return;
    if (role === 'assigned') {
      epoch += 1;
      known = true;
      convoId = id;
    } else if (role === 'released') {
      epoch += 1;
      if (known && convoId === id) convoId = null;
    }
  }

  function roleFor(candidates) {
    const ids = (Array.isArray(candidates) ? candidates : []).filter((c) => typeof c === 'string' && c);
    return { known, coordinator: known && convoId !== null && ids.includes(convoId) };
  }

  return { refresh, apply, roleFor, snapshot };
}
