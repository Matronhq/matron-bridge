import { describe, it, expect, vi } from 'vitest';
import { createUserSettings } from '../lib/user-settings.js';

const quiet = { warn: () => {} };
const res = (status, body) => ({ status, ok: status >= 200 && status < 300, json: async () => body });

describe('user settings cache', () => {
  it('notices defaults to true until the journal says otherwise', () => {
    const s = createUserSettings({ baseUrl: 'https://j', token: 't', fetchImpl: vi.fn(), log: quiet });
    expect(s.notices()).toBe(true);
  });

  it('a pushed frame sets it; a missing or malformed field keeps the last value', () => {
    const s = createUserSettings({ baseUrl: 'https://j', token: 't', fetchImpl: vi.fn(), log: quiet });
    expect(s.apply({ notices: false })).toBe(true);
    expect(s.notices()).toBe(false);
    expect(s.apply({})).toBe(false);
    expect(s.apply({ notices: 'no' })).toBe(false);
    expect(s.apply(null)).toBe(false);
    expect(s.notices()).toBe(false);
    s.apply({ notices: true });
    expect(s.notices()).toBe(true);
  });

  it('hello_ok with settings applies them without a GET', async () => {
    const fetchImpl = vi.fn();
    const s = createUserSettings({ baseUrl: 'https://j', token: 't', fetchImpl, log: quiet });
    await s.onHello({ notices: false });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(s.notices()).toBe(false);
  });

  it('hello_ok without settings falls back to GET /settings with the bearer token', async () => {
    const fetchImpl = vi.fn(async () => res(200, { notices: false }));
    const s = createUserSettings({ baseUrl: 'https://j/', token: 'tok', fetchImpl, log: quiet });
    await s.onHello(null);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0][0]).toBe('https://j/settings');
    expect(fetchImpl.mock.calls[0][1].headers.Authorization).toBe('Bearer tok');
    expect(s.notices()).toBe(false);
  });

  it('a journal without the route, an error or an unreadable answer keeps the default', async () => {
    for (const fetchImpl of [
      vi.fn(async () => res(404, {})),
      vi.fn(async () => res(500, {})),
      vi.fn(async () => res(200, { other: 1 })),
      vi.fn(async () => { throw new Error('down'); }),
    ]) {
      const s = createUserSettings({ baseUrl: 'https://j', token: 't', fetchImpl, log: quiet });
      await s.refresh();
      expect(s.notices()).toBe(true);
    }
  });

  it('a GET already in flight does not overwrite a frame that landed meanwhile', async () => {
    let release;
    const fetchImpl = vi.fn(() => new Promise((r) => { release = () => r(res(200, { notices: true })); }));
    const s = createUserSettings({ baseUrl: 'https://j', token: 't', fetchImpl, log: quiet });
    const p = s.refresh();
    s.apply({ notices: false });
    release();
    await p;
    expect(s.notices()).toBe(false);
  });

  it('no journal configured: nothing is fetched and the default stands', async () => {
    const fetchImpl = vi.fn();
    const s = createUserSettings({ baseUrl: '', token: '', fetchImpl, log: quiet });
    await s.onHello(null);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(s.notices()).toBe(true);
  });
});
