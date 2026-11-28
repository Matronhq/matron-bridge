import { readFileSync } from 'node:fs';

// DeepSeek support: run the Codex agent against DeepInfra's OpenAI-compatible
// endpoint, which hosts the DeepSeek models. Codex reaches it as a custom model
// provider (base_url + env_key), so a session whose model is a DeepSeek id runs
// on DeepSeek with Matron's sandboxing, tools and tracker unchanged. This module
// is the one place that knows the provider: it hands createCodexSessionForRoom
// the config overrides and the env, and the picker the model options.

export const DEEPINFRA_BASE_URL = 'https://api.deepinfra.com/v1/openai';
export const DEEPINFRA_ENV_KEY = 'DEEPINFRA_API_KEY';
// A box can point at a key file instead of putting the key in the bridge env.
export const DEEPINFRA_KEY_FILE_ENV = 'DEEPINFRA_API_KEY_FILE';
// Codex 0.154+ dropped `wire_api = "chat"` and speaks the Responses API, which
// DeepInfra implements for these models (verified end-to-end on 2026-11-28).
export const DEEPSEEK_WIRE_API = 'responses';
export const DEEPSEEK_PROVIDER_ID = 'deepinfra';

// The DeepSeek models offered in Matron, by their DeepInfra id. Kept short and
// current on purpose; `label` is what the picker shows.
export const DEEPSEEK_MODELS = [
  { value: 'deepseek-ai/DeepSeek-V4.1-Flash', label: 'DeepSeek V4.1 Flash' },
  { value: 'deepseek-ai/DeepSeek-V4-Pro', label: 'DeepSeek V4 Pro' },
  { value: 'deepseek-ai/DeepSeek-V3.2', label: 'DeepSeek V3.2' },
];

const DEEPSEEK_IDS = new Set(DEEPSEEK_MODELS.map(m => m.value));

/**
 * Whether a model id is one of the DeepSeek models Matron offers.
 *
 * @param {unknown} model the selected model id
 * @returns {boolean} true for a known DeepSeek id
 */
export function isDeepseekModel(model) {
  return typeof model === 'string' && DEEPSEEK_IDS.has(model);
}

/**
 * The Codex config overrides that make a session talk to DeepInfra for a
 * DeepSeek model. Empty for any other model, so non-DeepSeek sessions are
 * untouched. Merged into the session's config (like mcp_servers), so it reaches
 * the app-server's thread/start as a nested table.
 *
 * @param {unknown} model the selected model id
 * @returns {object} the config overrides, or {} for a non-DeepSeek model
 */
export function deepseekConfigOverrides(model) {
  if (!isDeepseekModel(model)) return {};
  return {
    model_provider: DEEPSEEK_PROVIDER_ID,
    model_providers: {
      [DEEPSEEK_PROVIDER_ID]: {
        name: 'DeepInfra',
        base_url: DEEPINFRA_BASE_URL,
        env_key: DEEPINFRA_ENV_KEY,
        wire_api: DEEPSEEK_WIRE_API,
      },
    },
  };
}

/**
 * The DeepInfra API key, from the env var, else from the file named by
 * DEEPINFRA_API_KEY_FILE. Never logged; returned only to place in a session's
 * env for Codex to read.
 *
 * @param {Record<string, string|undefined>} baseEnv the environment to read
 * @returns {string|null} the key, trimmed, or null when none is configured
 */
export function deepseekApiKey(baseEnv = process.env) {
  const direct = baseEnv?.[DEEPINFRA_ENV_KEY];
  if (typeof direct === 'string' && direct.trim() !== '') return direct.trim();
  const file = baseEnv?.[DEEPINFRA_KEY_FILE_ENV];
  if (typeof file === 'string' && file.trim() !== '') {
    try {
      const value = readFileSync(file.trim(), 'utf8').trim();
      if (value !== '') return value;
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Whether DeepSeek can be offered on this box at all — a key is configured.
 *
 * @param {Record<string, string|undefined>} baseEnv the environment to read
 * @returns {boolean} true when a DeepInfra key is available
 */
export function deepseekAvailable(baseEnv = process.env) {
  return deepseekApiKey(baseEnv) !== null;
}

/**
 * The env to add to a Codex session so Codex can read env_key if it is (or
 * later switches to) a DeepSeek model. Not gated on the current model: the key
 * is placed whenever one is configured on the box, so a mid-session switch onto
 * DeepSeek works (the app-server child's env is fixed when it spawns). Resolves
 * the key from DEEPINFRA_API_KEY or DEEPINFRA_API_KEY_FILE, so a file-based key
 * reaches the child under the env var Codex expects. Empty when none is set.
 *
 * @param {Record<string, string|undefined>} baseEnv the environment to read
 * @returns {Record<string, string>} env additions, or {}
 */
export function deepseekKeyEnv(baseEnv = process.env) {
  const key = deepseekApiKey(baseEnv);
  return key ? { [DEEPINFRA_ENV_KEY]: key } : {};
}

/**
 * The DeepSeek model options for the picker, or [] when no key is configured on
 * this box (so the option only appears where it would actually work).
 *
 * @param {Record<string, string|undefined>} baseEnv the environment to read
 * @returns {Array<{value: string, label: string}>} the options
 */
export function deepseekModelOptions(baseEnv = process.env) {
  return deepseekAvailable(baseEnv) ? DEEPSEEK_MODELS.map(m => ({ ...m })) : [];
}
