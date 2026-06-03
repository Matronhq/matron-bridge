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

// The set of valid extra names is derived from the merged config's
// `mcpExtras` keys (committed + machine-local overlay), so adding an extra to
// mcp-config[.local].json automatically enables its `--<name>` flag.
export function knownMcpExtras(baseConfig) {
  return Object.keys(baseConfig?.mcpExtras || {});
}

// Strip recognised `--<name>` flags from a tokenised command line. `knownNames`
// is the list from knownMcpExtras(). A Set membership test (not object lookup)
// keeps prototype names like `__proto__`/`constructor` from matching.
export function extractMcpExtraFlags(tokens, knownNames = []) {
  const known = new Set(knownNames);
  const extras = [];
  const rest = [];
  for (const tok of tokens) {
    const m = /^--(.+)$/.exec(tok);
    if (m && known.has(m[1])) extras.push(m[1]);
    else rest.push(tok);
  }
  return { extras, rest };
}

// Shallow-merge a gitignored machine-local overlay into the committed config.
// Always returns a fresh object (overlay may be null) so callers can never
// mutate the input. Overlay `mcpServers`/`mcpExtras` entries win key-by-key.
export function mergeMcpConfigs(base, overlay) {
  return {
    ...base,
    mcpServers: { ...(base?.mcpServers || {}), ...(overlay?.mcpServers || {}) },
    mcpExtras: { ...(base?.mcpExtras || {}), ...(overlay?.mcpExtras || {}) },
  };
}

// Parse the comma-separated MCP_DEFAULT_EXTRAS env value into a clean list.
export function parseDefaultExtras(value) {
  if (!value) return [];
  return value.split(',').map(s => s.trim()).filter(Boolean);
}

// Effective extras for a session = machine default (always applied) unioned
// with the session's own extras (explicit flags or persisted). Default first,
// deduped. Per the design there is intentionally no per-session opt-out.
export function resolveExtras(defaultExtras = [], sessionExtras = []) {
  return [...new Set([...defaultExtras, ...sessionExtras])];
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
