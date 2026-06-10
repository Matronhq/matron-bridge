// Pure helpers for assembling per-session MCP configuration. Kept separate
// from index.js so they're side-effect-free and testable.
//
// Two-section layout on disk (`mcp-config.json`):
//   `mcpServers` — always-on servers (e.g. ask-user)
//   `mcpExtras`  — opt-in groups keyed by name (e.g. `browser`)
//
// `buildMcpServers` merges the base set with whichever extras were requested
// for a session, optionally applying the macOS xvfb-run unwrapper.
// `extractMcpExtraFlags` strips recognised `--<name>` flags from a tokenised
// command line and returns both the extras and the remaining positional
// tokens, so callers can keep their existing positional-arg handling.

import { macifyMcpServers } from './mcp-config-mac.js';

// The set of extra-flag names we understand. Mapping the CLI flag to the
// `mcpExtras` block name keeps the user-facing language (`--browser`)
// decoupled from the config key (`browser`) — useful if we ever want aliases.
// Backed by a Map (not a plain object) so positional tokens that happen to
// match Object.prototype names — `constructor`, `toString`, `__proto__` —
// don't resolve to truthy prototype values and get silently consumed.
const EXTRA_FLAG_TO_NAME = new Map([
  ['--browser', 'browser'],
]);

export function knownMcpExtras() {
  return Array.from(EXTRA_FLAG_TO_NAME.values());
}

// Matrix / mobile clients frequently auto-correct a leading `--` into a single
// em-dash (—) or en-dash (–), so a user typing `--browser` actually sends
// `—browser`. Normalise any run of leading unicode dashes back to `--` before
// matching, so the auto-corrected forms are still recognised. The ORIGINAL
// token is preserved in `rest` when it isn't a flag, so positional args are
// untouched.
const LEADING_UNICODE_DASHES = /^[‐‑‒–—―]+/;

export function extractMcpExtraFlags(tokens) {
  const extras = [];
  const rest = [];
  for (const tok of tokens) {
    const normalised = tok.replace(LEADING_UNICODE_DASHES, '--');
    const mapped = EXTRA_FLAG_TO_NAME.get(normalised);
    if (mapped) extras.push(mapped);
    else rest.push(tok);
  }
  return { extras, rest };
}

// Extract `--worktree <name>` from a tokenised command line. Returns the
// worktree name (or null), an error string (if the name is invalid), and
// the remaining positional tokens. Names must match [a-zA-Z0-9_-] only
// (max 64 chars) — invalid names are rejected, not silently rewritten,
// to prevent distinct inputs from colliding on the same worktree.
export function extractWorktreeFlag(tokens) {
  let worktree = null;
  let error = null;
  const rest = [];
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i] === '--worktree') {
      if (i + 1 >= tokens.length) {
        error = '--worktree requires a name (e.g. --worktree fix-auth).';
        continue;
      }
      const raw = tokens[++i];
      if (!/^[a-zA-Z0-9_-]+$/.test(raw)) {
        error = `Invalid worktree name "${raw}" — only letters, digits, hyphens, and underscores are allowed.`;
      } else if (raw.length > 64) {
        error = `Worktree name too long (${raw.length} chars, max 64).`;
      } else {
        worktree = raw;
      }
    } else {
      rest.push(tokens[i]);
    }
  }
  return { worktree, error, rest };
}

// Resolve the `ask-user` server's relative arg against the supplied directory
// so the generated config is portable; callers pass the bridge install dir.
function resolveAskUser(servers, askUserBaseDir) {
  if (!servers || !servers['ask-user'] || !askUserBaseDir) return servers;
  const out = { ...servers };
  const src = out['ask-user'];
  out['ask-user'] = {
    ...src,
    args: (src.args || []).map((a, i) =>
      i === 0 && a === './ask-user.js' ? `${askUserBaseDir}/ask-user.js` : a,
    ),
  };
  return out;
}

export function buildMcpServers({
  baseConfig,
  extras = [],
  platform = process.platform,
  askUserBaseDir = null,
} = {}) {
  const base = baseConfig?.mcpServers || {};
  const extrasMap = baseConfig?.mcpExtras || {};
  let servers = { ...base };
  const sorted = [...new Set(extras)].filter(e => Object.prototype.hasOwnProperty.call(extrasMap, e)).sort();
  for (const ex of sorted) {
    Object.assign(servers, extrasMap[ex]);
  }
  servers = resolveAskUser(servers, askUserBaseDir);
  let out = { mcpServers: servers };
  if (platform === 'darwin') out = macifyMcpServers(out);
  return { config: out, extras: sorted };
}
