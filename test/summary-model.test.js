import { describe, it, expect, vi } from 'vitest';
import { createSummaryModel } from '../lib/summary-model.js';

const okFetch = (text) => vi.fn(async () => ({
  ok: true,
  json: async () => ({ choices: [{ message: { content: text } }] }),
}));

describe('createSummaryModel', () => {
  it('returns null when no provider is configured', () => {
    expect(createSummaryModel({})).toBeNull();
  });

  it('prefers OpenAI when a key is set, defaulting to gpt-6-luna', async () => {
    const fetchImpl = okFetch('TITLE: t');
    const m = createSummaryModel({ openaiApiKey: 'sk-x', geminiClient: {}, fetchImpl });
    expect(m.model).toBe('gpt-6-luna');
    await expect(m.generate('hello')).resolves.toBe('TITLE: t');
    const [url, opts] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://api.openai.com/v1/chat/completions');
    const body = JSON.parse(opts.body);
    expect(body.model).toBe('gpt-6-luna');
    expect(body.messages).toEqual([{ role: 'user', content: 'hello' }]);
    expect(opts.headers.Authorization).toBe('Bearer sk-x');
  });

  it('SUMMARY_MODEL override applies to whichever provider is active', () => {
    const m = createSummaryModel({ openaiApiKey: 'sk-x', modelOverride: 'gpt-5.7-terra', fetchImpl: okFetch('x') });
    expect(m.model).toBe('gpt-5.7-terra');
  });

  it('throws a descriptive error on non-2xx and on an empty completion', async () => {
    const bad = vi.fn(async () => ({ ok: false, status: 429, text: async () => 'rate limited' }));
    const m1 = createSummaryModel({ openaiApiKey: 'sk-x', fetchImpl: bad });
    await expect(m1.generate('p')).rejects.toThrow(/openai 429/);
    const empty = vi.fn(async () => ({ ok: true, json: async () => ({ choices: [] }) }));
    const m2 = createSummaryModel({ openaiApiKey: 'sk-x', fetchImpl: empty });
    await expect(m2.generate('p')).rejects.toThrow(/empty/);
  });

  it('falls back to the Gemini client, defaulting to gemini-3-flash-preview', async () => {
    const generateContent = vi.fn(async () => ({ response: { text: () => ' out ' } }));
    const getGenerativeModel = vi.fn(() => ({ generateContent }));
    const m = createSummaryModel({ geminiClient: { getGenerativeModel } });
    expect(m.model).toBe('gemini-3-flash-preview');
    await expect(m.generate('p')).resolves.toBe('out');
    expect(getGenerativeModel).toHaveBeenCalledWith({ model: 'gemini-3-flash-preview' });
  });
});


describe('Claude summaries and the SUMMARY_PROVIDERS order', () => {
  const claudeFetch = (data = {}) => vi.fn(async () => ({
    ok: true,
    json: async () => ({ content: [{ type: 'text', text: 'TITLE: done' }], stop_reason: 'end_turn', ...data }),
  }));
  const gemini = (text = 'Gemini') => ({ getGenerativeModel: () => ({ generateContent: async () => ({ response: { text: () => text } }) }) });

  it('prefers Claude by default only when its key is present', () => {
    expect(createSummaryModel({ anthropicApiKey: 'test', openaiApiKey: 'test' }).model).toBe('claude-haiku-5-5');
    expect(createSummaryModel({ openaiApiKey: 'test' }).model).toBe('gpt-6-luna');
    expect(createSummaryModel({ anthropicApiKey: 'test' }).model).toBe('claude-haiku-5-5');
  });

  it('follows an explicit order and skips providers without keys', () => {
    expect(createSummaryModel({ providers: 'openai,gemini', anthropicApiKey: 'test', openaiApiKey: 'test' }).model).toBe('gpt-6-luna');
    expect(createSummaryModel({ providers: ' Gemini , anthropic ', anthropicApiKey: 'test', geminiClient: gemini() }).model).toBe('gemini-3-flash-preview');
    expect(createSummaryModel({ providers: 'gemini', anthropicApiKey: 'test' })).toBeNull();
  });

  it.each(['', 'claude', 'openai,openai', 'legacy'])('rejects the invalid order %j', (providers) => {
    expect(() => createSummaryModel({ providers })).toThrow('Invalid SUMMARY_PROVIDERS');
  });

  it('sends fixed instructions at a cache breakpoint and reports only numeric usage', async () => {
    const fetchImpl = claudeFetch({ usage: { input_tokens: 50, output_tokens: 20, cache_read_input_tokens: 600 } });
    const onUsage = vi.fn();
    const model = createSummaryModel({ anthropicApiKey: 'test', fetchImpl, onUsage });
    await expect(model.generate({ system: 'fixed format', prompt: 'changing transcript' })).resolves.toBe('TITLE: done');
    const [url, options] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://api.anthropic.com/v1/messages');
    expect(options.headers).toMatchObject({ 'x-api-key': 'test', 'anthropic-version': '2023-06-01' });
    expect(options.signal).toBeInstanceOf(AbortSignal);
    expect(JSON.parse(options.body)).toEqual({ model: 'claude-haiku-5-5', max_tokens: 1024, thinking: { type: 'disabled' },
      system: [{ type: 'text', text: 'fixed format', cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: 'changing transcript' }],
    });
    expect(onUsage).toHaveBeenCalledWith({ model: 'claude-haiku-5-5', inputTokens: 50, outputTokens: 20, cacheReadTokens: 600, cacheWriteTokens: 0 });
  });

  it('accepts compaction strings without caching their changing content', async () => {
    const fetchImpl = claudeFetch();
    await createSummaryModel({ anthropicApiKey: 'test', fetchImpl }).generate('compact this');
    expect(JSON.parse(fetchImpl.mock.calls[0][1].body)).not.toHaveProperty('system');
  });

  it('flattens the structured prompt for OpenAI and Gemini', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: 'ok' } }] }) }));
    await createSummaryModel({ openaiApiKey: 'test', fetchImpl }).generate({ system: 'rules', prompt: 'messages' });
    expect(JSON.parse(fetchImpl.mock.calls[0][1].body).messages[0].content).toBe('rules\n\nmessages');
    const generateContent = vi.fn(async () => ({ response: { text: () => 'g' } }));
    await createSummaryModel({ geminiClient: { getGenerativeModel: () => ({ generateContent }) } }).generate({ system: 'rules', prompt: 'messages' });
    expect(generateContent).toHaveBeenCalledWith('rules\n\nmessages');
  });

  it.each(['max_tokens', 'refusal', 'pause_turn'])('falls back on %s without accepting partial output', async (stop_reason) => {
    const fetchImpl = claudeFetch({ stop_reason });
    fetchImpl.mockImplementationOnce(async () => ({ ok: true, json: async () => ({ content: [{ type: 'text', text: 'partial' }], stop_reason }) }));
    fetchImpl.mockImplementationOnce(async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: 'legacy' } }] }) }));
    const onFallback = vi.fn();
    const model = createSummaryModel({ anthropicApiKey: 'test', openaiApiKey: 'test', modelOverride: 'legacy-custom', fetchImpl, onFallback });
    await expect(model.generate({ system: 'rules', prompt: 'messages' })).resolves.toBe('legacy');
    expect(JSON.parse(fetchImpl.mock.calls[1][1].body)).toMatchObject({ model: 'legacy-custom', messages: [{ role: 'user', content: 'rules\n\nmessages' }] });
    expect(onFallback).toHaveBeenCalledWith({ provider: 'anthropic', fallbackModel: 'legacy-custom' });
  });

  it('falls through every provider in order, without exposing error details', async () => {
    const onFallback = vi.fn();
    const model = createSummaryModel({ anthropicApiKey: 'test', openaiApiKey: 'test',
      fetchImpl: vi.fn(async () => { throw new Error('sensitive transport detail'); }), onFallback, geminiClient: gemini(),
    });
    await expect(model.generate('prompt')).resolves.toBe('Gemini');
    expect(onFallback.mock.calls.map(([e]) => e.provider)).toEqual(['anthropic', 'openai']);
    expect(JSON.stringify(onFallback.mock.calls)).not.toContain('sensitive');
  });

  it('rejects HTTP errors and empty completions when no fallback is available', async () => {
    const bad = createSummaryModel({ anthropicApiKey: 'test', fetchImpl: async () => ({ ok: false, status: 429, text: async () => 'private' }) });
    await expect(bad.generate('p')).rejects.toThrow('anthropic HTTP 429');
    const empty = createSummaryModel({ anthropicApiKey: 'test', fetchImpl: claudeFetch({ content: [] }) });
    await expect(empty.generate('p')).rejects.toThrow('empty completion');
  });

  it('gives OpenAI a deadline and moves past a hung Gemini call', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: 'ok' } }] }) }));
    await createSummaryModel({ providers: 'openai', openaiApiKey: 'test', fetchImpl }).generate('p');
    expect(fetchImpl.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
    vi.useFakeTimers();
    try {
      const hung = { getGenerativeModel: () => ({ generateContent: () => new Promise(() => {}) }) };
      const result = createSummaryModel({ providers: 'gemini', geminiClient: hung }).generate('p');
      const assertion = expect(result).rejects.toThrow('gemini: timed out');
      await vi.advanceTimersByTimeAsync(30_000);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });
});
