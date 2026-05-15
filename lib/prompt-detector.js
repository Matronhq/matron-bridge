import { EventEmitter } from 'node:events';

// Strip ANSI escape sequences plus all CR (which the TUI uses to overwrite
// the current line; CR-LF is normalised to LF).
// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;?<>=!]*[ -/]*[@-~]|\x1b[@-_]|\x1b\][^\x07]*\x07/g;
const CR_RE = /\r/g;

export function stripAnsi(s) {
  return s.replace(ANSI_RE, '').replace(CR_RE, '');
}

const YN_RE = /[[(]\s*[yY]\s*\/\s*[Nn]\s*[\])]|[[(]\s*[Yy]\s*\/\s*[nN]\s*[\])]/;
const NUMBERED_LINE_RE = /^\s*(\d+)[.)]\s+(.+)$/;
const LETTERED_LINE_RE = /^\s*\(?([a-zA-Z])\)?[.)]\s+(.+)$/;
const ARROW_MARKER_RE = /^(\s*)([❯>▶►])\s+(.+)$/;

// Classify a screen (already ANSI-stripped) as one of the prompt kinds we
// know how to respond to. Returns `null` if the screen does not look like a
// prompt — false negatives are preferred over false positives, since false
// positives spam Matrix with "claude is asking" messages mid-response.
export function classifyScreen(screen) {
  if (!screen) return null;
  const lines = screen.split('\n').map(l => l.trimEnd());

  // Yes/No — search the whole screen (it can appear in the middle of an
  // explanation, not necessarily on the last line).
  if (YN_RE.test(screen)) {
    const matchLineIdx = lines.findIndex(l => YN_RE.test(l));
    const question = lines.slice(Math.max(0, matchLineIdx - 1), matchLineIdx + 1).join(' ').trim();
    return {
      kind: 'yes-no',
      question: question.replace(YN_RE, '').trim() || question,
      options: [
        { key: 'y', label: 'Yes' },
        { key: 'n', label: 'No' },
      ],
    };
  }

  // Numbered selection — at least two consecutive lines matching ^ *\d+[.)] .+
  {
    const items = collectConsecutive(lines, NUMBERED_LINE_RE);
    if (items.length >= 2) {
      const opts = items.matches.map(m => ({ key: m[1], label: m[2].trim() }));
      const question = lines.slice(Math.max(0, items.startIdx - 2), items.startIdx).join(' ').trim();
      return { kind: 'numbered', question, options: opts };
    }
  }

  // Lettered selection — at least two consecutive lines matching ^ *\(?[a-z]\)?[.)] .+
  {
    const items = collectConsecutive(lines, LETTERED_LINE_RE);
    if (items.length >= 2) {
      const opts = items.matches.map(m => ({ key: m[1].toLowerCase(), label: m[2].trim() }));
      const question = lines.slice(Math.max(0, items.startIdx - 2), items.startIdx).join(' ').trim();
      return { kind: 'lettered', question, options: opts };
    }
  }

  // Arrow menu — a line whose first non-blank is a marker (❯/>/▶), followed
  // by sibling lines at the same indent.
  {
    const markerIdx = lines.findIndex(l => ARROW_MARKER_RE.test(l));
    if (markerIdx >= 0) {
      const m = lines[markerIdx].match(ARROW_MARKER_RE);
      const indent = m[1].length;
      const items = [{ label: m[3].trim(), selected: true }];
      for (let i = markerIdx + 1; i < lines.length; i++) {
        const line = lines[i];
        // Sibling: same-or-greater indent, contains visible text, not a
        // separator or empty line.
        const sm = line.match(/^(\s*)(.*)$/);
        if (!sm) break;
        if (sm[1].length < indent) break;
        const rest = sm[2].replace(/^[❯>▶►]\s*/, '').trim();
        if (!rest) break;
        // Skip lines that look like another prompt (input separator, etc.)
        if (/^[-=_]{3,}$/.test(rest)) break;
        items.push({ label: rest, selected: false });
        if (items.length >= 20) break; // sanity
      }
      if (items.length >= 2) {
        const question = lines.slice(Math.max(0, markerIdx - 2), markerIdx).join(' ').trim();
        return { kind: 'arrow-menu', question, options: items };
      }
    }
  }

  return null;
}

// Find a maximal run of consecutive lines matching `re`. Returns { length,
// matches, startIdx } where matches[i] is the regex result for line i in the
// run. Used by numbered and lettered detectors.
function collectConsecutive(lines, re) {
  let bestLen = 0;
  let bestStart = -1;
  let bestMatches = [];
  let cur = [];
  let curStart = -1;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(re);
    if (m) {
      if (cur.length === 0) curStart = i;
      cur.push(m);
    } else {
      if (cur.length > bestLen) { bestLen = cur.length; bestStart = curStart; bestMatches = cur; }
      cur = [];
      curStart = -1;
    }
  }
  if (cur.length > bestLen) { bestLen = cur.length; bestStart = curStart; bestMatches = cur; }
  return { length: bestLen, matches: bestMatches, startIdx: bestStart };
}

// Watches a stream of PTY bytes, accumulates the screen, and emits `prompt`
// events when classifyScreen detects one after a brief idle period. The idle
// gate prevents the detector from firing mid-render (when the screen is
// transiently in an ambiguous state).
export class PromptDetector extends EventEmitter {
  constructor({ idleMs = 300, bufferLimit = 16384 } = {}) {
    super();
    this.idleMs = idleMs;
    this.bufferLimit = bufferLimit;
    this.buf = '';
    this.timer = null;
    this.lastEmitted = null;
  }

  feed(chunk) {
    this.buf += chunk;
    if (this.buf.length > this.bufferLimit) {
      this.buf = this.buf.slice(-this.bufferLimit);
    }
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this._check(), this.idleMs);
    if (typeof this.timer.unref === 'function') this.timer.unref();
  }

  _check() {
    const screen = stripAnsi(this.buf);
    const r = classifyScreen(screen);
    if (!r) return;
    const sig = `${r.kind}::${r.question}::${r.options.map(o => o.label).join('|')}`;
    if (sig === this.lastEmitted) return;
    this.lastEmitted = sig;
    // Clear the accumulated buffer so a subsequent identical re-render of the
    // same prompt classifies to the same signature (and is suppressed). If we
    // kept appending, the question/options text would shift inside a growing
    // screen and the sig would diverge.
    this.buf = '';
    this.emit('prompt', r);
  }

  // Call after responding to a prompt so the SAME prompt text can fire again
  // later (otherwise repeated identical prompts would be silently dropped).
  reset() {
    this.buf = '';
    this.lastEmitted = null;
  }
}
