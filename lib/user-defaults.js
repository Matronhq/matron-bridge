// The user's own defaults for NEW chats — the default model and default
// effort they set in the apps' Settings, stored in the journal
// (GET/PUT /defaults, matron-journal docs/protocol.md "Default model and
// effort"). They sit between a chat's own choice and this box's
// MATRON_DEFAULT_MODEL / MATRON_DEFAULT_EFFORT:
//
//   model:  explicit pick → room's persisted model → user default → box default
//   effort: explicit pick → room's persisted level → user default → box default
//
// The createMemoryLookup pattern: spawns are synchronous, so they read a
// cache; it is refreshed on every hello_ok, kept current by the journal's
// live `{kind:"defaults"}` frame, and re-read behind each spawn (throttled).
// Claude only — Codex takes its model and effort from its own config.
// Never throws, never logs the token.

import { isValidModelArg, normalizeModelArg, aliasLabel } from './model-aliases.js';
import { isSpawnEffortArg, normalizeEffortArg, effortLabel } from './effort-command.js';

const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_MIN_REFRESH_MS = 30_000;

// A stored model this box can run, normalised; else null. 'default' means
// "no preference" and so does anything this bridge would refuse as --model.
export function usableDefaultModel(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const v = normalizeModelArg(value);
  return v !== 'default' && isValidModelArg(v) ? v : null;
}

export function usableDefaultEffort(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  return isSpawnEffortArg(value) ? normalizeEffortArg(value) : null;
}

// What a fresh Claude start runs on when it names no model / effort.
export function effectiveDefaultModel(userModel, boxModel) {
  return usableDefaultModel(userModel) ?? boxModel;
}

export function effectiveDefaultEffort(userEffort, boxEffort) {
  return usableDefaultEffort(userEffort) ?? boxEffort;
}

export function createUserDefaultsLookup({
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
  let model = null;
  let effort = null;
  let lastAttempt = -Infinity;
  let inFlight = null;
  let warnedFailure = false;
  let warnedLegacy = false;
  // Bumped by every apply (a live frame, a save's answer, a GET's answer),
  // so a GET that was already on the wire when something newer landed
  // can't put the older value back.
  let generation = 0;

  function warn(msg) {
    try { log.warn(msg); } catch { /* logging must never throw */ }
  }

  function snapshot() {
    return { known, model, effort };
  }

  // A body from GET/PUT /defaults or a live `defaults` frame. Values are
  // kept as the journal stores them; usableDefault* decides what applies.
  function apply(body) {
    if (!body || typeof body !== 'object') return false;
    const m = body.default_model;
    const e = body.default_effort;
    if (m !== null && m !== undefined && typeof m !== 'string') return false;
    if (e !== null && e !== undefined && typeof e !== 'string') return false;
    known = true;
    model = m || null;
    effort = e || null;
    generation += 1;
    return true;
  }

  async function call(method, body) {
    if (!base) return { ok: false, reason: 'no journal configured' };
    const controller = new AbortController();
    const timer = setTimeout(() => { try { controller.abort(); } catch { /* best effort */ } }, timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();
    try {
      const res = await fetchImpl(`${base}/defaults`, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: controller.signal,
      });
      if (res.status === 404) return { ok: false, legacy: true, reason: 'this journal has no /defaults yet' };
      let data = null;
      try { data = await res.json(); } catch { data = null; }
      if (!res.ok) return { ok: false, reason: data?.error ? `${data.error}` : `HTTP ${res.status}` };
      return { ok: true, data };
    } catch (e) {
      return { ok: false, reason: e?.name === 'AbortError' ? 'timed out' : 'unreachable' };
    } finally {
      clearTimeout(timer);
    }
  }

  function refresh({ force = false } = {}) {
    if (inFlight) return force ? inFlight.then(() => refresh({ force: true })) : inFlight;
    if (!force && now() - lastAttempt < minRefreshMs) return Promise.resolve({ ...snapshot(), fetched: false });
    lastAttempt = now();
    const startedAt = generation;
    inFlight = call('GET').then((r) => {
      if (r.ok && generation !== startedAt) {
        // A frame or a save landed while this GET was on the wire: theirs
        // is newer, keep it.
        warnedFailure = false;
      } else if (r.ok && apply(r.data)) {
        warnedFailure = false;
      } else if (r.legacy) {
        // A journal from before /defaults: no user defaults, box defaults
        // apply — exactly today's behaviour.
        known = true;
        model = null;
        effort = null;
        if (!warnedLegacy) {
          warnedLegacy = true;
          warn('[defaults] this journal predates GET /defaults — new chats use the box defaults');
        }
      } else if (!warnedFailure) {
        warnedFailure = true;
        warn(`[defaults] GET /defaults failed (${r.reason || 'unreadable response'}) — ${known
          ? 'keeping the last known defaults'
          : 'new chats use the box defaults'}`);
      }
      return { ...snapshot(), fetched: !!r.ok };
    }).finally(() => { inFlight = null; });
    return inFlight;
  }

  // PUT a partial change ({default_model} and/or {default_effort}).
  // Resolves { ok, reason? }; on success the cache holds the journal's answer.
  async function save(patch) {
    const r = await call('PUT', patch);
    if (r.ok) apply(r.data);
    return { ok: !!r.ok, reason: r.reason };
  }

  return { refresh, snapshot, apply, save };
}

// --- "Use X for new chats too?" ---------------------------------------
//
// After a person changes a chat's effort or model, the bridge offers to
// make it their default for new chats. Two buttons, No first: not tapping
// is No — the change stays with this chat (PR 379 keeps Claude Code's own
// saved default from moving behind their back). Values ride the picker
// path (lib/picker-dispatch.js `defaults:`), provenance-checked by the
// router like every picker frame.

export function defaultOfferButtons(kind, value) {
  return [
    { id: 'defaults-no', label: 'No', value: 'defaults:no' },
    { id: 'defaults-yes', label: 'Yes', value: `defaults:${kind}:${value}` },
  ];
}

function describe(kind, value) {
  return kind === 'effort' ? `${effortLabel(value)} effort` : aliasLabel(value);
}

// The offer, or null when there's nothing to offer: a level/model this
// box can't start with, or one that already IS the default new chats get.
export function defaultOfferFor(kind, value, currentDefault) {
  const usable = kind === 'effort' ? usableDefaultEffort(value) : usableDefaultModel(value);
  if (!usable || usable === currentDefault) return null;
  return {
    question: `Use ${describe(kind, usable)} for new chats too?`,
    buttons: defaultOfferButtons(kind, usable),
  };
}

const OFFER_VALUE = /^(effort|model):(.+)$/;

// `defaults:<arg>` → {save:false} for No, {save:true, kind, value} for a
// valid Yes, else null.
export function parseDefaultOfferArg(arg) {
  if (arg === 'no') return { save: false };
  const m = typeof arg === 'string' ? arg.match(OFFER_VALUE) : null;
  if (!m) return null;
  const kind = m[1];
  const value = kind === 'effort' ? usableDefaultEffort(m[2]) : usableDefaultModel(m[2]);
  return value && value === m[2] ? { save: true, kind, value } : null;
}

export function defaultSavedText(kind, value) {
  return `✅ New chats will start on ${describe(kind, value)}. You can change this in Settings.`;
}

export function defaultDeclinedText() {
  return 'OK — it stays with this chat only.';
}
