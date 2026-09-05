import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { wireCodexAppSession } from '../lib/codex-app-wiring.js';
const settle = () => new Promise(resolve => setImmediate(resolve));
function setup(extraOptions = {}) {
  const codex = Object.assign(new EventEmitter(), { threadId: 'parent', turnId: 'turn', childThreads: new Set(), rpc: vi.fn(async () => ({})), client: { respond: vi.fn(() => true), rejectRequest: vi.fn() } });
  const session = { codex, workdir: '/missing-test-workdir', alive: true, busy: true, showBashOutput: true };
  const publisher = Object.fromEntries(['streamAppend', 'stream', 'endStream', 'upsertConvo', 'publishText', 'finalizeToolOutput'].map(n => [n, vi.fn(() => true)]));
  publisher.uploadMedia = vi.fn(async () => ({ media_id: 'blob-1' }));
  const options = { publisher, convoIdFor: () => 'convo', stream: vi.fn(), activity: vi.fn(), status: vi.fn(), notice: vi.fn(), publishPrompt: vi.fn(() => true), publishText: vi.fn(), ...extraOptions };
  wireCodexAppSession(session, options);
  return { codex, session, publisher, ...options };
}
describe('Codex journal publication', () => {
  it('publishes completed async question messages as cards that survive normal turn completion', async () => {
    const submitAsyncAnswer = vi.fn(() => true);
    const h = setup({ submitAsyncAnswer });
    const item = { id: 'question', type: 'agentMessage', text: '', delivery: 'async', questions: [
      { title: 'What should we test?', options: ['Token usage', 'Model switching'] },
    ] };
    h.codex.emit('item', { method: 'item/started', item, turnId: 'turn' }); await settle();
    expect(h.publishPrompt).not.toHaveBeenCalled();
    h.codex.emit('item', { method: 'item/completed', item, turnId: 'turn' }); await settle();
    expect(h.publishPrompt).toHaveBeenCalledWith(h.session, expect.objectContaining({
      question: 'What should we test?', options: [expect.objectContaining({ label: 'Token usage' }), expect.objectContaining({ label: 'Model switching' })],
    }));
    expect(h.session._codexAwaitingAnswer).toBe(false);
    h.session.busy = false; h.codex.emit('requests-cleared'); h.codex.emit('turn-exit', { code: 0 });
    expect(h.session.codexPrompts.answer({ choice: h.session.codexPrompts.active.options[1].value })).toBe('Model switching');
    expect(submitAsyncAnswer).toHaveBeenCalledWith(h.session, 'What should we test?\nModel switching');
    expect(h.codex.client.respond).not.toHaveBeenCalled();
  });
  it('clears async cards on disconnect, interruption, or shutdown', () => {
    for (const [event, data] of [['connection-reset'], ['turn-exit', { code: 1 }], ['closed']]) {
      const h = setup();
      h.codex.emit('item', { method: 'item/completed', turnId: 'turn', item: {
        id: 'question', type: 'agentMessage', delivery: 'async', questions: [{ title: 'Name?', options: null }],
      } });
      h.codex.emit(event, data);
      expect(h.session.codexPrompts.active).toBeNull();
      expect(h.codex.client.respond).not.toHaveBeenCalled();
    }
  });
  it('publishes cumulative text with stable item identity and redaction', () => {
    const h = setup();
    h.codex.emit('text-delta', { turnId: 'turn', itemId: 'msg', delta: 'Hello ' });
    h.codex.emit('text-delta', { turnId: 'turn', itemId: 'msg', delta: 'world' });
    expect(h.stream.mock.calls.map(c => c[2])).toEqual(['Hello ', 'Hello world']);
    expect(h.stream.mock.calls[0][1]).toBe(h.stream.mock.calls[1][1]);
    expect(h.session.codexSafeOutput('API_TOKEN=private-value')).not.toContain('private-value');
    expect(h.session.codexSafeOutput('-----BEGIN PRIVATE KEY-----\nprivate-value')).not.toContain('private-value');
    h.session.alive = false; h.codex.emit('text-delta', { delta: 'stale' }); expect(h.stream).toHaveBeenCalledTimes(2);
  });
  it('streams redacted command output with UTF-8 offsets then finalizes the log', async () => {
    const h = setup(); const item = { id: 'cmd', type: 'commandExecution', command: 'npm test' };
    h.codex.emit('item', { method: 'item/started', item, turnId: 'turn' });
    h.codex.emit('output-delta', { turnId: 'turn', itemId: 'cmd', delta: '✓ passed\nAPI_TO' });
    h.codex.emit('output-delta', { turnId: 'turn', itemId: 'cmd', delta: 'KEN=hidden\n' });
    expect(h.publisher.streamAppend.mock.calls[1][2]).toBe(Buffer.byteLength('✓ passed\n'));
    expect(h.publisher.streamAppend.mock.calls.map(c => c[3]).join('')).not.toContain('hidden');
    h.codex.emit('item', { method: 'item/completed', item: { ...item, exitCode: 0 }, turnId: 'turn' }); await settle();
    expect(h.publisher.finalizeToolOutput).toHaveBeenCalledWith('convo', expect.any(String), expect.objectContaining({ exit_code: 0, blob_ref: 'blob-1' }), 'blob-1');
    expect(h.publisher.uploadMedia.mock.calls[0][0].bytes.toString()).not.toContain('hidden');
  });
  it('keeps child output out of the parent and records terminal outcomes', () => {
    const h = setup(); h.codex.emit('child-discovered', { id: 'child', item: { prompt: 'Review' } });
    expect(h.publisher.upsertConvo).toHaveBeenCalledWith('convo:sub:codex-child', expect.objectContaining({ parentConvoId: 'convo' }));
    h.codex.emit('child-event', { method: 'item/completed', params: { threadId: 'child', turnId: 't', item: { id: 'm', type: 'agentMessage', text: 'Child result' } } });
    expect(h.publisher.publishText).toHaveBeenCalledWith('convo:sub:codex-child', expect.objectContaining({ body: 'Child result' }));
    expect(h.publishText).not.toHaveBeenCalled();
    h.codex.emit('children-state', { agentsStates: { child: { status: 'completed' } } });
    expect(h.publisher.upsertConvo).toHaveBeenLastCalledWith('convo:sub:codex-child', { sessionState: 'done', sessionOutcome: 'completed', parentConvoId: 'convo' });
  });
  it('routes root approvals and refuses foreign-thread approvals', async () => {
    const h = setup(); h.codex.emit('request', { id: 1, method: 'item/commandExecution/requestApproval', params: { threadId: 'foreign' } });
    expect(h.codex.client.rejectRequest).toHaveBeenCalledWith(1);
    h.codex.emit('request', { id: 2, method: 'item/commandExecution/requestApproval', params: { threadId: 'parent', command: 'gh pr create' } }); await settle();
    expect(h.session._codexAwaitingAnswer).toBe(true);
    h.codex.emit('requests-cleared');
    expect(h.codex.client.respond).toHaveBeenCalledWith(2, { decision: 'decline' });
    expect(h.session._codexAwaitingAnswer).toBe(false);
  });
  it('uses absolute native token totals and context without estimating money', () => {
    const h = setup(); h.codex.emit('usage', { total: { inputTokens: 100, cachedInputTokens: 30, outputTokens: 20 }, last: { inputTokens: 40 }, modelContextWindow: 1000 });
    expect(h.session._codexNativeUsage).toMatchObject({ input_tokens: 100, cache_read: 30, output_tokens: 20, cost_usd: 0 });
    expect(h.session._lastContextTokens).toBe(40); expect(h.session._codexUsageRevision).toBe(1);
  });
  it('ends orphaned child views on reconnect and allows rediscovery', () => {
    const h = setup(); h.codex.childThreads.add('child');
    h.codex.emit('child-discovered', { id: 'child', item: {} });
    h.codex.emit('turn-exit', { code: 0 });
    h.codex.emit('connection-reset');
    expect(h.publisher.upsertConvo).toHaveBeenLastCalledWith('convo:sub:codex-child', expect.objectContaining({
      sessionState: 'done', sessionOutcome: 'interrupted',
    }));
    expect(h.codex.childThreads.has('child')).toBe(false);
    expect(h.notice).toHaveBeenCalledWith(h.session, expect.stringContaining('reconnected'));
    h.codex.emit('child-discovered', { id: 'child', item: {} });
    expect(h.publisher.upsertConvo).toHaveBeenLastCalledWith('convo:sub:codex-child', expect.objectContaining({ sessionState: 'running' }));
  });
  it('prunes completed children so more than 64 lifetime children can be displayed', () => {
    const h = setup();
    for (let i = 0; i < 70; i++) {
      const id = `child-${i}`; h.codex.childThreads.add(id);
      h.codex.emit('child-discovered', { id, item: {} });
      h.codex.emit('children-state', { agentsStates: { [id]: { status: 'completed' } } });
      h.codex.emit('turn-exit', { code: 0 });
      expect(h.codex.childThreads.has(id)).toBe(false);
    }
    expect(h.codex.rpc).toHaveBeenCalledTimes(70);
    expect(h.publisher.upsertConvo).toHaveBeenLastCalledWith('convo:sub:codex-child-69', expect.objectContaining({ sessionOutcome: 'completed' }));
  });
  it('allows child discovery to retry after recovery-state persistence fails', () => {
    const runningStore = { add: vi.fn().mockReturnValueOnce(false).mockReturnValue(true) };
    const h = setup({ runningStore }); h.codex.childThreads.add('child');
    h.codex.emit('child-discovered', { id: 'child', item: {} });
    expect(h.codex.childThreads.has('child')).toBe(false);
    expect(h.publisher.upsertConvo).not.toHaveBeenCalled();
    h.codex.childThreads.add('child'); h.codex.emit('child-discovered', { id: 'child', item: {} });
    expect(h.publisher.upsertConvo).toHaveBeenCalledWith('convo:sub:codex-child', expect.objectContaining({ sessionState: 'running' }));
  });
});
