// Coordinator session control, target-bridge side (spec
// docs/superpowers/specs/2026-09-29-coordinator-session-control-design.md,
// "Decisions"): the pure planner behind the `session_control` RPC. Given
// the relayed params and the session they aim at, decide whether to apply
// now, park until the session is free, or refuse — and name the notice the
// target chat gets and the steps index.js runs. No I/O here; index.js owns
// the session objects, the model/agent switch paths and the turn injection.
import { AGENT_CLAUDE, AGENT_CODEX, normalizeAgent, agentLabel } from './agent-backend.js';
import { isValidModelArg, normalizeModelArg, aliasLabel } from './model-aliases.js';

export const CONTROL_ACTIONS = new Set(['set_model', 'compact', 'carry_on']);
// Drain order for parked slots: a turn and a compact first (they ride the
// queue a print-mode recreate carries), the model/agent switch last.
export const CONTROL_KINDS = ['carry_on', 'compact', 'set_model'];
export const MESSAGE_MAX_CHARS = 2000;
export const REASON_MAX_CHARS = 200;
export const MODEL_MAX_CHARS = 64;

// The same "is this session free" test room delivery uses: a turn running,
// a resume hold, an open AskUserQuestion, an open TUI prompt. Anything else
// (a queued message, a pending plan) only matters to an agent switch, which
// canSwitchAgent judges separately.
export function occupied(session) {
  return !!session?.busy || !!session?._awaitingInputReady
    || !!session?.waitingForAnswer || !!session?.pendingInteractivePrompt;
}

// Wire-contract re-check of what the journal relayed (it validates too,
// but the target must not trust the far end with the only copy of the rule).
export function validateControlParams(params) {
  if (!params || typeof params !== 'object') return { code: 'bad_request', detail: 'no params' };
  if (typeof params.convo_id !== 'string' || !params.convo_id) return { code: 'bad_request', detail: 'bad convo_id' };
  if (!CONTROL_ACTIONS.has(params.action)) return { code: 'bad_request', detail: 'bad action' };
  const out = { convoId: params.convo_id, action: params.action };
  if (params.reason != null) {
    if (typeof params.reason !== 'string' || params.reason.length > REASON_MAX_CHARS) return { code: 'bad_request', detail: 'bad reason' };
    if (params.reason.trim()) out.reason = params.reason.trim();
  }
  if (typeof params.from_name === 'string' && params.from_name) out.fromName = params.from_name.slice(0, 80);
  if (params.action === 'set_model') {
    if (params.agent != null) {
      const agent = normalizeAgent(params.agent);
      if (!agent) return { code: 'bad_agent', detail: String(params.agent).slice(0, 40) };
      out.agent = agent;
    }
    if (params.model != null) {
      if (typeof params.model !== 'string' || !params.model.trim() || params.model.length > MODEL_MAX_CHARS || /\s/.test(params.model.trim())) {
        return { code: 'bad_model', detail: 'model must be one token of at most 64 characters' };
      }
      out.model = params.model.trim();
    }
    if (!out.agent && !out.model) return { code: 'bad_request', detail: 'set_model needs model or agent' };
  }
  if (params.action === 'carry_on') {
    if (typeof params.message !== 'string' || !params.message.trim() || params.message.length > MESSAGE_MAX_CHARS) {
      return { code: 'bad_request', detail: 'carry_on needs a message of at most 2000 characters' };
    }
    out.message = params.message.trim();
    out.when = params.when === 'after_limit_reset' ? 'after_limit_reset' : 'now';
  }
  return { ok: true, params: out };
}

// The turn a carry-on injects. Framed HERE, on the target bridge, so the
// Coordinator can never dictate its own provenance line.
export function coordinatorTurnText(message, fromName) {
  const who = fromName ? `the Coordinator (${fromName})` : 'the Coordinator';
  return `[from ${who}] ${message}`;
}

function modelLabel(model, agent) {
  if (!model) return '';
  return agent === AGENT_CODEX ? model : aliasLabel(normalizeModelArg(model)) || model;
}

// The one-line notice the target session's chat gets (decision B). `phase`
// is 'now' (applied at once), 'deferred' (parked, will apply when the
// session is free), 'applied' (a parked action just applied), 'scheduled'
// (a carry-on waiting for the limit reset) or an error code.
export function controlNotice(params, { phase, agent, resetsAt, error } = {}) {
  const by = params.fromName ? `Coordinator (${params.fromName})` : 'Coordinator';
  const why = params.reason ? ` — ${params.reason}` : '';
  let what;
  switch (params.action) {
    case 'compact':
      what = 'compacting this session';
      break;
    case 'set_model': {
      const parts = [];
      if (params.agent && params.agent !== agent) parts.push(`switching this session to ${agentLabel(params.agent)}`);
      if (params.model) parts.push(`${parts.length ? 'then ' : ''}switching the model to ${modelLabel(params.model, params.agent || agent)}`);
      what = parts.join(', ') || 'switching this session';
      break;
    }
    case 'carry_on': {
      const excerpt = params.message ? `: “${params.message.length > 160 ? `${params.message.slice(0, 157)}…` : params.message}”` : '';
      what = params.when === 'after_limit_reset'
        ? `carry on once the usage limit resets${resetsAt ? ` at ${hhmmUtc(resetsAt)}` : ''}${excerpt}`
        : `carry on${excerpt}`;
      break;
    }
    default:
      what = params.action;
  }
  if (error) return `⚠️ ${by}: ${what} — refused: ${error}${why}`;
  const tail = phase === 'deferred' ? ' once this turn finishes'
    : phase === 'applied' ? ' (now that the session is free)'
      : phase === 'scheduled' ? '' : '';
  return `🛠 ${by}: ${what}${tail}${why}`;
}

export function hhmmUtc(iso) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return String(iso);
  const d = new Date(t);
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')} UTC`;
}

// The decision. `canSwitch(session, agent)` is lib/agent-handoff.js's
// canSwitchAgent (injected so this stays pure).
//   -> { kind:'error', code, detail? }
//   -> { kind:'park',  slot: { kind, params } }       parked until free
//   -> { kind:'apply', steps: [...] }                  run now, in order
//   -> { kind:'schedule', at, text }                   carry_on after the limit reset
// steps: {op:'switch_agent', agent} | {op:'set_model', model} | {op:'compact'} | {op:'carry_on', text}
export function planSessionControl({ params, session, canSwitch = () => ({ ok: true }) }) {
  if (!session) return { kind: 'error', code: 'not_found' };
  if (!session.alive) return { kind: 'error', code: 'gone', detail: 'the session has ended' };
  const agent = session.agent === AGENT_CODEX ? AGENT_CODEX : AGENT_CLAUDE;
  switch (params.action) {
    case 'carry_on': {
      if (params.when === 'after_limit_reset') {
        if (!session._stall) return { kind: 'error', code: 'not_stalled', detail: 'the session is not stalled on a usage limit' };
        if (!session._stall.resets_at) return { kind: 'error', code: 'no_reset_time', detail: 'the stall has no known reset time — use when: now, or switch the model' };
        return { kind: 'schedule', at: session._stall.resets_at, text: coordinatorTurnText(params.message, params.fromName) };
      }
      const step = { op: 'carry_on', text: coordinatorTurnText(params.message, params.fromName) };
      if (occupied(session)) return { kind: 'park', slot: { kind: 'carry_on', params } };
      return { kind: 'apply', steps: [step] };
    }
    case 'compact':
      if (occupied(session)) return { kind: 'park', slot: { kind: 'compact', params } };
      return { kind: 'apply', steps: [{ op: 'compact' }] };
    case 'set_model': {
      const switching = !!params.agent && params.agent !== agent;
      const targetAgent = params.agent || agent;
      // Validate the model against the backend it will run on, before
      // anything is parked: a bad alias must never wait a turn to be refused.
      if (params.model && targetAgent === AGENT_CLAUDE && !isValidModelArg(params.model)) {
        return { kind: 'error', code: 'bad_model', detail: `unknown Claude model alias: ${params.model}` };
      }
      if (switching) {
        const verdict = canSwitch(session, params.agent);
        if (!verdict.ok) return { kind: 'park', slot: { kind: 'set_model', params } };
      } else if (occupied(session)) {
        return { kind: 'park', slot: { kind: 'set_model', params } };
      }
      const steps = [];
      if (switching) steps.push({ op: 'switch_agent', agent: params.agent });
      if (params.model) steps.push({ op: 'set_model', model: params.model });
      return { kind: 'apply', steps };
    }
    default:
      return { kind: 'error', code: 'bad_request', detail: 'bad action' };
  }
}

// What the Coordinator's own chat is told when the result frame lands.
export function describeControlResult(frame, { action, box } = {}) {
  const where = box ? ` on ${box}` : '';
  const verb = action === 'compact' ? 'compact' : action === 'set_model' ? 'model switch' : action === 'carry_on' ? 'carry-on' : 'session control';
  if (!frame || frame.ok !== true) {
    const code = frame?.error?.code || 'unknown';
    const detail = frame?.error?.detail ? ` — ${frame.error.detail}` : '';
    const hint = code === 'timeout' ? ' (the bridge did not answer; the box may be starting)'
      : code === 'agent_unreachable' ? ' (the box is offline and could not be woken)'
        : code === 'not_found' ? ' (that bridge does not run this conversation)'
          : '';
    return `⚠️ Session ${verb}${where} failed: ${code}${detail}${hint}`;
  }
  const r = frame.result || {};
  if (r.applied === 'deferred') return `⏳ Session ${verb}${where} parked: the session is busy; it applies at its next idle point.`;
  if (r.applied === 'scheduled') return `⏰ Session ${verb}${where} scheduled${r.at ? ` for ${hhmmUtc(r.at)}` : ''}.`;
  return `✅ Session ${verb}${where} applied${r.detail ? `: ${r.detail}` : ''}.`;
}
