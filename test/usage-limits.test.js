import { describe, it, expect } from 'vitest';
import { parseUsageLimits, formatLimits } from '../lib/usage-limits.js';

// Real `claude -p "/usage" --output-format text` output (subscription account).
// Note the middot separator (·) is the literal character Claude Code emits.
const SUBSCRIPTION_SAMPLE = `You are currently using your subscription to power your Claude Code usage

Current session: 39% used · resets Jul 9, 12:59am (UTC)
Current week (all models): 66% used · resets Jul 12, 6:59pm (UTC)
Current week (Fable): 100% used · resets Jul 12, 6:59pm (UTC)

What's contributing to your limits usage?
Approximate, based on local sessions on this machine — does not include other devices or claude.ai.

Last 24h · 1732 requests · 3 sessions
  74% of your usage was at >150k context
`;

const GREEN = '#3fb950';
const ORANGE = '#f0883e';
const RED = '#f85149';

describe('parseUsageLimits', () => {
  it('extracts the Current session / week headline lines', () => {
    const { ok, lines } = parseUsageLimits(SUBSCRIPTION_SAMPLE);
    expect(ok).toBe(true);
    expect(lines).toEqual([
      { label: 'Session', percent: 39, resets: 'Jul 9, 12:59am (UTC)' },
      { label: 'Week (all models)', percent: 66, resets: 'Jul 12, 6:59pm (UTC)' },
      { label: 'Week (Fable)', percent: 100, resets: 'Jul 12, 6:59pm (UTC)' },
    ]);
  });

  it('does not include the intro line or the "what\'s contributing" breakdown', () => {
    const { lines } = parseUsageLimits(SUBSCRIPTION_SAMPLE);
    expect(lines).toHaveLength(3);
    for (const l of lines) {
      expect(l.label).not.toMatch(/contributing|requests|subscription/i);
    }
  });

  it('reports ok:false with no lines when nothing matches', () => {
    const { ok, lines } = parseUsageLimits('Some unrelated output about an API key.\nNo limits here.');
    expect(ok).toBe(false);
    expect(lines).toEqual([]);
  });

  it('handles empty / nullish input without throwing', () => {
    expect(parseUsageLimits('')).toEqual({ ok: false, lines: [] });
    expect(parseUsageLimits(null)).toEqual({ ok: false, lines: [] });
    expect(parseUsageLimits(undefined)).toEqual({ ok: false, lines: [] });
  });
});

describe('formatLimits', () => {
  it('produces a plain-text headline block', () => {
    const parsed = parseUsageLimits(SUBSCRIPTION_SAMPLE);
    const { plain } = formatLimits(parsed, SUBSCRIPTION_SAMPLE);
    expect(plain).toContain('Subscription Usage');
    expect(plain).toContain('Session: 39% · resets Jul 9, 12:59am (UTC)');
    expect(plain).toContain('Week (all models): 66% · resets Jul 12, 6:59pm (UTC)');
    expect(plain).toContain('Week (Fable): 100% · resets Jul 12, 6:59pm (UTC)');
    // The breakdown must not leak into the formatted output.
    expect(plain).not.toContain('requests');
  });

  it('color-codes percentages by threshold in HTML', () => {
    const parsed = parseUsageLimits(SUBSCRIPTION_SAMPLE);
    const { html } = formatLimits(parsed, SUBSCRIPTION_SAMPLE);
    expect(html).toContain(`<font color="${GREEN}">39%</font>`);   // < 50
    expect(html).toContain(`<font color="${ORANGE}">66%</font>`);  // < 80
    expect(html).toContain(`<font color="${RED}">100%</font>`);    // >= 80
  });

  it('maps threshold boundaries to the right colors', () => {
    const mk = (percent) => formatLimits(
      { ok: true, lines: [{ label: 'Session', percent, resets: 'soon' }] },
      '',
    ).html;
    expect(mk(49)).toContain(`<font color="${GREEN}">49%</font>`);
    expect(mk(50)).toContain(`<font color="${ORANGE}">50%</font>`);
    expect(mk(79)).toContain(`<font color="${ORANGE}">79%</font>`);
    expect(mk(80)).toContain(`<font color="${RED}">80%</font>`);
  });

  it('falls back to the raw text when parsing found nothing', () => {
    const raw = 'Login required. Run `claude` to authenticate.';
    const parsed = parseUsageLimits(raw);
    const { plain, html } = formatLimits(parsed, raw);
    expect(plain).toContain('Login required');
    expect(html).toContain('Login required');
  });

  it('escapes HTML-special characters in the fallback', () => {
    const raw = 'error: <bad> & "stuff"';
    const { html } = formatLimits(parseUsageLimits(raw), raw);
    expect(html).toContain('&lt;bad&gt;');
    expect(html).toContain('&amp;');
    expect(html).toContain('&quot;stuff&quot;');
    expect(html).not.toContain('<bad>');
    expect(html).not.toContain('"stuff"');
  });

  it('escapes double quotes in parsed labels and reset times', () => {
    const { html } = formatLimits(
      { ok: true, lines: [{ label: 'week ("all" models)', percent: 10, resets: 'Jul 9, "noon"' }] },
      '',
    );
    expect(html).toContain('week (&quot;all&quot; models)');
    expect(html).toContain('Jul 9, &quot;noon&quot;');
  });
});
