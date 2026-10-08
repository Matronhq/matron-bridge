import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  createUserDefaultsLookup,
  effectiveDefaultModel,
  effectiveDefaultEffort,
  defaultOfferFor,
  parseDefaultOfferArg,
  defaultSavedText,
} from '../lib/user-defaults.js';

const res = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

describe('effective defaults', () => {
  it('the user default wins when this box can use it, else the box default', () => {
    expect(effectiveDefaultModel('sonnet', 'opus')).toBe('sonnet');
    expect(effectiveDefaultModel('Opus[1M]', 'fable')).toBe('opus[1m]');
    expect(effectiveDefaultModel(null, 'opus')).toBe('opus');
    expect(effectiveDefaultModel('default', 'opus')).toBe('opus');
    expect(effectiveDefaultModel('gpt-5', 'opus')).toBe('opus');
    expect(effectiveDefaultEffort('high', null)).toBe('high');
    expect(effectiveDefaultEffort(null, 'medium')).toBe('medium');
    expect(effectiveDefaultEffort('auto', 'medium')).toBe('medium'); // /effort-only, not a spawn level
    expect(effectiveDefaultEffort(undefined, null)).toBeNull();
  });
});

describe('createUserDefaultsLookup', () => {
  it('reads GET /defaults with the bearer token and caches it', async () => {
    const fetchImpl = vi.fn(async () => res(200, { default_model: 'sonnet', default_effort: 'high' }));
    const l = createUserDefaultsLookup({ baseUrl: 'https://j.example/', token: 't0k', fetchImpl });
    expect(l.snapshot()).toEqual({ known: false, model: null, effort: null });
    await l.refresh();
    expect(fetchImpl.mock.calls[0][0]).toBe('https://j.example/defaults');
    expect(fetchImpl.mock.calls[0][1].headers.Authorization).toBe('Bearer t0k');
    expect(l.snapshot()).toEqual({ known: true, model: 'sonnet', effort: 'high' });
  });

  it('throttles unforced refreshes and keeps the last values on a failure', async () => {
    let t = 0;
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(res(200, { default_model: 'opus', default_effort: null }))
      .mockResolvedValueOnce(res(500, {}));
    const log = { warn: vi.fn() };
    const l = createUserDefaultsLookup({ baseUrl: 'https://j', token: 't', fetchImpl, now: () => t, log });
    await l.refresh();
    await l.refresh();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    await l.refresh({ force: true });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(l.snapshot()).toEqual({ known: true, model: 'opus', effort: null });
    expect(log.warn).toHaveBeenCalledTimes(1);
  });

  it('a journal without /defaults (404) means box defaults, warned once', async () => {
    const log = { warn: vi.fn() };
    const l = createUserDefaultsLookup({ baseUrl: 'https://j', token: 't', fetchImpl: async () => res(404, {}), log });
    await l.refresh({ force: true });
    await l.refresh({ force: true });
    expect(l.snapshot()).toEqual({ known: true, model: null, effort: null });
    expect(log.warn).toHaveBeenCalledTimes(1);
  });

  it('applies a live defaults frame and ignores junk', () => {
    const l = createUserDefaultsLookup({ baseUrl: 'https://j', token: 't', fetchImpl: vi.fn() });
    expect(l.apply({ kind: 'defaults', default_model: 'haiku', default_effort: 'low' })).toBe(true);
    expect(l.snapshot()).toEqual({ known: true, model: 'haiku', effort: 'low' });
    expect(l.apply({ default_model: 5 })).toBe(false);
    expect(l.apply(null)).toBe(false);
    expect(l.snapshot().model).toBe('haiku');
  });

  it('a GET already on the wire does not overwrite a newer frame or save', async () => {
    let answer;
    const fetchImpl = vi.fn(() => new Promise((resolve) => { answer = resolve; }));
    const l = createUserDefaultsLookup({ baseUrl: 'https://j', token: 't', fetchImpl });
    const pending = l.refresh({ force: true });
    l.apply({ kind: 'defaults', default_model: 'sonnet', default_effort: 'max' });
    answer(res(200, { default_model: 'opus', default_effort: null }));
    await pending;
    expect(l.snapshot()).toEqual({ known: true, model: 'sonnet', effort: 'max' });
  });

  it('save PUTs the patch and caches the answer', async () => {
    const fetchImpl = vi.fn(async () => res(200, { default_model: null, default_effort: 'max' }));
    const l = createUserDefaultsLookup({ baseUrl: 'https://j', token: 't', fetchImpl });
    expect(await l.save({ default_effort: 'max' })).toEqual({ ok: true, reason: undefined });
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://j/defaults');
    expect(init.method).toBe('PUT');
    expect(JSON.parse(init.body)).toEqual({ default_effort: 'max' });
    expect(init.headers['Content-Type']).toBe('application/json');
    expect(l.snapshot().effort).toBe('max');
  });

  it('save reports the journal error', async () => {
    const l = createUserDefaultsLookup({ baseUrl: 'https://j', token: 't', fetchImpl: async () => res(400, { error: 'bad_effort' }) });
    expect(await l.save({ default_effort: 'x' })).toEqual({ ok: false, reason: 'bad_effort' });
    const offline = createUserDefaultsLookup({ baseUrl: 'https://j', token: 't', fetchImpl: async () => { throw new Error('down'); } });
    expect(await offline.save({ default_effort: 'high' })).toEqual({ ok: false, reason: 'unreachable' });
  });
});

describe('the "for new chats too?" offer', () => {
  it('offers a change that differs from the current default, No first', () => {
    expect(defaultOfferFor('effort', 'High', 'medium')).toEqual({
      question: 'Use High effort for new chats too?',
      buttons: [
        { id: 'defaults-no', label: 'No', value: 'defaults:no' },
        { id: 'defaults-yes', label: 'Yes', value: 'defaults:effort:high' },
      ],
    });
    expect(defaultOfferFor('model', 'sonnet', 'opus').question).toBe('Use Sonnet for new chats too?');
    expect(defaultOfferFor('model', 'sonnet', 'opus').buttons[1].value).toBe('defaults:model:sonnet');
  });

  it('offers nothing when it already is the default, or cannot be one', () => {
    expect(defaultOfferFor('effort', 'high', 'high')).toBeNull();
    expect(defaultOfferFor('effort', 'auto', null)).toBeNull();
    expect(defaultOfferFor('model', 'default', 'opus')).toBeNull();
    expect(defaultOfferFor('model', 'opus', 'opus')).toBeNull();
  });

  it('parses only the values the card emits', () => {
    expect(parseDefaultOfferArg('no')).toEqual({ save: false });
    expect(parseDefaultOfferArg('effort:high')).toEqual({ save: true, kind: 'effort', value: 'high' });
    expect(parseDefaultOfferArg('model:opus[1m]')).toEqual({ save: true, kind: 'model', value: 'opus[1m]' });
    for (const bad of ['', 'yes', 'effort:auto', 'effort:HIGH', 'model:default', 'model:gpt-5', 'mode:print']) {
      expect(parseDefaultOfferArg(bad)).toBeNull();
    }
  });

  it('confirms in words that name where to change it', () => {
    expect(defaultSavedText('effort', 'xhigh')).toBe('✅ New chats will start on X-High effort. You can change this in Settings.');
  });
});

describe('index.js wiring (source inspection)', () => {
  const src = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
  it('fresh starts fall back to the user default before the box default', () => {
    expect(src).toContain('fallback: defaultEffortNow(), resumed, isSpawnLevel: isSpawnEffortArg');
    expect(src.match(/fallback: defaultModelNow\(\), resumed: identity\.resumed/g)).toHaveLength(2);
    expect(src).not.toMatch(/fallback: DEFAULT_MODEL/);
  });
  it('keeps the cache current: boot, every hello_ok, behind spawns, and the live frame', () => {
    expect(src.match(/userDefaults\.refresh\(\{ force: true \}\);/g)).toHaveLength(2);
    expect(src).toContain('  userDefaults.refresh();\n');
    expect(src).toContain('onDefaultsFrame: (frame) => { userDefaults.apply(frame); },');
  });
  it('offers only after a person\'s change, never the Coordinator\'s', () => {
    expect(src).toContain('applyModelSwitch: (r, s, arg, opts) => applyModelSwitch(r, s, arg, { ...opts, offer: true }),');
    expect(src).toContain("const offer = !implicit && !parts.slice(2).includes('--no-offer');");
    expect(src.match(/noteEffortDefaultOffer\((roomId|s\.roomId), arg\);/g)).toHaveLength(2);
    const control = src.slice(src.indexOf('async function applyControlEffort('), src.indexOf('function drainDeferredControls('));
    expect(control).not.toContain('noteEffortDefaultOffer');
    expect(src).toContain("if (applied) maybeOfferEffortDefault(roomId, level);");
    expect(src).toContain("else maybeOfferEffortDefault(session.roomId, trackedEffort(session));");
    expect(src).toContain("|| answer.choice.startsWith('defaults:'));");
  });
});
