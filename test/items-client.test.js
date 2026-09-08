import { describe, it, expect, vi } from 'vitest';
import { createItemsClient } from '../lib/items-client.js';

function fakeFetch(handler) {
  const calls = [];
  const fetchImpl = vi.fn(async (url, init) => {
    calls.push({ url, init });
    const r = handler(url, init);
    return {
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      json: async () => r.body,
    };
  });
  return { fetchImpl, calls };
}

describe('createItemsClient', () => {
  it('lists with a filtered query string and bearer auth', async () => {
    const { fetchImpl, calls } = fakeFetch(() => ({ status: 200, body: { items: [], next_cursor: null } }));
    const c = createItemsClient({ baseUrl: 'https://j', token: 'tok', fetchImpl });
    const r = await c.list({ convo: 'c1', state: 'open', kind: undefined, since: null });
    expect(r).toEqual({ status: 200, data: { items: [], next_cursor: null } });
    expect(calls[0].url).toBe('https://j/items?convo=c1&state=open');
    expect(calls[0].init.headers.Authorization).toBe('Bearer tok');
    expect(calls[0].init.method).toBe('GET');
  });

  it('get URL-encodes #num', async () => {
    const { fetchImpl, calls } = fakeFetch(() => ({ status: 200, body: { item: {}, comments: [] } }));
    const c = createItemsClient({ baseUrl: 'https://j', token: 'tok', fetchImpl });
    await c.get('#12');
    expect(calls[0].url).toBe('https://j/items/%2312');
  });

  it('create posts JSON with an idempotency key header', async () => {
    const { fetchImpl, calls } = fakeFetch(() => ({ status: 201, body: { item: { id: 'it_1', num: 1 } } }));
    const c = createItemsClient({ baseUrl: 'https://j', token: 'tok', fetchImpl });
    const r = await c.create({ kind: 'task', title: 'T', convo_id: 'c1' }, { idemKey: 'k' });
    expect(r.status).toBe(201);
    expect(calls[0].init.method).toBe('POST');
    expect(calls[0].init.headers['Content-Type']).toBe('application/json');
    expect(calls[0].init.headers['Idempotency-Key']).toBe('k');
    expect(JSON.parse(calls[0].init.body)).toEqual({ kind: 'task', title: 'T', convo_id: 'c1' });
  });

  it('setTranscript PATCHes the comment sub-route', async () => {
    const { fetchImpl, calls } = fakeFetch(() => ({ status: 200, body: { comment: {} } }));
    const c = createItemsClient({ baseUrl: 'https://j', token: 'tok', fetchImpl });
    await c.setTranscript('it_1', 'ic_2', { blob_ref: 'b', transcript: 'hi' });
    expect(calls[0].url).toBe('https://j/items/it_1/comments/ic_2');
    expect(calls[0].init.method).toBe('PATCH');
  });

  it('update PATCHes the item route', async () => {
    const { fetchImpl, calls } = fakeFetch(() => ({ status: 200, body: { item: { id: 'it_1', status: 'in_progress' } } }));
    const c = createItemsClient({ baseUrl: 'https://j', token: 'tok', fetchImpl });
    const r = await c.update('it_1', { status: 'in_progress' });
    expect(r.status).toBe(200);
    expect(calls[0].url).toBe('https://j/items/it_1');
    expect(calls[0].init.method).toBe('PATCH');
    expect(calls[0].init.headers['Content-Type']).toBe('application/json');
    expect(JSON.parse(calls[0].init.body)).toEqual({ status: 'in_progress' });
  });

  it('non-2xx passes status and error body through; transport failure is status 0', async () => {
    const { fetchImpl } = fakeFetch(() => ({ status: 409, body: { error: 'conflict' } }));
    const c = createItemsClient({ baseUrl: 'https://j', token: 'tok', fetchImpl });
    expect(await c.close('it_1', { resolution: 'done' })).toEqual({ status: 409, data: { error: 'conflict' } });
    const boom = createItemsClient({ baseUrl: 'https://j', token: 'tok', fetchImpl: vi.fn(async () => { throw new Error('ECONNREFUSED'); }) });
    expect(await boom.list({})).toEqual({ status: 0, data: { error: 'journal unreachable' } });
    const none = createItemsClient({ baseUrl: '', token: 'tok', fetchImpl });
    expect(await none.list({})).toEqual({ status: 0, data: { error: 'journal unreachable' } });
  });
});
