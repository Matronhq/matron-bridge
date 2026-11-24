import { describe, it, expect, vi, afterEach } from 'vitest';
import { createClaudeSetup, claudeAuthorizationURL } from '../lib/claude-setup.js';

const url = 'https://claude.com/cai/oauth/authorize?state=fixture&code_challenge=fixture';
const setups = [];
function fixture(options = {}) {
  let data, exit;
  const proc = { write: vi.fn(), kill: vi.fn(), onData: (fn) => { data = fn; }, onExit: (fn) => { exit = fn; } };
  const readConnection = vi.fn(async () => ({ state: 'disconnected' }));
  const launch = vi.fn(async () => proc);
  const setup = createClaudeSetup({ readConnection, launch, ...options });
  setups.push(setup);
  return { setup, proc, launch, readConnection, data: (s) => data(s), exit: () => exit() };
}
afterEach(() => { setups.splice(0).forEach(s => s.dispose()); vi.useRealTimers(); });

describe('Claude setup', () => {
  it('accepts only complete provider authorization URLs', () => {
    expect(claudeAuthorizationURL(url)).toBeNull();
    expect(claudeAuthorizationURL('\u001b[32m' + url + '\u001b[0m\n')).toBe(url);
    for (const value of [url.replace('claude.com', 'example.com'), url.replace('https:', 'http:'),
      url.replace('claude.com', 'claude.com.example.com'), url.replace('/cai/oauth/authorize', '/other'),
      url.replace('claude.com', 'user@claude.com'), url.replace('state=fixture&', '')]) {
      expect(claudeAuthorizationURL(value + '\n')).toBeNull();
    }
  });
  it('skips login only on a confirmed connection', async () => {
    const f = fixture();
    f.readConnection.mockResolvedValue({ state: 'connected' });
    expect(await f.setup.request(1, { action: 'start' })).toEqual({ state: 'connected' });
    expect(f.launch).not.toHaveBeenCalled();
  });
  it('keeps codes off replies and sends them only to the owned PTY', async () => {
    const f = fixture();
    const started = await f.setup.request(1, { action: 'start' });
    f.data(url.slice(0, 40)); f.data(url.slice(40) + '\nPaste code:');
    expect(await f.setup.request(1, { flow_id: started.flow_id })).toMatchObject({ state: 'waiting', authorization_url: url });
    const code = 'synthetic-code-123456#synthetic-state';
    expect(await f.setup.request(2, { action: 'submit', flow_id: started.flow_id, code })).toEqual({ state: 'expired' });
    expect(f.proc.write).not.toHaveBeenCalled();
    const reply = await f.setup.request(1, { action: 'submit', flow_id: started.flow_id, code });
    expect(reply).toMatchObject({ state: 'checking' });
    expect(JSON.stringify(reply)).not.toContain(code);
    expect(reply.authorization_url).toBeUndefined();
    expect(f.proc.write).toHaveBeenCalledWith(code + '\r');
    f.readConnection.mockResolvedValue({ state: 'connected' });
    await f.exit();
    expect(await f.setup.request(1, { flow_id: started.flow_id })).toEqual({ state: 'connected' });
  });
  it('rejects terminal controls and never treats an exit as login success', async () => {
    const f = fixture();
    const started = await f.setup.request(1, { action: 'start' });
    f.data(url + '\n');
    expect(await f.setup.request(1, { action: 'submit', flow_id: started.flow_id, code: 'fixture-code-1234\ncommand' })).toMatchObject({ state: 'invalid_code' });
    expect(f.proc.write).not.toHaveBeenCalled();
    await f.exit();
    expect(await f.setup.request(1, { flow_id: started.flow_id })).toMatchObject({ state: 'failed' });
  });
  it('reuses an active flow and refuses another device', async () => {
    const f = fixture();
    const first = await f.setup.request(1, { action: 'start' });
    expect(await f.setup.request(1, { action: 'start' })).toEqual(first);
    expect(await f.setup.request(2, { action: 'start' })).toEqual({ state: 'busy' });
    expect(await f.setup.request(2, { flow_id: first.flow_id })).toEqual({ state: 'expired' });
    expect(await f.setup.request(2, { action: 'cancel', flow_id: first.flow_id })).toEqual({ state: 'expired' });
    expect(f.launch).toHaveBeenCalledTimes(1);
  });
  it('expires the process and drops the old link', async () => {
    vi.useFakeTimers();
    const f = fixture({ ttlMs: 100 });
    const first = await f.setup.request(1, { action: 'start' });
    f.data(url + '\n');
    vi.advanceTimersByTime(101);
    const result = await f.setup.request(1, { flow_id: first.flow_id });
    expect(result.state).toBe('expired');
    expect(result.authorization_url).toBeUndefined();
    expect(f.proc.kill).toHaveBeenCalledTimes(1);
  });
  it('contains launch failures without exposing their output', async () => {
    const f = fixture();
    f.launch.mockRejectedValue(new Error('private terminal output'));
    expect(await f.setup.request(1, { action: 'start' })).toEqual({ state: 'failed' });
    expect(await f.setup.request(0, { action: 'start' })).toEqual({ state: 'refused' });
  });
  it('lets a rejected code be corrected in the same flow', async () => {
    const f = fixture();
    const first = await f.setup.request(1, { action: 'start' });
    f.data(url + '\n');
    await f.setup.request(1, { action: 'submit', flow_id: first.flow_id, code: 'synthetic-wrong-code' });
    f.data("That code wasn't accepted. Make sure the full code was copied.\nPaste code here:");
    expect(await f.setup.request(1, { flow_id: first.flow_id })).toMatchObject({ state: 'invalid_code' });
    await f.setup.request(1, { action: 'submit', flow_id: first.flow_id, code: 'synthetic-correct-code' });
    expect(f.proc.write).toHaveBeenLastCalledWith('synthetic-correct-code\r');
    expect(f.launch).toHaveBeenCalledTimes(1);
  });
  it('stops a login on disposal and refuses another start', async () => {
    const f = fixture();
    await f.setup.request(1, { action: 'start' });
    f.setup.dispose();
    expect(f.proc.kill).toHaveBeenCalledTimes(1);
    expect(await f.setup.request(1, { action: 'start' })).toEqual({ state: 'unavailable' });
    expect(f.launch).toHaveBeenCalledTimes(1);
  });
  it('also kills a process whose spawn finishes after shutdown', async () => {
    let release;
    const f = fixture();
    f.launch.mockImplementation(() => new Promise(resolve => { release = resolve; }));
    const pending = f.setup.request(1, { action: 'start' });
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    f.setup.dispose();
    release(f.proc);
    expect(await pending).toEqual({ state: 'unavailable' });
    expect(f.proc.kill).toHaveBeenCalledTimes(1);
  });
});
