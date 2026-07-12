// Pure parsing/formatting for the /limits command. The bridge shells out to
// `claude -p "/usage" --output-format text` (I/O lives in index.js) and feeds
// the stdout here. Kept side-effect-free so it is unit-testable without
// spawning a claude process. Mirrors lib/model-command.js / lib/session-mode.js.

// Percent thresholds reuse the color idiom from index.js (/cost, /usage):
// green under half, orange approaching the limit, red at/over 80%.
const GREEN = '#3fb950';
const ORANGE = '#f0883e';
const RED = '#f85149';

function percentColor(p) {
  if (p < 50) return GREEN;
  if (p < 80) return ORANGE;
  return RED;
}

// Local copies of index.js's helpers so this module has no import cycle.
// Keep the "-escaping in sync with index.js's escapeHtml: output here only
// lands in element content today (no linkifier or attribute sink in this
// module), but escaping quotes keeps the helper safe if that changes.
function escapeHtml(text) {
  return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function color(text, hex) {
  return `<font color="${hex}">${text}</font>`;
}

// Matches e.g. "Current session: 39% used · resets Jul 9, 12:59am (UTC)" and
// "Current week (all models): 66% used · resets ...". The separator between
// "used" and "resets" varies (a middot in practice), so match loosely on the
// "resets" keyword rather than the punctuation.
const LINE_RE = /^Current\s+(.+?):\s*(\d+)%\s+used\b.*?\bresets\s+(.+?)\s*$/i;

// Turn the raw `/usage` text into structured headline lines. Returns
// { ok, lines } where each line is { label, percent, resets }. ok is false
// (and lines empty) when no headline lines are found — the caller then falls
// back to posting the raw text.
export function parseUsageLimits(rawText) {
  const lines = [];
  for (const line of String(rawText ?? '').split('\n')) {
    const m = line.match(LINE_RE);
    if (!m) continue;
    const rawLabel = m[1].trim();
    lines.push({
      // Strip the "Current " prefix (already dropped by the regex) and
      // uppercase the first character: "session" -> "Session",
      // "week (all models)" -> "Week (all models)". No model name hardcoded.
      label: rawLabel.charAt(0).toUpperCase() + rawLabel.slice(1),
      percent: parseInt(m[2], 10),
      resets: m[3].trim(),
    });
  }
  return { ok: lines.length > 0, lines };
}

// Build the Matrix message. Returns { plain, html }. When parsed.ok is false,
// falls back to the raw text verbatim so the command degrades visibly (e.g.
// API-key accounts, login-required, or a future output-format change) instead
// of silently showing nothing.
export function formatLimits(parsed, rawText) {
  if (!parsed || !parsed.ok) {
    const raw = String(rawText ?? '').trim();
    return {
      plain: raw || 'No usage information available.',
      html: escapeHtml(raw || 'No usage information available.').replace(/\n/g, '<br/>'),
    };
  }

  const plainLines = parsed.lines.map(
    (l) => `${l.label}: ${l.percent}% · resets ${l.resets}`,
  );
  const htmlLines = parsed.lines.map(
    (l) => `${escapeHtml(l.label)}: ${color(`${l.percent}%`, percentColor(l.percent))} · resets ${escapeHtml(l.resets)}`,
  );

  return {
    plain: `📊 Subscription Usage\n\n${plainLines.join('\n')}`,
    html: `<b>📊 Subscription Usage</b><br/><br/>${htmlLines.join('<br/>')}`,
  };
}
