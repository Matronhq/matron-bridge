// Child-process environments for bridge-spawned agent sessions.
//
// These used to be object literals inline in index.js, which is an entrypoint
// with no exports, so "what does the child actually get" could only be tested
// by pinning how the literal was spelled. The builders return the env as data
// so tests can assert on the result instead.
//
// Credential scoping lives in lib/journal-cred-scope.js. Agent sessions go
// through stripBridgeOnlySecrets: HMAC_SECRET is removed, the journal token is
// kept because the session prompts use it for journal search (and, for Codex,
// the /items HTTP fallback).

import path from 'node:path';
import { stripBridgeOnlySecrets } from './journal-cred-scope.js';

// Prepend the directory of the node binary running the bridge to PATH (once).
// The ask-user MCP server and the matron-tee Bash hook both resolve `node` via
// PATH; when the bridge is launched non-interactively (e.g. launchd) nvm hasn't
// loaded and PATH lacks the node bin dir.
export function pathWithNodeBin(existingPath, execPath = process.execPath) {
  const nodeBinDir = path.dirname(execPath);
  const current = existingPath || '';
  return current.split(':').includes(nodeBinDir) ? current : `${nodeBinDir}:${current}`;
}

// Env for a Claude session child: the stream-json --print session and the
// interactive (PTY) session get the same shape.
export function buildClaudeSpawnEnv({
  baseEnv = process.env,
  execPath = process.execPath,
  roomId,
  apiPort,
  pluginCacheDir,
  showBashOutput,
  showFileToken,
} = {}) {
  if (baseEnv === null || typeof baseEnv !== 'object') {
    throw new TypeError('buildClaudeSpawnEnv: baseEnv must be an object');
  }
  const env = {
    ...stripBridgeOnlySecrets(baseEnv),
    PATH: pathWithNodeBin(baseEnv.PATH, execPath),
    CLAUDECODE: '',
    CLAUDE_CODE_MAX_OUTPUT_TOKENS: '128000',
    BRIDGE_ROOM_ID: roomId,
    MATRON_BRIDGE_API_PORT: String(apiPort),
    // Env is fixed at spawn time; toggling the flag later requires
    // !restart to take effect.
    MATRON_BASH_TEE_ENABLED: showBashOutput ? '1' : '0',
    CLAUDE_CODE_PLUGIN_CACHE_DIR: pluginCacheDir,
    // Load every MCP tool up front instead of letting Claude Code defer
    // them behind ToolSearch. With deferral on, the item_* tools (and the
    // rest of ask-user) reach the model only as names in a reminder, and a
    // tool that needs a schema lookup before its first call is a tool the
    // model reaches for last: a fleet survey on 2026-09-09 found not one
    // item_* call on any box other than the one whose sessions were
    // steered to them by hand, while questions went out as prose. The
    // cost is a larger (cached) tool prefix per request. Values: `false`
    // loads everything; `auto:N` defers past N% of context. Operators can
    // set it in the bridge's `.env` like any other setting (dotenv loads
    // that with `override: true` at startup, so `.env` beats the service
    // environment — the same rule as for every other bridge setting), and
    // whatever `process.env` holds by now wins over the default.
    ENABLE_TOOL_SEARCH: baseEnv.ENABLE_TOOL_SEARCH ?? 'false',
    // No MCP_TOOL_TIMEOUT default here. #254 briefly injected a 10-minute
    // backstop so a wedged MCP server couldn't hang a turn forever, but a
    // hard kill also cut off legitimately long calls (long builds, big test
    // runs, patient subagents). The slow-tool notices in index.js make a hung
    // call visible instead and leave the cancel decision with the user. An
    // operator who wants the hard cap can still set MCP_TOOL_TIMEOUT in the
    // bridge's own env; it passes through.
  };
  // The show-file token is per session: never inherit one from the bridge env.
  delete env.SHOW_FILE_TOKEN;
  if (showFileToken) env.SHOW_FILE_TOKEN = showFileToken;
  return env;
}

// Env for a Codex session child (app-server or legacy exec transport).
export function buildCodexSpawnEnv({ baseEnv = process.env, roomId, apiPort } = {}) {
  if (baseEnv === null || typeof baseEnv !== 'object') {
    throw new TypeError('buildCodexSpawnEnv: baseEnv must be an object');
  }
  return {
    ...stripBridgeOnlySecrets(baseEnv),
    BRIDGE_ROOM_ID: roomId,
    MATRON_BRIDGE_API_PORT: String(apiPort),
  };
}
