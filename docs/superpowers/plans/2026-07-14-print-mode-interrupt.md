# Print-Mode Turn Interrupt (!esc) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `!esc`/`!escape` cancel the current turn of a print-mode session (both transports) via a `control_request`/`interrupt` line on the CLI's stdin, with a 10s wedge-guard fallback.

**Architecture:** A tiny fail-open lib module writes the control_request and arms a fallback timer; `lib/command-dispatch.js` gains a narrow print-mode classifier and an optional print path in the journal rescue dispatcher; `index.js` wires one shared `printModeInterrupt()` into both transport seams and cancels the timer wherever busy state clears.

**Tech Stack:** Node ESM, vitest (fake timers), no new dependencies.

**Spec:** docs/superpowers/specs/2026-07-14-print-mode-interrupt-design.md

## Global Constraints

- `!esc` and `!escape` ONLY trigger the print-mode interrupt. `!stop` and `!enter` must NOT — `!stop` keeps meaning "stop the session" in print mode; `!enter` stays iv-only.
- iv-mode rescue behavior is byte-for-byte untouched; the iv branch takes precedence whenever `session.iv?.alive`.
- Fail-open: nothing in these paths may throw into a transport handler. A failed stdin write reports via `onError` and arms no timer.
- The control_request wire shape is exactly `{"type":"control_request","request_id":"<uuid>","request":{"subtype":"interrupt"}}` + `\n` (verified against claude 2.1.207).
- `INTERRUPT_FALLBACK_MS = 10000`. The wedge timer MUST be cancelled on every busy-clear path (`case 'result':` normal + fatal-error, `killSession`) so a stale timer can never fire into a later turn.
- Reply copy (exact strings):
  - `⏹ Interrupt sent — waiting for claude to stop this turn.`
  - `Nothing to interrupt — claude is idle.`
  - `No claude process to interrupt.`
  - `Interrupt already sent — still waiting for claude to stop this turn.`
  - `⚠️ No response to the interrupt after 10s — cleared busy state. The turn may still be running; !stop kills the session if it stays stuck.`
  - `Could not send interrupt: <err.message>`
- Commits use conventional messages with trailer: `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`

---

### Task 1: `lib/print-interrupt.js`

**Files:**
- Create: `lib/print-interrupt.js`
- Create: `test/print-interrupt.test.js`
- Modify: `package.json` (check script)

**Interfaces:**
- Produces: `buildInterruptRequest(requestId?)` → `{type, request_id, request:{subtype}}`; `sendPrintInterrupt({stdin, onWedge, onError, timeoutMs?, setTimeoutFn?, clearTimeoutFn?})` → `{requestId, cancel}` or `null`; `INTERRUPT_FALLBACK_MS` (10000). Task 3 consumes `sendPrintInterrupt` + relies on `null` return meaning "onError already called, nothing armed".

- [ ] **Step 1: Write the failing tests** — `test/print-interrupt.test.js`:

```js
import { describe, it, expect, vi } from 'vitest';
import { buildInterruptRequest, sendPrintInterrupt, INTERRUPT_FALLBACK_MS } from '../lib/print-interrupt.js';

describe('buildInterruptRequest', () => {
  it('builds the control_request shape with a uuid request_id', () => {
    const req = buildInterruptRequest();
    expect(req.type).toBe('control_request');
    expect(req.request).toEqual({ subtype: 'interrupt' });
    expect(req.request_id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('uses an explicit requestId when given', () => {
    expect(buildInterruptRequest('fixed-id').request_id).toBe('fixed-id');
  });

  it('generates a fresh request_id per call', () => {
    expect(buildInterruptRequest().request_id).not.toBe(buildInterruptRequest().request_id);
  });
});

describe('sendPrintInterrupt', () => {
  const collect = () => {
    const writes = [];
    return { writes, stdin: { write: (s) => { writes.push(s); return true; } } };
  };

  it('writes one newline-terminated control_request line', () => {
    const { writes, stdin } = collect();
    const handle = sendPrintInterrupt({ stdin, onWedge: () => {}, onError: () => {} });
    expect(writes).toHaveLength(1);
    expect(writes[0].endsWith('\n')).toBe(true);
    const parsed = JSON.parse(writes[0]);
    expect(parsed).toEqual({
      type: 'control_request',
      request_id: handle.requestId,
      request: { subtype: 'interrupt' },
    });
  });

  it('fires onWedge after timeoutMs', () => {
    vi.useFakeTimers();
    try {
      const { stdin } = collect();
      const onWedge = vi.fn();
      sendPrintInterrupt({ stdin, onWedge, onError: () => {}, timeoutMs: 5000 });
      vi.advanceTimersByTime(4999);
      expect(onWedge).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(onWedge).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('defaults the timeout to INTERRUPT_FALLBACK_MS (10s)', () => {
    vi.useFakeTimers();
    try {
      const { stdin } = collect();
      const onWedge = vi.fn();
      sendPrintInterrupt({ stdin, onWedge, onError: () => {} });
      vi.advanceTimersByTime(INTERRUPT_FALLBACK_MS - 1);
      expect(onWedge).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(onWedge).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('cancel() prevents onWedge from firing', () => {
    vi.useFakeTimers();
    try {
      const { stdin } = collect();
      const onWedge = vi.fn();
      const handle = sendPrintInterrupt({ stdin, onWedge, onError: () => {}, timeoutMs: 5000 });
      handle.cancel();
      vi.advanceTimersByTime(10000);
      expect(onWedge).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('reports a write failure via onError, returns null, arms no timer', () => {
    vi.useFakeTimers();
    try {
      const boom = new Error('EPIPE');
      const stdin = { write: () => { throw boom; } };
      const onWedge = vi.fn();
      const onError = vi.fn();
      const handle = sendPrintInterrupt({ stdin, onWedge, onError, timeoutMs: 5000 });
      expect(handle).toBeNull();
      expect(onError).toHaveBeenCalledWith(boom);
      vi.advanceTimersByTime(60000);
      expect(onWedge).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('never throws when onError is omitted', () => {
    const stdin = { write: () => { throw new Error('EPIPE'); } };
    expect(sendPrintInterrupt({ stdin, onWedge: () => {} })).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/print-interrupt.test.js`
Expected: FAIL — cannot find module `../lib/print-interrupt.js`

- [ ] **Step 3: Implement** — `lib/print-interrupt.js`:

```js
// Print-mode turn interrupt: builds and writes a `control_request` /
// `interrupt` line to the claude CLI's stream-json stdin. Same control
// protocol the Agent SDK uses; verified against claude 2.1.207 — the CLI
// answers with a control_response, ends the in-flight turn with a `result`
// event (is_error: true, subtype: 'error_during_execution'), and keeps the
// process alive for subsequent turns.
//
// Fail-open contract (same stance as lib/journal-publisher.js): nothing here
// may throw into a transport handler — a write failure reports through
// onError and arms no fallback timer.
import { randomUUID } from 'node:crypto';

// If the CLI never delivers the turn-ending `result` (wedged process, a
// version that ignores control_request), the caller's onWedge fires after
// this long so the bridge can clear busy state instead of queueing messages
// forever.
export const INTERRUPT_FALLBACK_MS = 10000;

export function buildInterruptRequest(requestId = randomUUID()) {
  return { type: 'control_request', request_id: requestId, request: { subtype: 'interrupt' } };
}

// Writes one interrupt line to `stdin` and arms the fallback timer. Returns
// { requestId, cancel } — callers MUST cancel when the turn's `result`
// arrives so a completed interrupt can't fire a stale onWedge into a later
// turn. Returns null when the write fails (onError already called, no timer
// armed). setTimeoutFn/clearTimeoutFn are injection seams for tests.
export function sendPrintInterrupt({
  stdin,
  onWedge,
  onError,
  timeoutMs = INTERRUPT_FALLBACK_MS,
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
}) {
  const req = buildInterruptRequest();
  try {
    stdin.write(JSON.stringify(req) + '\n');
  } catch (err) {
    if (onError) onError(err);
    return null;
  }
  const timer = setTimeoutFn(onWedge, timeoutMs);
  return {
    requestId: req.request_id,
    cancel: () => clearTimeoutFn(timer),
  };
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run test/print-interrupt.test.js`
Expected: PASS (8 tests)

- [ ] **Step 5: Add to check script** — in `package.json`, in the `"check"` script, insert `node --check lib/print-interrupt.js && ` immediately before `node --check lib/session-summary.js` (keeping the single-line format). Run `npm run check` — expected exit 0.

- [ ] **Step 6: Commit**

```bash
git add lib/print-interrupt.js test/print-interrupt.test.js package.json
git commit -m "feat: print-interrupt lib — control_request writer with wedge-guard timer"
```

---

### Task 2: command-dispatch print-rescue classification

**Files:**
- Modify: `lib/command-dispatch.js` (add `classifyPrintRescue`; extend `dispatchJournalRescueKeystroke`)
- Modify: `test/command-dispatch.test.js`

**Interfaces:**
- Consumes: nothing new.
- Produces: `classifyPrintRescue(text)` → `'interrupt' | null`; `dispatchJournalRescueKeystroke(text, ivActive, { flushCursor, sendRescueKeystroke, printActive = false, sendPrintInterrupt = null })` — new keys optional, existing call sites unaffected. Task 3 consumes both.

- [ ] **Step 1: Write the failing tests** — append to `test/command-dispatch.test.js` (match the file's existing import/describe style; extend the import list with `classifyPrintRescue`):

```js
describe('classifyPrintRescue', () => {
  it('maps !esc and !escape to interrupt', () => {
    expect(classifyPrintRescue('!esc')).toBe('interrupt');
    expect(classifyPrintRescue('!escape')).toBe('interrupt');
    expect(classifyPrintRescue('  !ESC  ')).toBe('interrupt');
  });

  it('excludes !stop (print mode keeps its stop-session meaning) and !enter', () => {
    expect(classifyPrintRescue('!stop')).toBeNull();
    expect(classifyPrintRescue('!enter')).toBeNull();
  });

  it('ignores bare words, other text, and non-strings', () => {
    expect(classifyPrintRescue('esc')).toBeNull();
    expect(classifyPrintRescue('please !esc')).toBeNull();
    expect(classifyPrintRescue(null)).toBeNull();
    expect(classifyPrintRescue(42)).toBeNull();
  });
});

describe('dispatchJournalRescueKeystroke print path', () => {
  const mk = () => ({
    flushCursor: vi.fn(),
    sendRescueKeystroke: vi.fn(),
    sendPrintInterrupt: vi.fn(),
  });

  it('dispatches !esc to sendPrintInterrupt when print-active and not iv-active', async () => {
    const cb = mk();
    const handled = await dispatchJournalRescueKeystroke('!esc', false, { ...cb, printActive: true });
    expect(handled).toBe(true);
    expect(cb.flushCursor).toHaveBeenCalledTimes(1);
    expect(cb.sendPrintInterrupt).toHaveBeenCalledTimes(1);
    expect(cb.sendRescueKeystroke).not.toHaveBeenCalled();
  });

  it('does NOT treat !stop or !enter as a print interrupt', async () => {
    const cb = mk();
    expect(await dispatchJournalRescueKeystroke('!stop', false, { ...cb, printActive: true })).toBe(false);
    expect(await dispatchJournalRescueKeystroke('!enter', false, { ...cb, printActive: true })).toBe(false);
    expect(cb.sendPrintInterrupt).not.toHaveBeenCalled();
    expect(cb.flushCursor).not.toHaveBeenCalled();
  });

  it('iv-active takes precedence over the print path', async () => {
    const cb = mk();
    const handled = await dispatchJournalRescueKeystroke('!esc', true, { ...cb, printActive: true });
    expect(handled).toBe(true);
    expect(cb.sendRescueKeystroke).toHaveBeenCalledWith('esc');
    expect(cb.sendPrintInterrupt).not.toHaveBeenCalled();
  });

  it('returns false without printActive or without sendPrintInterrupt', async () => {
    const cb = mk();
    expect(await dispatchJournalRescueKeystroke('!esc', false, { ...cb })).toBe(false);
    expect(await dispatchJournalRescueKeystroke('!esc', false, { flushCursor: cb.flushCursor, sendRescueKeystroke: cb.sendRescueKeystroke, printActive: true })).toBe(false);
    expect(cb.flushCursor).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/command-dispatch.test.js`
Expected: FAIL — `classifyPrintRescue` is not exported

- [ ] **Step 3: Implement** — in `lib/command-dispatch.js`, add directly below `classifyRescueKeystroke`:

```js
// Print-mode rescue: only !esc/!escape map to a turn interrupt. Deliberately
// narrower than classifyRescueKeystroke — in print mode `!stop` must keep
// its documented meaning (stop the session; the command dispatcher handles
// it before this runs on the Matrix path) and `!enter` has no input box to
// nudge, so both fall through as ordinary input.
export function classifyPrintRescue(text) {
  if (typeof text !== 'string') return null;
  const lower = text.trim().toLowerCase();
  if (lower === '!esc' || lower === '!escape') return 'interrupt';
  return null;
}
```

and replace the body of `dispatchJournalRescueKeystroke` with:

```js
export async function dispatchJournalRescueKeystroke(text, ivActive, { flushCursor, sendRescueKeystroke, printActive = false, sendPrintInterrupt = null }) {
  if (ivActive) {
    const rescue = classifyRescueKeystroke(text);
    if (!rescue) return false;
    flushCursor();
    await sendRescueKeystroke(rescue);
    return true;
  }
  // Print-mode counterpart: same position in the routing order, narrower
  // word set (classifyPrintRescue), interrupt via control_request instead
  // of a PTY keystroke. Both callbacks optional so iv-only callers are
  // unaffected.
  if (printActive && sendPrintInterrupt && classifyPrintRescue(text)) {
    flushCursor();
    await sendPrintInterrupt();
    return true;
  }
  return false;
}
```

(Preserve the existing JSDoc/comment above the function if present.)

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run test/command-dispatch.test.js`
Expected: PASS (all existing + new tests)

- [ ] **Step 5: Commit**

```bash
git add lib/command-dispatch.js test/command-dispatch.test.js
git commit -m "feat: classifyPrintRescue + print path in journal rescue dispatch"
```

---

### Task 3: index.js wiring (both transports, timer lifecycle, help)

**Files:**
- Modify: `index.js` only.

**Interfaces:**
- Consumes: `sendPrintInterrupt` (Task 1), `classifyPrintRescue` + extended `dispatchJournalRescueKeystroke` (Task 2).
- Produces: `printModeInterrupt(session, sendReply)` and `clearPendingInterrupt(session)`; `session.pendingInterrupt` (handle or null).

index.js has no unit harness (established in this repo); correctness here is anchored by `npm run check`, the full suite, and exact anchor-based edits below. Read each anchor region before editing.

- [ ] **Step 1: Imports** — extend the existing `./lib/command-dispatch.js` import block (index.js ~line 36) with `classifyPrintRescue,` (alphabetical placement beside `classifyRescueKeystroke`), and add below the block:

```js
import { sendPrintInterrupt } from './lib/print-interrupt.js';
```

- [ ] **Step 2: Shared helper** — add immediately ABOVE `function killSession(...)` (~line 6368):

```js
// Print-mode turn interrupt — the print-mode counterpart of iv-mode's Esc
// keystroke rescue, shared verbatim by the Matrix handler and the journal
// session-text route (same convention as approvePlanBuild). The turn's
// `result` event is the success signal: it clears busy and cancels the
// fallback timer via clearPendingInterrupt. The timer only fires if the CLI
// never delivers one (wedged process), so the bridge stops queueing
// messages behind a busy flag nothing will ever clear.
async function printModeInterrupt(session, sendReply) {
  if (!session.proc || !session.alive) {
    await sendReply('No claude process to interrupt.');
    return;
  }
  if (!session.busy) {
    await sendReply('Nothing to interrupt — claude is idle.');
    return;
  }
  if (session.pendingInterrupt) {
    await sendReply('Interrupt already sent — still waiting for claude to stop this turn.');
    return;
  }
  session.pendingInterrupt = sendPrintInterrupt({
    stdin: session.proc.stdin,
    onWedge: () => {
      session.pendingInterrupt = null;
      if (!session.busy) return;
      session.busy = false;
      if (session.typingInterval) {
        clearInterval(session.typingInterval);
        session.typingInterval = null;
        client.setTyping(session.roomId, false, 1000).catch(() => {});
      }
      journalSessionState(session, 'waiting');
      journalActivity(session, 'idle');
      Promise.resolve(sendReply('⚠️ No response to the interrupt after 10s — cleared busy state. The turn may still be running; !stop kills the session if it stays stuck.')).catch(() => {});
    },
    onError: (err) => {
      Promise.resolve(sendReply(`Could not send interrupt: ${err.message}`)).catch(() => {});
    },
  });
  if (session.pendingInterrupt) {
    await sendReply('⏹ Interrupt sent — waiting for claude to stop this turn.');
  }
}

// Cancels a pending interrupt's wedge timer. Called wherever busy state
// resolves for real (result event, fatal-error result path, killSession) —
// a stale timer firing into a later turn would falsely clear its busy flag.
function clearPendingInterrupt(session) {
  if (session.pendingInterrupt) {
    session.pendingInterrupt.cancel();
    session.pendingInterrupt = null;
  }
}
```

- [ ] **Step 3: Timer lifecycle** — three call sites:
  1. In `case 'result':`, normal turn-end path: directly after `session.busy = false;` (the line above the `// Print-mode's turn-end …` comment, ~line 2383) add `clearPendingInterrupt(session);`
  2. In `case 'result':`, fatal-error path (the `no conversation found` block, ~line 2326): directly after its `session.busy = false;` add `clearPendingInterrupt(session);`
  3. In `killSession` (~line 6368): directly after `sweepToolStreams(session);` add `clearPendingInterrupt(session);`

- [ ] **Step 4: Matrix seam** — the iv rescue block (~line 5548) reads `if (session.iv && session.iv.alive) { … }`. Append to its closing brace:

```js
  else if (classifyPrintRescue(text)) {
    // Print-mode counterpart: cancel the current turn via a control_request
    // on the CLI's stdin. Runs before busy-queueing for the same reason the
    // iv branch does — interrupting is exactly what you need while busy.
    // !stop deliberately keeps its stop-session meaning here (handled by the
    // command dispatch above); !enter stays iv-only.
    await printModeInterrupt(session, sendReply);
    return;
  }
```

- [ ] **Step 5: Journal seam** — extend the `dispatchJournalRescueKeystroke` call (~line 4790) with the two new options (keep existing ones untouched):

```js
    printActive: !!(session.proc && session.alive && !(session.iv && session.iv.alive)),
    sendPrintInterrupt: async () => {
      const ctx = journalSessionCommandCtx(session);
      await printModeInterrupt(session, (m) => ctx.sendReply(m));
    },
```

Also update the comment above the call: it currently describes "iv-mode PTY rescue keystrokes"; append one sentence: `Print-mode sessions route !esc/!escape to printModeInterrupt via the printActive branch instead.`

- [ ] **Step 6: Help text** — in the `case '!help':` block, directly after the plain-text line `` `  Send "interrupt" to force interrupt\n\n` `` add:

```js
        `  !esc — cancel claude's current turn without killing the session\n\n` +
```

(adjusting the previous line's trailing `\n\n` to `\n` so spacing stays single between the two lines), and in the HTML variant directly after `` `<li>Send <code>interrupt</code> to force interrupt</li>` `` add:

```js
        `<li><code>!esc</code> — cancel claude's current turn without killing the session</li>` +
```

- [ ] **Step 7: Verify**

Run: `npm run check` — expected exit 0.
Run: `npx vitest run test/print-interrupt.test.js test/command-dispatch.test.js` — expected PASS.
Run: `npm run ci` — expected: lint clean, full suite green (pre-existing skips OK), audit clean.

- [ ] **Step 8: Commit**

```bash
git add index.js
git commit -m "feat: !esc cancels print-mode turns via control_request interrupt"
```
