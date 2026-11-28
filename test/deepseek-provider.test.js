import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  isDeepseekModel,
  deepseekConfigOverrides,
  deepseekApiKey,
  deepseekAvailable,
  deepseekSpawnEnv,
  deepseekModelOptions,
  DEEPSEEK_MODELS,
  DEEPINFRA_BASE_URL,
  DEEPINFRA_ENV_KEY,
  DEEPINFRA_KEY_FILE_ENV,
} from '../lib/deepseek-provider.js';

describe('isDeepseekModel', () => {
  it('is true for a known DeepSeek id', () => {
    expect(isDeepseekModel('deepseek-ai/DeepSeek-V4.1-Flash')).toBe(true);
  });
  it('is false for a Codex/OpenAI model, null, or a lookalike', () => {
    expect(isDeepseekModel('gpt-5-codex')).toBe(false);
    expect(isDeepseekModel(null)).toBe(false);
    expect(isDeepseekModel(undefined)).toBe(false);
    expect(isDeepseekModel('deepseek-ai/DeepSeek-Unknown')).toBe(false);
  });
});

describe('deepseekConfigOverrides', () => {
  it('returns the DeepInfra provider table for a DeepSeek model', () => {
    expect(deepseekConfigOverrides('deepseek-ai/DeepSeek-V4-Pro')).toEqual({
      model_provider: 'deepinfra',
      model_providers: {
        deepinfra: {
          name: 'DeepInfra',
          base_url: DEEPINFRA_BASE_URL,
          env_key: DEEPINFRA_ENV_KEY,
          wire_api: 'responses',
        },
      },
    });
  });
  it('returns {} for a non-DeepSeek model, leaving the session untouched', () => {
    expect(deepseekConfigOverrides('gpt-5-codex')).toEqual({});
    expect(deepseekConfigOverrides(undefined)).toEqual({});
  });
});

describe('deepseekApiKey', () => {
  let dir;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'ds-key-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('reads the env var, trimmed', () => {
    expect(deepseekApiKey({ [DEEPINFRA_ENV_KEY]: '  sk-abc  ' })).toBe('sk-abc');
  });
  it('reads the key file when the env var is absent', () => {
    const file = join(dir, 'key');
    writeFileSync(file, 'sk-from-file\n');
    expect(deepseekApiKey({ [DEEPINFRA_KEY_FILE_ENV]: file })).toBe('sk-from-file');
  });
  it('prefers the env var over the file', () => {
    const file = join(dir, 'key');
    writeFileSync(file, 'sk-from-file\n');
    expect(deepseekApiKey({ [DEEPINFRA_ENV_KEY]: 'sk-env', [DEEPINFRA_KEY_FILE_ENV]: file })).toBe('sk-env');
  });
  it('is null when neither is set, when the file is missing, and for an empty value', () => {
    expect(deepseekApiKey({})).toBeNull();
    expect(deepseekApiKey({ [DEEPINFRA_KEY_FILE_ENV]: join(dir, 'nope') })).toBeNull();
    expect(deepseekApiKey({ [DEEPINFRA_ENV_KEY]: '   ' })).toBeNull();
  });
});

describe('deepseekAvailable', () => {
  it('tracks whether a key is configured', () => {
    expect(deepseekAvailable({ [DEEPINFRA_ENV_KEY]: 'sk' })).toBe(true);
    expect(deepseekAvailable({})).toBe(false);
  });
});

describe('deepseekSpawnEnv', () => {
  it('injects the key for a DeepSeek model when configured', () => {
    expect(deepseekSpawnEnv('deepseek-ai/DeepSeek-V3.2', { [DEEPINFRA_ENV_KEY]: 'sk-x' }))
      .toEqual({ [DEEPINFRA_ENV_KEY]: 'sk-x' });
  });
  it('is empty for a non-DeepSeek model even when a key is present', () => {
    expect(deepseekSpawnEnv('gpt-5-codex', { [DEEPINFRA_ENV_KEY]: 'sk-x' })).toEqual({});
  });
  it('is empty for a DeepSeek model when no key is configured', () => {
    expect(deepseekSpawnEnv('deepseek-ai/DeepSeek-V3.2', {})).toEqual({});
  });
});

describe('deepseekModelOptions', () => {
  it('lists every offered model when a key is configured', () => {
    const options = deepseekModelOptions({ [DEEPINFRA_ENV_KEY]: 'sk' });
    expect(options).toEqual(DEEPSEEK_MODELS);
    expect(options).not.toBe(DEEPSEEK_MODELS); // a copy, not the shared array
  });
  it('is empty when no key is configured, so the option only shows where it works', () => {
    expect(deepseekModelOptions({})).toEqual([]);
  });
});

describe('index.js wiring (source inspection)', () => {
  const src = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
  it('merges the DeepInfra provider config into the Codex session config', () => {
    expect(src).toContain('...deepseekConfigOverrides(model) }');
  });
  it('adds the DeepInfra key to the Codex session env for a DeepSeek model', () => {
    expect(src).toContain('...deepseekSpawnEnv(model, process.env) }');
  });
});
