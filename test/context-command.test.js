import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { contextFullToNative, briefContextReport } from '../lib/context-command.js';

// A representative /context report as claude's local command emits it (the
// real one carries many more table rows and sections — the trim must drop
// all of them).
const FULL_REPORT = [
  '## Context Usage',
  '',
  '**Model:** claude-fable-5  ',
  '**Tokens:** 253.4k / 1m (25%)',
  '',
  '### Estimated usage by category',
  '',
  '| Category | Tokens | Percentage |',
  '|----------|--------|------------|',
  '| System prompt | 4.7k | 0.5% |',
  '| Messages | 232k | 23.2% |',
  '',
  '### MCP Tools',
  '',
  '| Tool | Server | Tokens |',
  '|------|--------|--------|',
  '| mcp__ask-user__request_secret | ask-user | 185 |',
].join('\n');

describe('contextFullToNative', () => {
  it('rewrites /context-full to the native /context', () => {
    expect(contextFullToNative('/context-full')).toBe('/context');
  });

  it('tolerates surrounding whitespace', () => {
    expect(contextFullToNative('  /context-full  \n')).toBe('/context');
  });

  it('leaves plain /context alone (no rewrite needed)', () => {
    expect(contextFullToNative('/context')).toBeNull();
  });

  it('ignores /context-full with trailing arguments or extra text', () => {
    expect(contextFullToNative('/context-full please')).toBeNull();
    expect(contextFullToNative('run /context-full')).toBeNull();
    // A busy-queue flush merges queued messages into one text block —
    // a slash command buried in there wouldn't have run natively either.
    expect(contextFullToNative('first message\n\n/context-full')).toBeNull();
  });

  it('ignores non-command text and non-strings', () => {
    expect(contextFullToNative('hello')).toBeNull();
    expect(contextFullToNative('/context-fullish')).toBeNull();
    expect(contextFullToNative(undefined)).toBeNull();
    expect(contextFullToNative(null)).toBeNull();
  });
});

describe('briefContextReport', () => {
  it('trims a full report to the Model/Tokens headline plus the /context-full pointer', () => {
    const brief = briefContextReport(FULL_REPORT);
    expect(brief).toBe(
      '**Model:** claude-fable-5  \n**Tokens:** 253.4k / 1m (25%)\n\nSend /context-full for full context.',
    );
  });

  it('drops every table and section from the full report', () => {
    const brief = briefContextReport(FULL_REPORT);
    expect(brief).not.toContain('###');
    expect(brief).not.toContain('|');
  });

  it('returns null for ordinary assistant text', () => {
    expect(briefContextReport('Here is my answer about **Model:** things.')).toBeNull();
    expect(briefContextReport('## Some Other Heading\n\n**Model:** x\n**Tokens:** y')).toBeNull();
  });

  it('returns null when the headline lines are missing (fall back to full output)', () => {
    expect(briefContextReport('## Context Usage\n\nno headline lines here')).toBeNull();
    expect(briefContextReport('## Context Usage\n\n**Model:** claude-fable-5')).toBeNull();
  });

  it('returns null for non-strings', () => {
    expect(briefContextReport(undefined)).toBeNull();
    expect(briefContextReport(null)).toBeNull();
  });
});

// index.js can't be imported in-process (it starts the bridge), so pin the
// wiring by source inspection — same pattern as the journal-input-router
// wiring tests.
describe('index.js wiring', () => {
  const src = readFileSync(fileURLToPath(new URL('../index.js', import.meta.url)), 'utf-8');

  it('imports both halves from lib/context-command.js', () => {
    expect(src).toMatch(/import \{[^}]*contextFullToNative[^}]*\} from '\.\/lib\/context-command\.js'/);
    expect(src).toMatch(/import \{[^}]*briefContextReport[^}]*\} from '\.\/lib\/context-command\.js'/);
  });

  it('sendToSession rewrites /context-full and arms the one-shot full flag', () => {
    const start = src.indexOf('function sendToSession(');
    expect(start).toBeGreaterThan(-1);
    const end = src.indexOf('\nfunction ', start + 1);
    const body = src.slice(start, end);
    expect(body).toContain('contextFullToNative(');
    expect(body).toContain('_contextFullOnce = true');
  });

  it('flushResponse trims context reports unless the full flag is armed', () => {
    const start = src.indexOf('function flushResponse(');
    expect(start).toBeGreaterThan(-1);
    const end = src.indexOf('\nfunction ', start + 1);
    const body = src.slice(start, end);
    expect(body).toContain('briefContextReport(');
    expect(body).toContain('_contextFullOnce');
  });
});
