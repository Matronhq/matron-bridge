import { describe, it, expect } from 'vitest';
import { usageMissNote, createUsageMissLogger } from '../lib/usage-limits.js';

// What 2.1.289 printed on the desks with CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC
// set: the account line, then straight to the local stats.
const NO_LIMITS_SAMPLE = `You are currently using your subscription to power your Claude Code usage

What's contributing to your limits usage?
Approximate, based on local sessions on this machine — does not include other devices or claude.ai.
`;

describe('usageMissNote', () => {
  it('quotes the first line when the limit lines are missing', () => {
    expect(usageMissNote({ raw: NO_LIMITS_SAMPLE })).toBe(
      'no limit lines in /usage output (it began: You are currently using your subscription to power your Claude Code usage)',
    );
  });

  it('says so when the output is empty', () => {
    expect(usageMissNote({ raw: '\n  \n' })).toBe('empty /usage output');
    expect(usageMissNote({})).toBe('empty /usage output');
  });

  it('keeps an error to its first line, capped', () => {
    expect(usageMissNote({ error: new Error('timed out') })).toBe('failed: timed out');
    const note = usageMissNote({ error: new Error(`${'x'.repeat(500)}\nsecond line`) });
    expect(note).toBe(`failed: ${'x'.repeat(200)}`);
  });
});

describe('createUsageMissLogger', () => {
  it('logs once per streak of misses and once on recovery', () => {
    const lines = [];
    const logger = createUsageMissLogger((l) => lines.push(l));
    logger.ok();
    logger.miss({ raw: NO_LIMITS_SAMPLE });
    logger.miss({ error: new Error('timed out') });
    logger.miss({ raw: '' });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^Usage limits: no limit lines in \/usage output/);
    logger.ok();
    logger.ok();
    expect(lines).toEqual([lines[0], 'Usage limits: /usage reports limits again']);
    logger.miss({ error: new Error('timed out') });
    expect(lines[2]).toBe('Usage limits: failed: timed out');
  });
});

// Source-text assertions on index.js (the idiom of test/box-status-wiring.test.js:
// index.js has no unit harness). The refresh must report both kinds of miss.
describe('usage miss logger wiring', async () => {
  const { readFileSync } = await import('node:fs');
  const index = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
  const start = index.indexOf('function refreshUsageLimits(');
  const fn = index.slice(start, index.indexOf('\n}\n', start));

  it('logs a parse with no lines, a failed fetch, and recovery', () => {
    expect(index).toMatch(/const usageMissLog = createUsageMissLogger\(\(m\) => console\.warn\(m\)\);/);
    expect(fn).toMatch(/usageMissLog\.ok\(\);/);
    expect(fn).toMatch(/\} else \{\n\s*usageMissLog\.miss\(\{ raw \}\);/);
    expect(fn).toMatch(/usageMissLog\.miss\(\{ error: e \}\);/);
  });
});
