// Unit tests for the pure parts of npm run pair (setup/pair.mjs), the shared
// setup helpers it reuses from setup/common.mjs, and the wizard's token-source
// menu. The interactive flows themselves need a live journal.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseArgs, pairingJournalUrl } from '../setup/pair.mjs';
import { currentToken, tokenEnv, TOKEN_PATH, pairWithApp } from '../setup/common.mjs';
import { tokenMethod } from '../setup/wizard.mjs';

describe('npm run pair argument parsing', () => {
  it('defaults to the .env journal, no force', () => {
    expect(parseArgs([])).toEqual({ server: '', force: false, help: false });
  });

  it('accepts --server <url>, --server=<url> and --force', () => {
    expect(parseArgs(['--server', 'journal.example.com', '--force']))
      .toEqual({ server: 'journal.example.com', force: true, help: false });
    expect(parseArgs(['--server=https://j.example.com']).server).toBe('https://j.example.com');
  });

  it('rejects a missing --server value and unknown arguments', () => {
    expect(() => parseArgs(['--server'])).toThrow(/needs a URL/);
    expect(() => parseArgs(['--server', '--force'])).toThrow(/needs a URL/);
    expect(() => parseArgs(['--server='])).toThrow(/needs a URL/);
    expect(() => parseArgs(['--frce'])).toThrow(/unknown argument/);
  });
});

describe('pairing journal URL', () => {
  it('normalises https and bare hosts to the bridge wss form', () => {
    expect(pairingJournalUrl('https://journal.example.com')).toBe('wss://journal.example.com/ws');
    expect(pairingJournalUrl('journal.example.com')).toBe('wss://journal.example.com/ws');
  });

  it('allows plain ws:// only for this machine', () => {
    expect(pairingJournalUrl('ws://127.0.0.1:9810/ws')).toBe('ws://127.0.0.1:9810/ws');
    expect(() => pairingJournalUrl('http://journal.example.com')).toThrow(/cleartext/);
  });

  it('rejects garbage', () => {
    expect(() => pairingJournalUrl('ftp://x')).toThrow(/could not parse/);
  });

  it('pairWithApp refuses a remote cleartext journal before any request', async () => {
    await expect(pairWithApp({ journalUrl: 'ws://journal.example.com/ws', print: () => {} }))
      .rejects.toThrow(/cleartext/);
  });
});

describe('currentToken (same precedence as index.js)', () => {
  it('prefers JOURNAL_TOKEN_FILE over JOURNAL_TOKEN', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pair-env-'));
    const file = path.join(dir, 'tok');
    fs.writeFileSync(file, ' from-file \n');
    expect(currentToken({ JOURNAL_TOKEN_FILE: file, JOURNAL_TOKEN: 'raw' })).toBe('from-file');
    fs.rmSync(dir, { recursive: true });
  });

  it('treats an unreadable token file as no token (no fall-back to JOURNAL_TOKEN)', () => {
    expect(currentToken({ JOURNAL_TOKEN_FILE: '/nonexistent/tok', JOURNAL_TOKEN: 'raw' })).toBe('');
  });

  it('uses JOURNAL_TOKEN when no file is set', () => {
    expect(currentToken({ JOURNAL_TOKEN: ' raw ' })).toBe('raw');
    expect(currentToken({})).toBe('');
  });
});

describe('tokenEnv', () => {
  it('points .env at the repo token file and clears the raw token', () => {
    expect(tokenEnv('wss://j.example.com/ws')).toEqual({
      JOURNAL_WS_URL: 'wss://j.example.com/ws',
      JOURNAL_TOKEN_FILE: TOKEN_PATH,
      JOURNAL_TOKEN: '',
    });
    expect(path.basename(TOKEN_PATH)).toBe('.journal-token');
  });
});

describe('wizard token-source menu', () => {
  it('defaults to pairing on Enter', () => {
    expect(tokenMethod('')).toBe('pair');
    expect(tokenMethod('1')).toBe('pair');
  });

  it('accepts 2 for pasting a matron-admin token', () => {
    expect(tokenMethod('2')).toBe('paste');
    expect(tokenMethod(' paste ')).toBe('paste');
  });

  it('flags anything else', () => {
    expect(tokenMethod('3')).toBe(null);
  });
});
