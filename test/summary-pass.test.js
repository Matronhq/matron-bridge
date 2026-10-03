import { describe, it, expect } from 'vitest';
import { summaryWindow, buildSummaryPrompt, SUMMARY_MIN_NEW, SUMMARY_WINDOW_CAP } from '../lib/summary-pass.js';

// Voice mode spec 2026-10-03 §1, "What is written": the two lines, word for
// word (the spec wraps them for the page; the prompt carries each on one line).
const SPOKEN_LINE = 'SPOKEN: <what someone listening while driving should hear about the agent\'s latest reply, 40 words at most. First, anything the agent is asking or needs decided, naming the options. Then the outcome in one sentence. Then what it will do next, only if that matters. Plain spoken English. No code, file paths, URLs, PR or issue numbers, markdown or lists, and never a password, key, token or other secret value. If the reply has a table, a diff or a long list, say it is in the chat instead of reading it.>';
const SPOKEN_MORE_LINE = 'SPOKEN_MORE: <the next thing that listener would want if they said "tell me more", 150 words at most. Do not repeat SPOKEN. Give the reasoning behind the question or result, what each option would mean, and any risk or caveat the agent raised. Same plain spoken style and the same exclusions. Write NONE if SPOKEN already says everything.>';

const msgs = (n, start = 0) => Array.from({ length: n }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', text: `m${start + i}` }));

describe('summaryWindow', () => {
  it('slices strictly after the last summarized message', () => {
    const h = msgs(12);
    const { messages, newCount, nextCount } = summaryWindow(h, 7);
    expect(messages.map((m) => m.text)).toEqual(['m7', 'm8', 'm9', 'm10', 'm11']);
    expect(newCount).toBe(5);
    expect(nextCount).toBe(12);
  });
  it('caps at 200 keeping the NEWEST overflow, and still advances past dropped messages', () => {
    const h = msgs(450);
    const { messages, newCount, nextCount } = summaryWindow(h, 100);
    expect(messages).toHaveLength(SUMMARY_WINDOW_CAP);
    expect(messages[0].text).toBe('m250'); // oldest overflow (m100..m249) dropped
    expect(messages.at(-1).text).toBe('m449');
    expect(newCount).toBe(350);
    expect(nextCount).toBe(450); // cursor passes the dropped region — never re-summarized
  });
  it('tolerates a cursor beyond the history (restart clamp)', () => {
    const { messages, nextCount } = summaryWindow(msgs(3), 99);
    expect(messages).toEqual([]);
    expect(nextCount).toBe(3);
  });
});

describe('buildSummaryPrompt', () => {
  it('embeds messages as role: text and keeps ROSTER as the last format key', () => {
    const p = buildSummaryPrompt({ messages: msgs(2), priorRoster: null, hasCumulative: false });
    expect(p).toContain('user: m0');
    expect(p.lastIndexOf('ROSTER:')).toBeGreaterThan(p.lastIndexOf('TITLE:'));
    expect(p.lastIndexOf('ROSTER:')).toBeGreaterThan(p.lastIndexOf('SUMMARY:'));
  });
  it('includes the prior roster inside a fenced preamble, and uses NEW: when cumulative exists', () => {
    const p = buildSummaryPrompt({ messages: msgs(2), priorRoster: 'Was fixing auth.\nTITLE: sneaky', hasCumulative: true });
    expect(p).toContain('Was fixing auth.');
    expect(p).toContain('NEW:');
    // the fenced preamble sits before the format block so a hostile roster line can't terminate it
    expect(p.indexOf('Was fixing auth.')).toBeLessThan(p.indexOf('Format:'));
  });
  it('omits the preamble when there is no prior roster', () => {
    const p = buildSummaryPrompt({ messages: msgs(2), priorRoster: null, hasCumulative: false });
    expect(p).not.toContain('previous rolling summary');
  });

  it.each([
    ['the NEW variant', true, 'NEW'],
    ['the first-pass SUMMARY variant', false, 'SUMMARY'],
  ])('%s asks for SPOKEN then SPOKEN_MORE, in the spec\'s words, with ROSTER still last', (_name, hasCumulative, second) => {
    const p = buildSummaryPrompt({ messages: msgs(2), priorRoster: null, hasCumulative });
    const format = p.slice(p.indexOf('Format:'), p.indexOf('\n\nMessages:'));
    const keys = format.split('\n').filter((l) => /^[A-Z_]+: </.test(l)).map((l) => l.slice(0, l.indexOf(':')));
    expect(keys).toEqual(['TITLE', second, 'SPOKEN', 'SPOKEN_MORE', 'ROSTER']);
    expect(format.split('\n')).toContain(SPOKEN_LINE);
    expect(format.split('\n')).toContain(SPOKEN_MORE_LINE);
    // The numbered list above the format block names the spoken versions too,
    // so the model is not told "three things" and shown five keys.
    expect(p.slice(0, p.indexOf('Format:'))).toContain('3. Two spoken versions of the agent\'s latest reply, for someone listening instead of reading');
    expect(p.slice(0, p.indexOf('Format:'))).toContain('4. A 2-3 sentence rolling summary');
  });
});

describe('gate constants', () => {
  it('exports the gate constants the index.js wiring consumes', () => {
    expect(SUMMARY_MIN_NEW).toBe(1);
    expect(SUMMARY_WINDOW_CAP).toBe(200);
  });
});
