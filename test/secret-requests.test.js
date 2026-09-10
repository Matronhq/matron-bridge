import { describe, it, expect, beforeEach } from 'vitest';
import {
  createSecretRequests,
  formatSecretChatNotice,
  formatSecretItemBody,
  SECRET_REQUEST_TTL_MS,
} from '../lib/secret-requests.js';

// Item #120: request_secret is non-blocking. The bridge files a tracker
// question, posts the link, and delivers the answer as a turn whenever it
// lands (up to 24 h later) — so every piece of that lifecycle lives here,
// with the clock, the timers, the filesystem, the journal and the delivery
// seam injected. No test ever handles a real secret: DUMMY is the only value.
const DUMMY = 'dummy-value-not-a-secret';

// A hand-cranked scheduler: arm() records the callback and its delay, tick()
// fires everything due. Vitest's fake timers would work too, but the store
// takes setTimer/clearTimer injected precisely so the tests can assert an
// expiry was ARMED (and cancelled) rather than infer it from wall time.
function makeScheduler() {
  let seq = 0;
  const armed = new Map();
  return {
    armed,
    setTimer: (fn, delay) => {
      const id = ++seq;
      armed.set(id, { fn, delay });
      return id;
    },
    clearTimer: (id) => { armed.delete(id); },
    fire: (id) => {
      const entry = armed.get(id);
      armed.delete(id);
      return entry.fn();
    },
    // Fire every timer whose delay is <= ms, oldest first.
    fireDue: async (ms) => {
      for (const [id, entry] of [...armed]) {
        if (entry.delay <= ms) {
          armed.delete(id);
          await entry.fn();
        }
      }
    },
    only: () => {
      const entries = [...armed.values()];
      expect(entries.length).toBe(1);
      return entries[0];
    },
  };
}

function makeItems(overrides = {}) {
  const calls = { create: [], close: [], comment: [] };
  return {
    calls,
    create: async (body) => {
      calls.create.push(body);
      return overrides.createResult ?? { status: 201, data: { item: { id: 'it_abc', num: 120 } } };
    },
    close: async (id, body) => {
      calls.close.push({ id, body });
      return overrides.closeResult ?? { status: 200, data: { item: { id, num: 120 } } };
    },
    comment: async (id, body) => {
      calls.comment.push({ id, body });
      return { status: 201, data: {} };
    },
  };
}

function makeHarness(opts = {}) {
  const scheduler = makeScheduler();
  const items = opts.items ?? makeItems();
  const files = new Map();
  const removed = [];
  const turns = [];
  const notices = [];
  let saved = opts.initial ?? null;
  let clock = opts.startAt ?? 1_000_000;

  const store = createSecretRequests({
    load: () => saved,
    save: (data) => { saved = JSON.parse(JSON.stringify(data)); },
    now: () => clock,
    setTimer: scheduler.setTimer,
    clearTimer: scheduler.clearTimer,
    newId: opts.newId ?? (() => 'sec-1'),
    writeSecretFile: opts.writeSecretFile ?? ((secretId, value) => {
      files.set(secretId, value);
      return `/tmp/secrets/${secretId}.txt`;
    }),
    removeSecretFile: (p) => removed.push(p),
    items,
    generateLink: opts.generateLink
      ?? ((secretId, { multiline }) => `https://viewer.example/secret?token=t-${secretId}${multiline ? '-ml' : ''}`),
    notifyChat: (record, info) => notices.push({ record, info }),
    deliverTurn: async (record, text) => { turns.push({ roomId: record.roomId, text }); },
    log: { warn: () => {}, log: () => {} },
    ...(opts.ttlMs ? { ttlMs: opts.ttlMs } : {}),
    ...(opts.fileTtlMs ? { fileTtlMs: opts.fileTtlMs } : {}),
  });

  return {
    store, scheduler, items, files, removed, turns, notices,
    get saved() { return saved; },
    advance: (ms) => { clock += ms; },
    get clock() { return clock; },
  };
}

describe('formatSecretChatNotice', () => {
  it('names the label, links the form, and shows the item number and window', () => {
    const { plain, html } = formatSecretChatNotice({
      label: 'AWS access key',
      link: 'https://v/secret?token=abc',
      itemNum: 120,
    });
    expect(plain).toBe('🔐 Secret requested: AWS access key — [Enter secret](https://v/secret?token=abc) (#120, 24 h)');
    expect(html).toContain('<b>AWS access key</b>');
    expect(html).toContain('<a href="https://v/secret?token=abc">Enter secret</a>');
    expect(html).toContain('(#120, 24 h)');
  });

  it('escapes the label in the HTML variant', () => {
    const { html } = formatSecretChatNotice({ label: '<img src=x>', link: 'https://v/s', itemNum: 1 });
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;img src=x&gt;');
  });

  it('drops the item number when the item could not be filed', () => {
    const { plain } = formatSecretChatNotice({ label: 'token', link: 'https://v/s', itemNum: null });
    expect(plain).toBe('🔐 Secret requested: token — [Enter secret](https://v/s) (24 h)');
  });

  it('says so plainly when the viewer is not configured', () => {
    const { plain, html } = formatSecretChatNotice({ label: 'token', link: null, itemNum: 7 });
    expect(plain).toBe('🔐 Secret requested: token (viewer not configured)');
    expect(html).toBe(null);
  });
});

describe('formatSecretItemBody', () => {
  it('explains the need, links the form, and states the expiry and the file handoff', () => {
    const body = formatSecretItemBody({
      label: 'AWS access key',
      link: 'https://v/secret?token=abc',
      expiresAt: Date.parse('2026-09-11T10:00:00.000Z'),
    });
    expect(body).toContain('AWS access key');
    expect(body).toContain('[Enter secret](https://v/secret?token=abc)');
    expect(body).toContain('Expires 2026-09-11T10:00:00.000Z.');
    expect(body).toContain('The value is written to a file the agent reads; it never enters chat.');
  });

  it('never renders a link element when there is no link', () => {
    const body = formatSecretItemBody({ label: 'token', link: null, expiresAt: 0 });
    expect(body).not.toContain('](');
    expect(body).toContain('viewer is not configured');
  });
});

describe('createSecretRequests.create', () => {
  it('files a question item with the secret label, the link and the 24 h expiry', async () => {
    const h = makeHarness();
    const res = await h.store.create({ label: 'AWS access key', roomId: '!room', convoId: 'convo-1' });

    expect(res.secretId).toBe('sec-1');
    expect(res.itemNum).toBe(120);
    expect(res.itemId).toBe('it_abc');
    expect(res.itemError).toBeFalsy();

    expect(h.items.calls.create.length).toBe(1);
    const body = h.items.calls.create[0];
    expect(body.kind).toBe('question');
    expect(body.title).toBe('Secret needed: AWS access key');
    expect(body.labels).toEqual(['secret']);
    expect(body.convo_id).toBe('convo-1');
    expect(body.body).toContain('[Enter secret](https://viewer.example/secret?token=t-sec-1)');
  });

  it('posts the chat notice with the link and the item number', async () => {
    const h = makeHarness();
    await h.store.create({ label: 'DB password', roomId: '!room', convoId: 'convo-1' });
    expect(h.notices.length).toBe(1);
    expect(h.notices[0].info.link).toBe('https://viewer.example/secret?token=t-sec-1');
    expect(h.notices[0].info.itemNum).toBe(120);
    expect(h.notices[0].info.plain).toContain('🔐 Secret requested: DB password');
    expect(h.notices[0].info.plain).toContain('(#120, 24 h)');
  });

  it('asks for a link valid for the whole 24 h request lifetime, not the short file-link window', async () => {
    const seen = [];
    const h = makeHarness({
      generateLink: (secretId, opts) => { seen.push({ secretId, ...opts }); return 'https://v/s'; },
    });
    await h.store.create({ label: 'k', roomId: '!room', convoId: 'c', multiline: true });
    expect(seen[0].ttlMs).toBe(SECRET_REQUEST_TTL_MS);
    expect(seen[0].multiline).toBe(true);
    expect(seen[0].label).toBe('k');
    expect(seen[0].roomId).toBe('!room');
  });

  it('persists only the non-sensitive record fields', async () => {
    const h = makeHarness();
    await h.store.create({ label: 'k', roomId: '!room', convoId: 'convo-1', multiline: true });
    const rec = h.saved.requests[0];
    expect(Object.keys(rec).sort()).toEqual(
      ['createdAt', 'expiresAt', 'itemId', 'itemNum', 'label', 'multiline', 'roomId', 'secretId'],
    );
    expect(rec.expiresAt - rec.createdAt).toBe(SECRET_REQUEST_TTL_MS);
    expect(JSON.stringify(h.saved)).not.toContain('convo-1');
    expect(JSON.stringify(h.saved)).not.toContain('/tmp/secrets');
  });

  it('arms an expiry timer 24 h out', async () => {
    const h = makeHarness();
    await h.store.create({ label: 'k', roomId: '!room', convoId: 'c' });
    expect(h.scheduler.only().delay).toBe(SECRET_REQUEST_TTL_MS);
  });

  it('still returns a usable request when the item could not be filed', async () => {
    const items = makeItems({ createResult: { status: 0, data: { error: 'journal unreachable' } } });
    const h = makeHarness({ items });
    const res = await h.store.create({ label: 'k', roomId: '!room', convoId: 'c' });
    expect(res.secretId).toBe('sec-1');
    expect(res.itemNum).toBe(null);
    expect(res.itemError).toBe('journal unreachable');
    // The request itself is live regardless — the link still works.
    expect(h.saved.requests.length).toBe(1);
    expect(h.notices[0].info.plain).not.toContain('#');
  });

  it('skips the item (and says why) when the session has no journal conversation', async () => {
    const h = makeHarness();
    const res = await h.store.create({ label: 'k', roomId: '!room', convoId: null });
    expect(h.items.calls.create.length).toBe(0);
    expect(res.itemError).toMatch(/journal conversation/i);
    expect(h.saved.requests[0].itemId).toBe(null);
  });
});

describe('createSecretRequests.submit', () => {
  it('writes the value verbatim and reports the path', async () => {
    const h = makeHarness();
    await h.store.create({ label: 'k', roomId: '!room', convoId: 'c' });
    const multi = `line1\r\nline2\n\n`;
    const res = await h.store.submit('sec-1', multi);
    await res.done;
    expect(res.ok).toBe(true);
    expect(res.path).toBe('/tmp/secrets/sec-1.txt');
    expect(h.files.get('sec-1')).toBe(multi);
  });

  it('closes the item as answered with a comment that names no value', async () => {
    const h = makeHarness();
    await h.store.create({ label: 'k', roomId: '!room', convoId: 'c' });
    const res = await h.store.submit('sec-1', DUMMY);
    await res.done;
    expect(h.items.calls.close.length).toBe(1);
    expect(h.items.calls.close[0].id).toBe('it_abc');
    expect(h.items.calls.close[0].body.resolution).toBe('answered');
    expect(h.items.calls.close[0].body.comment).toMatch(/^Submitted at \d{4}-\d\d-\d\dT.*\.$/);
    expect(JSON.stringify(h.items.calls)).not.toContain(DUMMY);
  });

  it('delivers the answer as a turn naming the label and the path', async () => {
    const h = makeHarness();
    await h.store.create({ label: 'AWS access key', roomId: '!room', convoId: 'c' });
    const res = await h.store.submit('sec-1', DUMMY);
    await res.done;
    expect(h.turns).toEqual([{
      roomId: '!room',
      text: '🔐 Secret "AWS access key" submitted — read it from /tmp/secrets/sec-1.txt',
    }]);
    expect(JSON.stringify(h.turns)).not.toContain(DUMMY);
  });

  it('cancels the expiry timer, drops the record from the store, and schedules file cleanup', async () => {
    const h = makeHarness({ fileTtlMs: 3600000 });
    await h.store.create({ label: 'k', roomId: '!room', convoId: 'c' });
    const res = await h.store.submit('sec-1', DUMMY);
    await res.done;
    expect(h.saved.requests).toEqual([]);
    // Only the 1 h file cleanup remains armed — the 24 h expiry is gone.
    expect(h.scheduler.only().delay).toBe(3600000);
    await h.scheduler.fireDue(3600000);
    expect(h.removed).toEqual(['/tmp/secrets/sec-1.txt']);
  });

  it('rejects a second submission of the same request', async () => {
    const h = makeHarness();
    await h.store.create({ label: 'k', roomId: '!room', convoId: 'c' });
    await (await h.store.submit('sec-1', DUMMY)).done;
    const again = await h.store.submit('sec-1', DUMMY);
    expect(again.ok).toBe(false);
    expect(again.status).toBe(404);
  });

  it('rejects an unknown id and a non-string value without touching the filesystem', async () => {
    const h = makeHarness();
    await h.store.create({ label: 'k', roomId: '!room', convoId: 'c' });
    expect((await h.store.submit('nope', DUMMY)).status).toBe(404);
    const bad = await h.store.submit('sec-1', '');
    expect(bad.ok).toBe(false);
    expect(bad.status).toBe(400);
    expect(h.files.size).toBe(0);
  });

  it('leaves the request pending when the file write fails', async () => {
    const h = makeHarness({
      writeSecretFile: () => { throw new Error('EACCES'); },
    });
    await h.store.create({ label: 'k', roomId: '!room', convoId: 'c' });
    const res = await h.store.submit('sec-1', DUMMY);
    expect(res.ok).toBe(false);
    expect(res.status).toBe(500);
    expect(res.error).toContain('EACCES');
    expect(h.saved.requests.length).toBe(1);
    expect(h.turns).toEqual([]);
  });

  it('still delivers the turn when closing the item fails', async () => {
    const items = makeItems({ closeResult: { status: 0, data: { error: 'journal unreachable' } } });
    const h = makeHarness({ items });
    await h.store.create({ label: 'k', roomId: '!room', convoId: 'c' });
    const res = await h.store.submit('sec-1', DUMMY);
    await res.done;
    expect(h.turns.length).toBe(1);
  });
});

describe('createSecretRequests.read (legacy GET compatibility)', () => {
  it('reports pending, then answered once, then forgets', async () => {
    const h = makeHarness();
    await h.store.create({ label: 'k', roomId: '!room', convoId: 'c' });
    expect(h.store.read('sec-1')).toEqual({ answered: false, path: null });
    await (await h.store.submit('sec-1', DUMMY)).done;
    expect(h.store.read('sec-1')).toEqual({ answered: true, path: '/tmp/secrets/sec-1.txt' });
    expect(h.store.read('sec-1')).toBe(null);
    expect(h.store.read('unknown')).toBe(null);
  });
});

describe('createSecretRequests expiry', () => {
  it('closes the item as cancelled and tells the agent when 24 h pass', async () => {
    const h = makeHarness();
    await h.store.create({ label: 'AWS access key', roomId: '!room', convoId: 'c' });
    h.advance(SECRET_REQUEST_TTL_MS);
    await h.scheduler.fireDue(SECRET_REQUEST_TTL_MS);

    expect(h.items.calls.close[0].body).toEqual({
      resolution: 'cancelled',
      comment: 'Expired without a submission.',
    });
    expect(h.turns).toEqual([{
      roomId: '!room',
      text: '🔐 Secret "AWS access key" request expired (24 h) — ask again if still needed.',
    }]);
    expect(h.saved.requests).toEqual([]);
  });

  it('refuses a submission after expiry', async () => {
    const h = makeHarness();
    await h.store.create({ label: 'k', roomId: '!room', convoId: 'c' });
    h.advance(SECRET_REQUEST_TTL_MS);
    await h.scheduler.fireDue(SECRET_REQUEST_TTL_MS);
    expect((await h.store.submit('sec-1', DUMMY)).status).toBe(404);
  });
});

describe('createSecretRequests.init (persistence across a restart)', () => {
  let created;
  beforeEach(async () => {
    const h = makeHarness({ startAt: 1_000_000 });
    await h.store.create({ label: 'AWS access key', roomId: '!room', convoId: 'c', multiline: true });
    created = h.saved;
  });

  it('re-arms a still-pending request with its REMAINING delay', async () => {
    const h = makeHarness({ initial: created, startAt: 1_000_000 + 3600_000 });
    expect(h.store.init()).toBe(1);
    expect(h.scheduler.only().delay).toBe(SECRET_REQUEST_TTL_MS - 3600_000);
    // …and the re-armed request is still submittable.
    const res = await h.store.submit('sec-1', DUMMY);
    await res.done;
    expect(res.ok).toBe(true);
    expect(h.turns.length).toBe(1);
  });

  it('keeps multiline and the item link across the restart', async () => {
    const h = makeHarness({ initial: created, startAt: 1_000_000 });
    h.store.init();
    expect(h.store.peek('sec-1').multiline).toBe(true);
    expect(h.store.peek('sec-1').itemId).toBe('it_abc');
  });

  it('drops an already-expired request, closing its item as cancelled', async () => {
    const h = makeHarness({ initial: created, startAt: 1_000_000 + SECRET_REQUEST_TTL_MS + 1 });
    expect(h.store.init()).toBe(0);
    await h.store.settled();
    expect(h.items.calls.close[0].body.resolution).toBe('cancelled');
    expect(h.saved.requests).toEqual([]);
    expect(h.turns[0].text).toContain('request expired (24 h)');
    expect((await h.store.submit('sec-1', DUMMY)).status).toBe(404);
  });

  it('survives a missing or corrupt store file', () => {
    const h = makeHarness({ initial: null });
    expect(h.store.init()).toBe(0);
    const bad = createSecretRequests({
      load: () => { throw new Error('EACCES'); },
      save: () => {},
      items: makeItems(),
      generateLink: () => null,
      notifyChat: () => {},
      deliverTurn: async () => {},
      writeSecretFile: () => '/tmp/x',
      removeSecretFile: () => {},
      log: { warn: () => {} },
    });
    expect(bad.init()).toBe(0);
  });

  it('ignores malformed persisted entries', () => {
    const h = makeHarness({
      initial: { requests: [{ label: 'no id' }, null, { secretId: 'x', label: 'y', expiresAt: 'soon' }] },
    });
    expect(h.store.init()).toBe(0);
  });
});
