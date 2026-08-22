import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// index.js can't be imported in-process (top-level express/journal side
// effects — same constraint session-summary.test.js and agent-spawn.test.js
// work around), so the /start-family --model wiring is pinned by source
// inspection. The parsing itself is unit-tested in model-flag.test.js; what
// these pins protect is that each command actually runs the extractor, reads
// its positional args from the FILTERED token list, and refuses the flag for
// Codex instead of passing a Claude alias to a Codex spawn.
const indexSource = fs.readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'index.js'), 'utf-8');

function commandBlock(startMarker, endMarker) {
  const start = indexSource.indexOf(startMarker);
  const end = indexSource.indexOf(endMarker, start);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return indexSource.slice(start, end);
}

const BLOCKS = {
  '!start': () => commandBlock("case '!start':", "case '!stop':"),
  '!restart': () => commandBlock("case '!restart':", "case '!resume':"),
  '!resume': () => commandBlock("case '!resume':", "case '!workdir':"),
  '!workdir': () => commandBlock("case '!workdir':", "case '!status':"),
};

describe('--model wiring in the /start command family (source inspection)', () => {
  for (const [name, getBlock] of Object.entries(BLOCKS)) {
    it(`${name} parses --model with extractModelFlag`, () => {
      expect(getBlock()).toMatch(/extractModelFlag\(/);
    });

    it(`${name} refuses --model for Codex rather than validating a Codex id as a Claude alias`, () => {
      const block = getBlock();
      expect(block).toContain('CODEX_MODEL_FLAG_REFUSAL');
      // The refusal is gated on `.present`, not `.model`: `--model gpt-5` on
      // a Codex session must get the Codex explanation, not "Unknown model".
      expect(block).toMatch(/ModelFlag\.present/);
    });

    it(`${name} surfaces the extractor's error instead of starting on the wrong model`, () => {
      expect(getBlock()).toMatch(/ModelFlag\.error/);
    });
  }

  // The extractor consumes `--model <alias>` as TWO tokens, so any positional
  // read from the pre-extraction list would pick up "--model" or the alias as
  // a workdir / session id.
  it('!start reads its workdir positional from the extractor output', () => {
    expect(BLOCKS['!start']()).toContain('const arg = startModelFlag.rest[0]');
  });

  it('!resume reads its session-id positional from the extractor output', () => {
    expect(BLOCKS['!resume']()).toMatch(/const resumeArg = resumeModelFlag\.rest\[0\]/);
  });

  it('!workdir reads its path positional from the extractor output', () => {
    expect(BLOCKS['!workdir']()).toContain('workdirModelFlag.rest.join(\' \')');
  });

  // persistSession auto-carries mcpExtras but NOT model (in-TUI /model picks
  // are deliberately session-scoped), so a /start-flag model only survives a
  // bridge restart if it goes through the explicit `extra` argument — and
  // only if the persist runs at all when extras are empty.
  it('!start persists the flag model explicitly, even with no mcpExtras', () => {
    const block = BLOCKS['!start']();
    expect(block).toContain('mcpExtras.length > 0 || startModel');
    expect(block).toContain('startModel ? { model: startModel } : undefined');
  });

  it('!workdir persists the flag model explicitly, even with no mcpExtras', () => {
    const block = BLOCKS['!workdir']();
    expect(block).toContain('workdirExtras.length > 0 || workdirModel');
    expect(block).toContain('workdirModel ? { model: workdirModel } : undefined');
  });

  it('!restart persists the flag model AFTER the recreate, when the new session exists', () => {
    const block = BLOCKS['!restart']();
    const recreate = block.indexOf('recreateSession(roomId');
    const persist = block.indexOf('persistSession(roomId, restarted.claudeSessionId');
    expect(recreate).toBeGreaterThan(-1);
    expect(persist).toBeGreaterThan(recreate);
    expect(block).toContain('restarted.currentModel = restartModelFlag.model');
  });

  // The RPC start path (journalStartSessionForRpc) is the New Chat picker's
  // route into the same options; same explicit-extra rule.
  it('journalStartSessionForRpc accepts and persists a model', () => {
    const start = indexSource.indexOf('function journalStartSessionForRpc(');
    expect(start).toBeGreaterThan(-1);
    const block = indexSource.slice(start, indexSource.indexOf('\n}', start));
    expect(block).toMatch(/function journalStartSessionForRpc\(\{[^}]*\bmodel\b/);
    expect(block).toContain('...(model ? { model } : {})');
    expect(block).toContain('mcpExtras.length > 0 || model');
    expect(block).toContain('model ? { model } : undefined');
  });

  it('the /help text documents --model', () => {
    const help = commandBlock("case '!help':", "case '!tools':");
    expect(help).toMatch(/\/start --model/);
    expect(help).toMatch(/VALID_ALIAS_HINT/);
  });
});
