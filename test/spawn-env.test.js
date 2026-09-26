// Behavioral tests for the agent-session child envs (lib/spawn-env.js):
// assert what the child gets rather than how index.js spells the literal.
import { describe, it, expect } from 'vitest';
import { buildClaudeSpawnEnv, buildCodexSpawnEnv, pathWithNodeBin } from '../lib/spawn-env.js';

const EXEC = '/opt/node/bin/node';
const BRIDGE_ENV = Object.freeze({
  PATH: '/usr/bin:/bin',
  HOME: '/home/bridge',
  JOURNAL_TOKEN: 'agent-token',
  JOURNAL_TOKEN_FILE: '/etc/matron/agent-token',
  JOURNAL_WS_URL: 'wss://journal.example/ws',
  HMAC_SECRET: 'viewer-signing-key',
  SHOW_FILE_TOKEN: 'inherited-show-file',
  CLAUDECODE: '1',
  MCP_TOOL_TIMEOUT: '600000',
});

function claude(overrides = {}) {
  return buildClaudeSpawnEnv({
    baseEnv: BRIDGE_ENV,
    execPath: EXEC,
    roomId: '!room:example',
    apiPort: 8787,
    pluginCacheDir: '/var/cache/plugins',
    showBashOutput: true,
    showFileToken: 'session-show-file',
    ...overrides,
  });
}

describe('buildClaudeSpawnEnv', () => {
  it('strips HMAC_SECRET', () => {
    const env = claude();
    expect('HMAC_SECRET' in env).toBe(false);
    expect(Object.values(env)).not.toContain('viewer-signing-key');
  });

  it('keeps the journal token the session prompt uses for journal search', () => {
    const env = claude();
    expect(env.JOURNAL_TOKEN).toBe('agent-token');
    expect(env.JOURNAL_TOKEN_FILE).toBe('/etc/matron/agent-token');
    expect(env.JOURNAL_WS_URL).toBe('wss://journal.example/ws');
  });

  it('passes the rest of the bridge env through', () => {
    const env = claude();
    expect(env.HOME).toBe('/home/bridge');
    expect(env.MCP_TOOL_TIMEOUT).toBe('600000');
  });

  it('never mutates the base env', () => {
    const base = { ...BRIDGE_ENV };
    claude({ baseEnv: base });
    expect(base).toEqual(BRIDGE_ENV);
  });

  it('sets the session wiring keys', () => {
    const env = claude();
    expect(env.CLAUDECODE).toBe('');
    expect(env.CLAUDE_CODE_MAX_OUTPUT_TOKENS).toBe('128000');
    expect(env.BRIDGE_ROOM_ID).toBe('!room:example');
    expect(env.MATRON_BRIDGE_API_PORT).toBe('8787');
    expect(env.CLAUDE_CODE_PLUGIN_CACHE_DIR).toBe('/var/cache/plugins');
    expect(env.MATRON_BASH_TEE_ENABLED).toBe('1');
    expect(claude({ showBashOutput: false }).MATRON_BASH_TEE_ENABLED).toBe('0');
  });

  it('prepends the node bin dir to PATH once', () => {
    expect(claude().PATH).toBe('/opt/node/bin:/usr/bin:/bin');
    expect(claude({ baseEnv: { ...BRIDGE_ENV, PATH: '/usr/bin:/opt/node/bin' } }).PATH).toBe('/usr/bin:/opt/node/bin');
    expect(claude({ baseEnv: {} }).PATH).toBe('/opt/node/bin:');
  });

  it('loads MCP tools up front unless the bridge env says otherwise', () => {
    expect(claude().ENABLE_TOOL_SEARCH).toBe('false');
    expect(claude({ baseEnv: { ...BRIDGE_ENV, ENABLE_TOOL_SEARCH: 'auto:10' } }).ENABLE_TOOL_SEARCH).toBe('auto:10');
    // `??`, not `||`: an explicit empty string is the operator's choice.
    expect(claude({ baseEnv: { ...BRIDGE_ENV, ENABLE_TOOL_SEARCH: '' } }).ENABLE_TOOL_SEARCH).toBe('');
  });

  it('carries only the per-session SHOW_FILE_TOKEN, never an inherited one', () => {
    expect(claude().SHOW_FILE_TOKEN).toBe('session-show-file');
    expect('SHOW_FILE_TOKEN' in claude({ showFileToken: undefined })).toBe(false);
  });

  it('rejects a non-object base env', () => {
    expect(() => claude({ baseEnv: null })).toThrow(TypeError);
    expect(() => claude({ baseEnv: 'nope' })).toThrow(TypeError);
  });
});

describe('buildCodexSpawnEnv', () => {
  const codex = (overrides = {}) => buildCodexSpawnEnv({
    baseEnv: BRIDGE_ENV, roomId: '!room:example', apiPort: 8787, ...overrides,
  });

  it('strips HMAC_SECRET', () => {
    expect('HMAC_SECRET' in codex()).toBe(false);
  });

  it('keeps the journal token (journal search and the /items HTTP fallback use it)', () => {
    expect(codex().JOURNAL_TOKEN).toBe('agent-token');
    expect(codex().JOURNAL_TOKEN_FILE).toBe('/etc/matron/agent-token');
  });

  it('sets the bridge wiring keys and passes the rest through', () => {
    const env = codex();
    expect(env.BRIDGE_ROOM_ID).toBe('!room:example');
    expect(env.MATRON_BRIDGE_API_PORT).toBe('8787');
    expect(env.PATH).toBe('/usr/bin:/bin');
    expect(env.JOURNAL_WS_URL).toBe('wss://journal.example/ws');
  });

  it('never mutates the base env', () => {
    const base = { ...BRIDGE_ENV };
    codex({ baseEnv: base });
    expect(base).toEqual(BRIDGE_ENV);
  });

  it('rejects a non-object base env', () => {
    expect(() => codex({ baseEnv: 'nope' })).toThrow(TypeError);
  });
});

describe('pathWithNodeBin', () => {
  it('matches whole PATH entries, not substrings', () => {
    expect(pathWithNodeBin('/opt/node/bin-old:/usr/bin', EXEC)).toBe('/opt/node/bin:/opt/node/bin-old:/usr/bin');
  });
});
