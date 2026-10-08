// The user's journal-side settings, cached for every session's spawn. Today
// that is one flag, `notices` ("Send things I need to read to For you"),
// which decides whether BRIDGE_NOTICES.md rides in the system prompt.
//
// The journal pushes the value rather than being polled: hello_ok carries
// `settings: {notices}`, and a change reaches every connected device as
// `{kind:'control', op:'settings', settings}`. A journal that predates the
// setting sends neither, so a hello_ok without settings falls back to one
// GET /settings; a 404 there (or any failure) leaves the default. The
// default is true — the setting is opt-out, and an unknown value must read
// the way the journal would answer for a user who never touched it.
// Same discipline as lib/memory-lookup.js: never throws, never logs the token.

const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULTS = Object.freeze({ notices: true });

export function createUserSettings({
  baseUrl,
  token,
  fetchImpl = globalThis.fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  log = console,
} = {}) {
  const base = typeof baseUrl === 'string' ? baseUrl.replace(/\/+$/, '') : '';
  let notices = DEFAULTS.notices;
  // Bumped by apply(): a GET already in flight when a pushed frame lands
  // carries an answer from before the frame, so it must not overwrite it.
  let epoch = 0;
  let warnedFailure = false;

  function warn(msg) {
    try { log.warn(msg); } catch { /* logging must never throw */ }
  }

  // A settings object from a frame or GET /settings. Only a real boolean
  // moves the value: a missing or malformed field keeps what we had.
  function apply(settings) {
    if (!settings || typeof settings !== 'object') return false;
    if (typeof settings.notices !== 'boolean') return false;
    epoch += 1;
    notices = settings.notices;
    return true;
  }

  async function refresh() {
    if (!base) return snapshot();
    const startedAt = epoch;
    const controller = new AbortController();
    const timer = setTimeout(() => { try { controller.abort(); } catch { /* best effort */ } }, timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();
    try {
      const res = await fetchImpl(`${base}/settings`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${token}` },
        signal: controller.signal,
      });
      // A journal without the route has no such setting: the default stands.
      if (res.status === 404) return snapshot();
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      let data = null;
      try { data = await res.json(); } catch { data = null; }
      if (epoch === startedAt && typeof data?.notices === 'boolean') {
        notices = data.notices;
        warnedFailure = false;
      }
    } catch (e) {
      if (!warnedFailure) {
        warnedFailure = true;
        warn(`[settings] GET /settings failed (${e?.name === 'AbortError' ? 'timed out' : e?.message ?? 'unreachable'}) — keeping notices=${notices}`);
      }
    } finally {
      clearTimeout(timer);
    }
    return snapshot();
  }

  // hello_ok's settings, or null when that hello_ok carried none (an older
  // journal): then ask the route instead.
  function onHello(settings) {
    if (apply(settings)) return Promise.resolve(snapshot());
    return refresh();
  }

  function snapshot() {
    return { notices };
  }

  return { apply, onHello, refresh, snapshot, notices: () => notices };
}
