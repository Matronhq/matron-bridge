// Claude is opt-in until live verification. The existing OpenAI/Gemini
// selection remains the default and the runtime fallback for Claude failures.
const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
export const DEFAULT_ANTHROPIC_MODEL = 'claude-haiku-5-5';

export function createSummaryModel({
  provider = 'legacy',
  anthropicApiKey = '',
  anthropicModel = DEFAULT_ANTHROPIC_MODEL,
  openaiApiKey = '',
  geminiClient = null,
  modelOverride = '',
  fetchImpl = fetch,
  onFallback = () => {},
  onUsage = () => {},
} = {}) {
  if (!['legacy', 'anthropic'].includes(provider)) throw new Error('Invalid SUMMARY_PROVIDER');
  const legacy = createLegacyModel({ openaiApiKey, geminiClient, modelOverride, fetchImpl });
  const flatten = (prompt) => typeof prompt === 'string' ? prompt : `${prompt.system}\n\n${prompt.prompt}`;
  if (provider !== 'anthropic' || !anthropicApiKey) {
    return legacy && { model: legacy.model, generate: (prompt) => legacy.generate(flatten(prompt)) };
  }
  return {
    model: anthropicModel,
    async generate(prompt) {
      try {
        const structured = typeof prompt !== 'string';
        const res = await fetchImpl(ANTHROPIC_URL, {
          method: 'POST',
          signal: AbortSignal.timeout(30_000),
          headers: { 'Content-Type': 'application/json', 'x-api-key': anthropicApiKey, 'anthropic-version': '2023-06-01' },
          body: JSON.stringify({
            model: anthropicModel,
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
          model: anthropicModel,
          inputTokens: data.usage?.input_tokens || 0,
          outputTokens: data.usage?.output_tokens || 0,
          cacheReadTokens: data.usage?.cache_read_input_tokens || 0,
          cacheWriteTokens: data.usage?.cache_creation_input_tokens || 0,
        });
        return result;
      } catch (error) {
        if (!legacy) throw error;
        // Deliberately omit the exception: transport errors can contain data.
        onFallback({ provider: 'anthropic', fallbackModel: legacy.model });
        return legacy.generate(flatten(prompt));
      }
    },
  };
}

const OPENAI_URL = 'https://api.openai.com/v1/chat/completions';
export const DEFAULT_OPENAI_MODEL = 'gpt-6-luna';
export const DEFAULT_GEMINI_MODEL = 'gemini-3-flash-preview';

function createLegacyModel({
  openaiApiKey = '',
  geminiClient = null,
  modelOverride = '',
  fetchImpl = fetch,
} = {}) {
  if (openaiApiKey) {
    const model = modelOverride || DEFAULT_OPENAI_MODEL;
    return {
      model,
      async generate(prompt) {
        const res = await fetchImpl(OPENAI_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${openaiApiKey}` },
          body: JSON.stringify({ model, messages: [{ role: 'user', content: prompt }] }),
        });
        if (!res.ok) throw new Error(`openai ${res.status}`);
        const data = await res.json();
        const text = data?.choices?.[0]?.message?.content;
        if (typeof text !== 'string' || !text.trim()) throw new Error('openai: empty completion');
        return text.trim();
      },
    };
  }
  if (geminiClient) {
    const model = modelOverride || DEFAULT_GEMINI_MODEL;
    return {
      model,
      async generate(prompt) {
        const m = geminiClient.getGenerativeModel({ model });
        const result = await m.generateContent(prompt);
        return result.response.text().trim();
      },
    };
  }
  return null;
}
