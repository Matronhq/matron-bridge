// This box's own defaults for NEW sessions — the default agent (Claude or
// Codex), model and effort set per box in the apps' Settings ▸ Devices,
// stored in the journal (PUT /devices/:id/defaults, matron-journal
// docs/protocol.md "Box defaults"; spec docs/specs/box-defaults.md). They
// sit over this box's env (MATRON_DEFAULT_AGENT / _MODEL / _EFFORT):
//
//   agent:         explicit pick → box default → MATRON_DEFAULT_AGENT → claude
//   model, Claude: explicit pick → room's persisted model → box model →
//                  user default (/defaults) → MATRON_DEFAULT_MODEL
//   model, Codex:  explicit pick → room's persisted model → box model →
//                  MATRON_CODEX_DEFAULT_MODEL → Codex's own config
//   effort, Claude: the same chain as the Claude model
//   effort, Codex: explicit pick → room's persisted effort → box effort →
//                  MATRON_CODEX_DEFAULT_EFFORT → xhigh
//
// The box model and effort belong to the box's default agent: they apply
// only to a session that runs as that agent. Resumes keep what they ran on.
//
// The journal sends the values on every hello_ok (`box_defaults`) and live
// on change (`{kind:"box_defaults", device_id, ...}`, which goes to every
// socket of the user — so frames for other boxes are dropped here). Nothing
// is fetched: against a journal that predates box defaults the cache stays
// empty and the env applies, exactly as before. Never throws.

import { AGENT_CLAUDE, AGENT_CODEX, normalizeAgent } from './agent-backend.js';
import { usableDefaultModel, usableDefaultEffort } from './user-defaults.js';

// Codex model ids are whatever the account's model/list says (gpt-5.1-codex,
// o4-mini…); the journal only checks their shape, and so does this.
const CODEX_MODEL_RE = /^[a-z0-9][a-z0-9._:-]{0,63}$/i;
export const CODEX_DEFAULT_EFFORTS = ['minimal', 'low', 'medium', 'high', 'xhigh'];

// Codex runs at extra-high effort unless something names another level.
export const CODEX_BUILTIN_EFFORT = 'xhigh';

// The fleet-wide Codex fallback for a fresh start with no box value: this
// box's env, then the built-in effort. No built-in model — which models an
// account offers varies, so an unset model is left to Codex's own config.
export function codexEnvDefaults(env = {}) {
  return {
    model: usableCodexModel(env.MATRON_CODEX_DEFAULT_MODEL),
    effort: usableCodexEffort(env.MATRON_CODEX_DEFAULT_EFFORT) || CODEX_BUILTIN_EFFORT,
  };
}

export function usableCodexModel(value) {
  if (typeof value !== 'string') return null;
  const v = value.trim();
  return v && v.toLowerCase() !== 'default' && CODEX_MODEL_RE.test(v) ? v : null;
}

export function usableCodexEffort(value) {
  if (typeof value !== 'string') return null;
  const v = value.trim().toLowerCase();
  return CODEX_DEFAULT_EFFORTS.includes(v) ? v : null;
}

export function createBoxDefaultsStore({ identity = () => null, log = console } = {}) {
  let known = false;
  let agent = null;
  let model = null;
  let effort = null;

  // A hello_ok's `box_defaults` (passed with its device_id) or a live
  // `box_defaults` frame. A frame naming another box is not ours; one
  // arriving before this bridge knows its own id is taken on trust only
  // from hello_ok, which always describes the connecting device.
  function apply(frame, { fromHello = false } = {}) {
    if (!frame || typeof frame !== 'object') return false;
    const self = identity()?.deviceId;
    if (!fromHello && (!Number.isInteger(self) || frame.device_id !== self)) return false;
    const a = frame.default_agent;
    const m = frame.default_model;
    const e = frame.default_effort;
    for (const v of [a, m, e]) {
      if (v !== null && v !== undefined && typeof v !== 'string') return false;
    }
    const nextAgent = a ? normalizeAgent(a) : null;
    if (a && !nextAgent) {
      try { log.warn(`[box-defaults] ignoring unknown default agent ${JSON.stringify(a)}`); } catch { /* never throw */ }
    }
    known = true;
    agent = nextAgent;
    model = m || null;
    effort = e || null;
    return true;
  }

  function snapshot() {
    return { known, agent, model, effort };
  }

  return { apply, snapshot };
}

// What a fresh start with no explicit agent runs as. `box` is a snapshot;
// `envAgent` is MATRON_DEFAULT_AGENT already resolved. A Codex default on a
// box that can't spawn Codex runs Claude rather than fail every start;
// `configured` stays the agent the box's model and effort were set for.
export function resolveDefaultAgent({ box, envAgent, codexAvailable = () => true }) {
  const fromBox = normalizeAgent(box?.agent);
  const wanted = fromBox || normalizeAgent(envAgent) || AGENT_CLAUDE;
  const source = fromBox ? 'box' : (normalizeAgent(envAgent) ? 'env' : 'builtin');
  if (wanted === AGENT_CODEX) {
    let ok;
    try { ok = codexAvailable() === true; } catch { ok = false; }
    if (!ok) return { agent: AGENT_CLAUDE, configured: wanted, source, codexUnavailable: true };
  }
  return { agent: wanted, configured: wanted, source };
}

// The box model / effort for a session running as `agent`, or null: only
// when that agent is the one the box's defaults were set for (`configured`
// from resolveDefaultAgent — not the Claude a Codex-less box falls back
// to), and only a value that agent can start with.
export function boxModelFor(agent, { box, defaultAgent }) {
  if (!box || agent !== defaultAgent) return null;
  return agent === AGENT_CODEX ? usableCodexModel(box.model) : usableDefaultModel(box.model);
}

export function boxEffortFor(agent, { box, defaultAgent }) {
  if (!box || agent !== defaultAgent) return null;
  return agent === AGENT_CODEX ? usableCodexEffort(box.effort) : usableDefaultEffort(box.effort);
}

// The box_defaults_set tool's route (ask-user.js → POST /box-defaults-set):
// a partial change to any of the user's boxes, PUT to the journal, which
// validates it and tells that box live. `data` carries the tool's params;
// absent keys are left alone, null clears. Resolves {status, body}.
export function createBoxDefaultsSetter({ baseUrl, token, fetchImpl = globalThis.fetch, timeoutMs = 10_000 } = {}) {
  const base = typeof baseUrl === 'string' ? baseUrl.replace(/\/+$/, '') : '';
  return async function setBoxDefaults(data) {
    const deviceId = data?.device_id;
    if (!Number.isInteger(deviceId) || deviceId < 1) return { status: 400, body: { error: 'device_id must be a box id from agent_boxes' } };
    const patch = {};
    for (const [key, wire] of [['agent', 'default_agent'], ['model', 'default_model'], ['effort', 'default_effort']]) {
      if (data[key] === undefined) continue;
      if (data[key] !== null && typeof data[key] !== 'string') return { status: 400, body: { error: `${key} must be a string or null` } };
      patch[wire] = data[key];
    }
    if (!Object.keys(patch).length) return { status: 400, body: { error: 'nothing to change: pass agent, model and/or effort' } };
    if (!base) return { status: 503, body: { error: 'no journal configured' } };
    const controller = new AbortController();
    const timer = setTimeout(() => { try { controller.abort(); } catch { /* best effort */ } }, timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();
    try {
      const res = await fetchImpl(`${base}/devices/${deviceId}/defaults`, {
        method: 'PUT',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
        signal: controller.signal,
      });
      let body = null;
      try { body = await res.json(); } catch { body = null; }
      if (res.status === 404 && !body?.error) return { status: 501, body: { error: 'this journal has no box defaults yet' } };
      if (!res.ok) return { status: res.status, body: { error: body?.error || `HTTP ${res.status}` } };
      return { status: 200, body };
    } catch (e) {
      return { status: 502, body: { error: e?.name === 'AbortError' ? 'timed out' : 'journal unreachable' } };
    } finally {
      clearTimeout(timer);
    }
  };
}
