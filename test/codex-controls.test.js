import { describe, expect, it, vi } from 'vitest';
import { handleCodexControl, listCodexThreads, mergeCodexThreads, offerCodexBuild } from '../lib/codex-controls.js';
import { codexMcpConfig } from '../lib/codex-mcp.js';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
function setup() {
  const session = { alive: true, busy: false, codex: { transport: 'app-server', threadId: 'thread', planMode: false, ensureThread: vi.fn(async () => {}), rpc: vi.fn(async () => ({})) }, sendButtonMessage: vi.fn(() => true) };
  const opts = { reply: vi.fn(), send: vi.fn(() => true), persist: vi.fn(), beforeDispatch: vi.fn() };
  return { session, opts, run: text => handleCodexControl(session, text, opts) };
}
describe('Codex native controls', () => {
  it('enters read-only plan mode, publishes Build, and only implements on explicit approval', async () => {
    const h = setup(); await h.run('/plan examine the bridge');
    expect(h.session.codex.planMode).toBe(true); expect(h.opts.send).toHaveBeenCalledWith('examine the bridge');
    h.session._codexHadAssistantMessage = true;
    offerCodexBuild(h.session);
    expect(h.session._codexBuildValue).toMatch(/^codex-build:/);
    await h.run('build'); expect(h.session.codex.planMode).toBe(false);
    expect(h.opts.send).toHaveBeenLastCalledWith('Implement the agreed plan. Matron Build mode is now active.');
    expect(h.opts.persist).toHaveBeenLastCalledWith({ codexPlanMode: false });
  });
  it('does not mutate controls during an active turn or treat arbitrary text as a command', async () => {
    const h = setup(); h.session.busy = true;
    expect(await h.run('/plan')).toBe(true); expect(h.session.codex.planMode).toBe(false);
    expect(await h.run('hello')).toBe(false); expect(h.opts.send).not.toHaveBeenCalled();
  });
  it('does not treat prose beginning with build as permission to leave Plan mode', async () => {
    const h = setup(); h.session.codex.planMode = true;
    expect(await h.run('build the auth flow')).toBe(false);
    expect(h.session.codex.planMode).toBe(true);
    expect(h.opts.send).not.toHaveBeenCalled();
    expect(h.opts.beforeDispatch).not.toHaveBeenCalled();
  });
  it('uses the same bounded resume list on first lookup and cached lookup', async () => {
    const source = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
    const start = source.indexOf('async function availableCodexThreads(');
    const context = vm.createContext({ codexThreadLists: new Map(), AGENT_CODEX: 'codex', CODEX_APP_SERVER: true,
      listPersistedAgentSessions: () => [], mergeCodexThreads,
      listCodexThreads: vi.fn(async () => Array.from({ length: 20 }, (_, i) => ({ sessionId: `thread-${i}`, modified: 20 - i }))),
    });
    vm.runInContext(source.slice(start, source.indexOf('\n}\n', start) + 2), context);
    const first = await context.availableCodexThreads('/workspace', { cached: true, roomId: 'room' });
    const cached = await context.availableCodexThreads('/workspace', { cached: true, roomId: 'room' });
    expect(first).toHaveLength(15); expect(cached).toEqual(first);
    expect(context.listCodexThreads).toHaveBeenCalledTimes(1);
    expect(await context.availableCodexThreads(null)).toHaveLength(20);
  });
  it('uses device login, cancel, and account logout rather than model prompts', async () => {
    const h = setup(); h.session.codex.rpc.mockResolvedValue({ verificationUrl: 'https://auth.openai.com/codex/device', userCode: 'ABCD', loginId: 'login' });
    await h.run('/login'); expect(h.opts.reply).toHaveBeenCalledWith(expect.stringContaining('ABCD'));
    await h.run('/login cancel'); expect(h.session.codex.rpc).toHaveBeenCalledWith('account/login/cancel', { loginId: 'login' });
    await h.run('/logout'); expect(h.session.codex.rpc).toHaveBeenCalledWith('account/logout'); expect(h.opts.send).not.toHaveBeenCalled();
  });
  it('uses native MCP status and native compact controls', async () => {
    const h = setup(); h.session.codex.rpc.mockResolvedValue({ data: [{ name: 'ask-user', authStatus: 'notLoggedIn', tools: { request_secret: {} } }] });
    await h.run('/tools'); expect(h.opts.reply).toHaveBeenCalledWith(expect.stringContaining('request_secret'));
    await h.run('/compact'); expect(h.opts.send).toHaveBeenCalledWith('/compact');
    await h.run('/compact custom instructions'); expect(h.opts.send).toHaveBeenCalledTimes(1);
  });
  it('paginates native root-thread discovery and retains bridge conversation identity', async () => {
    const request = vi.fn().mockResolvedValueOnce({ data: [{ id: 'native', cwd: '/workspace', updatedAt: 10, preview: 'test' }], nextCursor: 'next' }).mockResolvedValueOnce({ data: [{ id: 'saved', updatedAt: 20 }], nextCursor: null });
    const threads = await listCodexThreads('/workspace', { query: fn => fn(request) });
    expect(request.mock.calls[0][1].sourceKinds).not.toContain('subAgent'); expect(request.mock.calls[1][1].cursor).toBe('next');
    expect(mergeCodexThreads(threads, [{ sessionId: 'saved', modified: 20001, journalConvoId: 'matron' }])[0]).toMatchObject({ sessionId: 'saved', journalConvoId: 'matron' });
  });
});
describe('Codex bridge MCP injection', () => {
  const baseConfig = { mcpServers: { 'ask-user': { command: 'node', args: ['./ask-user.js'] } }, mcpExtras: { share: { 'show-file': { command: 'node', args: ['./show-file-mcp.js'] } } } };
  it('uses absolute scripts and room-bound credentials without changing base configuration', () => {
    const result = codexMcpConfig({ baseConfig, extras: ['share'], bridgeDir: '/bridge', roomId: 'room-1', apiPort: 9802, showFileToken: 'private-token', nodePath: '/node/bin/node' });
    expect(result.mcp_servers['ask-user']).toMatchObject({ command: '/node/bin/node', args: ['/bridge/ask-user.js'], disabled_tools: ['permission_request'], env: { BRIDGE_ROOM_ID: 'room-1' } });
    expect(result.mcp_servers['show-file'].env.SHOW_FILE_TOKEN).toBe('private-token');
    expect(baseConfig.mcpServers['ask-user'].args).toEqual(['./ask-user.js']);
  });
  it('does not expose show-file without a pinned-root token', () => {
    const result = codexMcpConfig({ baseConfig, extras: ['share'], bridgeDir: '/bridge', roomId: 'room', apiPort: 9802 });
    expect(result.mcp_servers['show-file']).toBeUndefined();
  });
  it('handles URL-based entries without injecting local credentials or crashing', () => {
    const remoteConfig = { mcpServers: { 'ask-user': { url: 'https://example.test/ask' },
      'show-file': { url: 'https://example.test/share' } } };
    const options = { baseConfig: remoteConfig, bridgeDir: '/bridge', roomId: 'room', apiPort: 9802 };
    const result = codexMcpConfig(options);
    expect(result.mcp_servers['ask-user']).toMatchObject({ url: 'https://example.test/ask' });
    expect(result.mcp_servers['ask-user'].env).toBeUndefined();
    expect(result.mcp_servers['show-file']).toBeUndefined();
    expect(JSON.stringify(codexMcpConfig({ ...options, showFileToken: 'local-secret' }))).not.toContain('local-secret');
  });
});
