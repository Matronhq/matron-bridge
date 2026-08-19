// Unit tests for the setup wizard's pure prompt/env logic — specifically the
// two re-run behaviors: clearing the allowlist with the '-' sentinel, and
// pre-filling a stored journal URL even when it equals the .env.example
// default (the documented local-journal URL).
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  resolveAnswer,
  clearableAnswer,
  previousJournalUrl,
  parseEnv,
  buildEnv,
} from '../setup/wizard.mjs';

const REPO_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

describe('allowlist clearing on re-run', () => {
  it('plain Enter keeps the stored allowlist (the default)', () => {
    expect(resolveAnswer('', 'greg')).toBe('greg');
    expect(resolveAnswer('   ', 'greg')).toBe('greg');
  });

  it("'-' clears a stored allowlist back to empty (allow any user)", () => {
    expect(clearableAnswer(resolveAnswer('-', 'greg'))).toBe('');
  });

  it('a typed username replaces the stored one', () => {
    expect(clearableAnswer(resolveAnswer('dan', 'greg'))).toBe('dan');
  });

  it("'-' on a first run is the same as empty", () => {
    expect(clearableAnswer(resolveAnswer('-', ''))).toBe('');
  });

  it('a cleared allowlist overwrites the stored value in the written .env', () => {
    const example = 'ALLOWED_USER_IDS=\nOTHER=1\n';
    const existing = { ALLOWED_USER_IDS: 'greg', OTHER: '1' };
    const owned = { ALLOWED_USER_IDS: '' };
    const env = buildEnv(example, existing, owned);
    expect(parseEnv(env).ALLOWED_USER_IDS).toBe('');
    expect(parseEnv(env).OTHER).toBe('1');
  });
});

describe('journal URL default on re-run', () => {
  it('pre-fills a stored URL that equals the .env.example default', () => {
    const exampleDefaults = parseEnv(fs.readFileSync(path.join(REPO_DIR, '.env.example'), 'utf8'));
    expect(exampleDefaults.JOURNAL_WS_URL).toBeTruthy(); // the documented local URL
    expect(previousJournalUrl({ JOURNAL_WS_URL: exampleDefaults.JOURNAL_WS_URL }))
      .toBe(exampleDefaults.JOURNAL_WS_URL);
  });

  it('pre-fills any other stored URL', () => {
    expect(previousJournalUrl({ JOURNAL_WS_URL: 'wss://journal.example.com/ws' }))
      .toBe('wss://journal.example.com/ws');
  });

  it('offers no default on a first run (no .env)', () => {
    expect(previousJournalUrl({})).toBe('');
  });
});
