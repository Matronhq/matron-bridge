import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import os from 'os';
import {
  extractSummaryFromContent,
  readSessionSummary,
  listSessionSummaries,
} from '../lib/session-summary.js';

// Bounded, async session-summary reads (review fast-follow on the /sessions
// command). The old index.js getSessionSummary readFileSync'd EVERY
// transcript in the history dir — whole files, all of them, sliced to 15
// only after reading everything — blocking the event loop for all rooms and
// the journal socket. These tests pin the extraction format byte-for-byte
// and prove the new read-bounding: stat-sort first, read only the newest
// `limit` files, and per-file only a bounded head chunk.

function userLine(text) {
  return JSON.stringify({ type: 'user', message: { role: 'user', content: text } });
}

describe('extractSummaryFromContent (format pinned to the old sync implementation)', () => {
  it('returns the first user text, trimmed', () => {
    const content = [
      JSON.stringify({ type: 'summary', summary: 'not this' }),
      userLine('  fix the flaky test  '),
      userLine('second message'),
    ].join('\n');
    expect(extractSummaryFromContent(content)).toBe('fix the flaky test');
  });

  it('reads array-form content via the first text block', () => {
    const content = JSON.stringify({
      type: 'user',
      message: { role: 'user', content: [{ type: 'image' }, { type: 'text', text: 'from a block' }] },
    });
    expect(extractSummaryFromContent(content)).toBe('from a block');
  });

  it('skips <local-command and <command-name> pseudo-messages', () => {
    const content = [
      userLine('<local-command-stdout>ok</local-command-stdout>'),
      userLine('<command-name>/help</command-name>'),
      userLine('the real first message'),
    ].join('\n');
    expect(extractSummaryFromContent(content)).toBe('the real first message');
  });

  it('strips tags and caps at 80 chars with an ellipsis', () => {
    const long = 'x'.repeat(100);
    expect(extractSummaryFromContent(userLine(`<b>${long}</b>`))).toBe('x'.repeat(80) + '…');
    const exact = 'y'.repeat(80);
    expect(extractSummaryFromContent(userLine(exact))).toBe(exact);
  });

  it('skips blank lines and returns empty string when no user text exists', () => {
    expect(extractSummaryFromContent('\n\n' + JSON.stringify({ type: 'assistant' }) + '\n')).toBe('');
    expect(extractSummaryFromContent('')).toBe('');
  });

  it('aborts to empty string on a malformed line, exactly like the old whole-file try/catch', () => {
    const content = ['{not json', userLine('never reached')].join('\n');
    expect(extractSummaryFromContent(content)).toBe('');
  });
});

describe('readSessionSummary (bounded head read)', () => {
  let dir;
  beforeEach(async () => { dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'summary-test-')); });
  afterEach(async () => { await fsp.rm(dir, { recursive: true, force: true }); });

  it('reads a small file and returns the same summary the sync version did', async () => {
    const p = path.join(dir, 'a.jsonl');
    await fsp.writeFile(p, userLine('hello world') + '\n');
    expect(await readSessionSummary(p)).toBe('hello world');
  });

  it('finds a summary that sits within the head chunk of a file larger than the cap', async () => {
    const p = path.join(dir, 'b.jsonl');
    const head = userLine('early message') + '\n';
    const filler = (JSON.stringify({ type: 'assistant', pad: 'z'.repeat(200) }) + '\n').repeat(50);
    await fsp.writeFile(p, head + filler);
    expect(await readSessionSummary(p, { headBytes: 256 })).toBe('early message');
  });

  it('never reads past the cap: a first user message BEYOND the head chunk is not found', async () => {
    const p = path.join(dir, 'c.jsonl');
    const filler = (JSON.stringify({ type: 'assistant', pad: 'z'.repeat(200) }) + '\n').repeat(50);
    await fsp.writeFile(p, filler + userLine('too deep to see') + '\n');
    // The old unbounded version would have found it; the bounded read stops
    // at the cap — this is the accepted trade for not reading whole
    // transcripts on a listing command.
    expect(await readSessionSummary(p, { headBytes: 256 })).toBe('');
  });

  it('drops the truncated partial line at the cap boundary instead of mis-parsing it', async () => {
    const p = path.join(dir, 'd.jsonl');
    // First line fits fully inside the cap; second line straddles it.
    const line1 = userLine('within the cap');
    const line2 = userLine('straddles the boundary ' + 'w'.repeat(300));
    await fsp.writeFile(p, line1 + '\n' + line2 + '\n');
    expect(await readSessionSummary(p, { headBytes: line1.length + 50 })).toBe('within the cap');
  });

  it('returns empty string for a missing file, like the old catch-all', async () => {
    expect(await readSessionSummary(path.join(dir, 'nope.jsonl'))).toBe('');
  });
});

describe('listSessionSummaries (stat-sort first, read only the top limit)', () => {
  let dir;
  beforeEach(async () => { dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'sessions-test-')); });
  afterEach(async () => { await fsp.rm(dir, { recursive: true, force: true }); });

  async function writeFixtures(count) {
    const base = Date.now() / 1000 - count * 60;
    for (let i = 0; i < count; i++) {
      const name = `session-${String(i).padStart(2, '0')}.jsonl`;
      const p = path.join(dir, name);
      await fsp.writeFile(p, userLine(`message ${i}`) + '\n');
      // Deterministic, distinct mtimes: higher i = newer.
      const t = base + i * 60;
      fs.utimesSync(p, t, t);
    }
  }

  it('with >15 files, reads the contents of ONLY the 15 newest', async () => {
    await writeFixtures(20);
    const readSummary = vi.fn((filePath) => readSessionSummary(filePath));

    const items = await listSessionSummaries(dir, { limit: 15, readSummary });

    expect(items).toHaveLength(15);
    expect(readSummary).toHaveBeenCalledTimes(15);
    // Only the 15 newest (i = 5..19) were read; the 5 oldest never were.
    const readBasenames = readSummary.mock.calls.map(([p]) => path.basename(p)).sort();
    const expected = Array.from({ length: 15 }, (_, k) => `session-${String(k + 5).padStart(2, '0')}.jsonl`);
    expect(readBasenames).toEqual(expected);
  });

  it('returns items newest-first with the exact {sessionId, modified, summary} shape the command formats', async () => {
    await writeFixtures(3);
    const items = await listSessionSummaries(dir, { limit: 15 });

    expect(items.map(i => i.sessionId)).toEqual(['session-02', 'session-01', 'session-00']);
    for (const [idx, item] of items.entries()) {
      expect(item).toEqual({
        sessionId: `session-${String(2 - idx).padStart(2, '0')}`,
        modified: expect.any(Number),
        summary: `message ${2 - idx}`,
      });
    }
    expect(items[0].modified).toBeGreaterThan(items[1].modified);
  });

  it('ignores non-.jsonl files', async () => {
    await writeFixtures(1);
    await fsp.writeFile(path.join(dir, 'notes.txt'), 'not a session');
    const items = await listSessionSummaries(dir);
    expect(items).toHaveLength(1);
    expect(items[0].sessionId).toBe('session-00');
  });

  it('returns [] for an empty or missing directory', async () => {
    expect(await listSessionSummaries(dir)).toEqual([]);
    expect(await listSessionSummaries(path.join(dir, 'missing'))).toEqual([]);
  });
});
