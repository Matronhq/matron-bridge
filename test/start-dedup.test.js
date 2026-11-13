import { describe, it, expect, vi } from 'vitest';
import { createRpcRequestHandler } from '../lib/journal-rpc.js';

function harness(overrides = {}) {
  const responses = [];
  const startSession = vi.fn(() => ({ journalConvoId: 'conversation' }));
  const handler = createRpcRequestHandler({
    respondRpc: (reply) => responses.push(reply),
    startSession,
    stopSession: vi.fn(),
    listPersistedSessions: () => [],
    defaultWorkdir: '/w',
    defaultAgent: 'claude',
    expandHome: (p) => p,
    statSync: () => ({ isDirectory: () => true }),
    log: { warn: () => {} },
    ...overrides,
  });
  return { handler, responses, startSession };
}
const request = (id, params = {}, device = 7) => ({ method: 'start', request_id: id, from_device_id: device, params });
const deferred = () => {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
};

describe('start retry outcomes', () => {
  it('replays a transport duplicate and an explicit key retry with the complete result', async () => {
    const h = harness({ startModelFallback: () => ({ model: 'opus', reason: 'fable_limit' }) });
    await h.handler(request('first', { idempotency_key: 'opening' }));
    await h.handler(request('retry', { idempotency_key: 'opening' }));
    await h.handler(request('transport'));
    await h.handler(request('transport'));
    expect(h.startSession).toHaveBeenCalledTimes(2);
    expect(h.responses.map((r) => r.result)).toEqual(Array(4).fill({ convo_id: 'conversation', model: 'opus', model_reason: 'fable_limit' }));
    expect(h.responses.map((r) => r.requestId)).toEqual(['first', 'retry', 'transport', 'transport']);
  });

  it('waits for model lookup before answering concurrent retries', async () => {
    const lookup = deferred();
    const h = harness({ startModelFallback: () => lookup.promise });
    const first = h.handler(request('first', { idempotency_key: 'opening' }));
    const retry = h.handler(request('retry', { idempotency_key: 'opening' }));
    expect(h.startSession).not.toHaveBeenCalled();
    expect(h.responses).toEqual([]);
    lookup.resolve({ model: 'opus', reason: 'fable_limit' });
    await Promise.all([first, retry]);
    expect(h.startSession).toHaveBeenCalledTimes(1);
    expect(h.responses[1].result).toEqual(h.responses[0].result);
  });

  it.each([true, false])('shares the final opening-turn outcome after joining: accepted=%s', async (accepted) => {
    const join = deferred();
    const injectTurn = vi.fn(() => accepted);
    const stopSession = vi.fn();
    const h = harness({ joinMission: () => join.promise, injectTurn, stopSession });
    const params = { workdir: '/w', prompt: 'Review the changes', mission_num: 1, idempotency_key: 'opening' };
    const first = h.handler(request('first', params));
    const retry = h.handler(request('retry', params));
    expect(h.responses).toEqual([]);
    join.resolve({ status: 200, body: {} });
    await Promise.all([first, retry]);
    expect(h.startSession).toHaveBeenCalledTimes(1);
    expect(injectTurn).toHaveBeenCalledTimes(1);
    expect(h.responses.map(({ requestId: _requestId, ...outcome }) => outcome)).toEqual([
      expect.objectContaining({ ok: accepted }), expect.objectContaining({ ok: accepted }),
    ]);
    expect(h.responses[1].result ?? h.responses[1].error).toEqual(h.responses[0].result ?? h.responses[0].error);
    await h.handler(request('later', params));
    expect(h.startSession).toHaveBeenCalledTimes(accepted ? 1 : 2);
    expect(stopSession).toHaveBeenCalledTimes(accepted ? 0 : 2);
  });

  it('retries thrown spawns and unsupported backends rather than caching failure', () => {
    const startSession = vi.fn()
      .mockImplementationOnce(() => { throw new Error('spawn unavailable'); })
      .mockReturnValueOnce({})
      .mockReturnValue({ journalConvoId: 'conversation' });
    const h = harness({ startSession });
    for (let i = 0; i < 4; i++) h.handler(request('same'));
    expect(startSession).toHaveBeenCalledTimes(3);
    expect(h.responses.map((r) => r.error?.code ?? r.ok)).toEqual(['spawn_failed', 'unsupported_mode', true, true]);
  });

  it('logs a rejected start handler and still answers once', async () => {
    const warn = vi.fn();
    const sent = [];
    let first = true;
    const h = harness({
      log: { warn },
      joinMission: async () => ({ status: 200, body: {} }),
      // The first reply throws inside the async mission path, so the start rejects.
      respondRpc: (reply) => { if (first) { first = false; throw new Error('send broke'); } sent.push(reply); },
    });
    await h.handler(request('first', { workdir: '/w', mission_num: 1 }));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('start handler rejected: send broke'));
    expect(sent).toHaveLength(1);
    expect(sent[0].ok).toBe(false);
  });

  it('scopes retry keys to the requesting device', () => {
    const h = harness();
    h.handler(request('same', { idempotency_key: 'opening' }, 7));
    h.handler(request('same', { idempotency_key: 'opening' }, 8));
    expect(h.startSession).toHaveBeenCalledTimes(2);
    expect(h.responses.map((r) => r.toDeviceId)).toEqual([7, 8]);
  });

  it('evicts completed successes in FIFO order without evicting pending starts', async () => {
    const lookup = deferred();
    const h = harness({ startDedupCap: 1, startModelFallback: vi.fn().mockReturnValueOnce(lookup.promise) });
    const pending = h.handler(request('pending'));
    h.handler(request('old'));
    h.handler(request('new'));
    h.handler(request('new'));
    const retry = h.handler(request('pending'));
    expect(h.startSession).toHaveBeenCalledTimes(2);
    h.handler(request('old'));
    expect(h.startSession).toHaveBeenCalledTimes(3);
    lookup.resolve(null);
    await Promise.all([pending, retry]);
    expect(h.startSession).toHaveBeenCalledTimes(4);
    expect(h.responses).toHaveLength(6);
  });
});
