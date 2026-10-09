// Providers are tried in SUMMARY_PROVIDERS order. One without its key (or
// client) is skipped, and a failed request falls through to the next one.
const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
export const DEFAULT_ANTHROPIC_MODEL = 'claude-haiku-5-5';
export const SUMMARY_PROVIDER_NAMES = ['anthropic', 'openai', 'gemini'];
export const DEFAULT_SUMMARY_PROVIDERS = SUMMARY_PROVIDER_NAMES.join(',');

export function parseSummaryProviders(value = DEFAULT_SUMMARY_PROVIDERS) {
  const names = (Array.isArray(value) ? value : String(value).split(','))
    .map((name) => String(name).trim().toLowerCase())
    .filter(Boolean);
  if (!names.length || names.some((name) => !SUMMARY_PROVIDER_NAMES.includes(name)) || new Set(names).size !== names.length) {
    throw new Error(`Invalid SUMMARY_PROVIDERS: use a comma-separated order of ${DEFAULT_SUMMARY_PROVIDERS}`);
  }
  return names;
}

export function createSummaryModel({
  providers = DEFAULT_SUMMARY_PROVIDERS,
  anthropicApiKey = '',
  anthropicModel = DEFAULT_ANTHROPIC_MODEL,
  openaiApiKey = '',
  geminiClient = null,
  modelOverride = '',
  fetchImpl = fetch,
  onFallback = () => {},
  onUsage = () => {},
} = {}) {
  const builders = {
    anthropic: () => anthropicApiKey && createAnthropicModel({ apiKey: anthropicApiKey, model: anthropicModel, fetchImpl, onUsage }),
    openai: () => openaiApiKey && createOpenAiModel({ apiKey: openaiApiKey, model: modelOverride || DEFAULT_OPENAI_MODEL, fetchImpl }),
    gemini: () => geminiClient && createGeminiModel({ client: geminiClient, model: modelOverride || DEFAULT_GEMINI_MODEL }),
  };
  const chain = parseSummaryProviders(providers)
    .map((name) => { const m = builders[name](); return m && { name, ...m }; })
    .filter(Boolean);
  if (!chain.length) return null;
  return {
    model: chain[0].model,
    async generate(prompt) {
      for (let i = 0; ; i++) {
        try {
          return await chain[i].generate(prompt);
        } catch (error) {
          const next = chain[i + 1];
          if (!next) throw error;
          // Deliberately omit the exception: transport errors can contain data.
          onFallback({ provider: chain[i].name, fallbackModel: next.model });
        }
      }
    },
  };
}

// Only Claude takes the structured { system, prompt } form (the fixed system
// part is its cache prefix); the others get it flattened back to one string.
const flatten = (prompt) => typeof prompt === 'string' ? prompt : `${prompt.system}\n\n${prompt.prompt}`;

function createAnthropicModel({ apiKey, model, fetchImpl, onUsage }) {
  return {
    model,
    async generate(prompt) {
      const structured = typeof prompt !== 'string';
      const res = await fetchImpl(ANTHROPIC_URL, {
        method: 'POST',
        signal: AbortSignal.timeout(30_000),
        headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({
          model,
          max_tokens: 1024,
          thinking: { type: 'disabled' },
          ...(structured ? { system: [{ type: 'text', text: prompt.system, cache_control: { type: 'ephemeral' } }] } : {}),
          messages: [{ role: 'user', content: structured ? prompt.prompt : prompt }],
        }),
      });
      // Never log provider response bodies: they may echo prompt content.
      if (!res.ok) throw new Error(`anthropic HTTP ${res.status}`);
      const data = await res.json();
      if (data.stop_reason !== 'end_turn') throw new Error('anthropic: incomplete completion');
      const result = data.content?.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
      if (!result) throw new Error('anthropic: empty completion');
      onUsage({
        model,
        inputTokens: data.usage?.input_tokens || 0,
        outputTokens: data.usage?.output_tokens || 0,
        cacheReadTokens: data.usage?.cache_read_input_tokens || 0,
        cacheWriteTokens: data.usage?.cache_creation_input_tokens || 0,
      });
      return result;
    },
  };
}

const OPENAI_URL = 'https://api.openai.com/v1/chat/completions';
export const DEFAULT_OPENAI_MODEL = 'gpt-6-luna';
export const DEFAULT_GEMINI_MODEL = 'gemini-3-flash-preview';

function createOpenAiModel({ apiKey, model, fetchImpl }) {
  return {
    model,
    async generate(prompt) {
      const res = await fetchImpl(OPENAI_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ model, messages: [{ role: 'user', content: flatten(prompt) }] }),
      });
      if (!res.ok) throw new Error(`openai ${res.status}`);
      const data = await res.json();
      const text = data?.choices?.[0]?.message?.content;
      if (typeof text !== 'string' || !text.trim()) throw new Error('openai: empty completion');
      return text.trim();
    },
  };
}

function createGeminiModel({ client, model }) {
  return {
    model,
    async generate(prompt) {
      const m = client.getGenerativeModel({ model });
      const result = await m.generateContent(flatten(prompt));
      return result.response.text().trim();
    },
  };
}
