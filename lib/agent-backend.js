// Pure helpers for selecting the coding-agent backend. Commands accept
// --claude / --codex (plus --agent=<name>), while persisted state and the
// process-wide default use the same canonical strings.

export const AGENT_CLAUDE = 'claude';
export const AGENT_CODEX = 'codex';
export const AGENT_NAMES = [AGENT_CLAUDE, AGENT_CODEX];

const LEADING_UNICODE_DASHES = /^[‐‑‒–—―]+/;

export function normalizeAgent(value) {
  const normalized = String(value ?? '').trim().toLowerCase();
  return AGENT_NAMES.includes(normalized) ? normalized : null;
}

export function resolveAgent({ option, persisted, fallback = AGENT_CLAUDE } = {}) {
  return normalizeAgent(option) || normalizeAgent(persisted) || normalizeAgent(fallback) || AGENT_CLAUDE;
}

export function agentLabel(agent) {
  return normalizeAgent(agent) === AGENT_CODEX ? 'Codex' : 'Claude Code';
}

export function extractAgentFlag(tokens = []) {
  let agent = null;
  const rest = [];
  let error = null;

  for (const original of tokens) {
    const token = String(original).replace(LEADING_UNICODE_DASHES, '--');
    let candidate;
    if (token === '--claude') candidate = AGENT_CLAUDE;
    else if (token === '--codex') candidate = AGENT_CODEX;
    else if (token.startsWith('--agent=')) candidate = normalizeAgent(token.slice('--agent='.length));
    else {
      rest.push(original);
      continue;
    }

    if (!candidate) {
      error = `Unknown agent in "${original}". Use --claude or --codex.`;
      continue;
    }
    if (agent && agent !== candidate) {
      error = 'Choose only one agent: --claude or --codex.';
      continue;
    }
    agent = candidate;
  }

  return { agent, rest, error };
}
