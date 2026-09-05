# Print-mode Model Switching + On-demand Mode Toggle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a non-interactive (`claude -p`) room change model via `/model <alias>` without switching modes, and add a `/mode` command that flips a single room between interactive and non-interactive on demand — both persisting per room.

**Architecture:** Both features are the operation `!restart` already performs — tear down a room's Claude process and re-spawn it resuming the same session ID with a different launch parameter. We extract the pure decision logic into `lib/` (unit-tested), make `createSession`'s mode and model per-room overridable, add a shared `recreateSession()` helper in `index.js`, and wire two commands plus their buttons on top.

**Tech Stack:** Node.js (ESM), `vitest` for tests, `node-pty` (interactive spawns), `child_process.spawn` (print spawns). No new dependencies.

## Global Constraints

- **Never post secrets in chat.** Not relevant to this feature (no secret values handled), but the rule stands.
- **Model aliases** are validated only through `lib/model-aliases.js` (`isValidModelArg`, `normalizeModelArg`, `aliasLabel`, `VALID_ALIAS_HINT`). Never hand-roll alias validation.
- **Global default mode** stays `MATRON_INTERACTIVE_MODE === '1'` (`index.js:68`, constant `INTERACTIVE_MODE`). Per-room overrides layer on top; they never change the global.
- **Test runner:** `npm test` runs `vitest run`. Lint: `npx eslint index.js lib/`.
- **Same session ID is preserved** across every switch (resume), so conversation history is never lost.
- **Never kill an in-flight turn:** if `session.busy`, refuse the switch.

---

## File Structure

- **`lib/session-mode.js`** (new) — pure, side-effect-free helpers: mode/model precedence resolution, `/mode` argument parsing, mode labels, the toggle button, and the `planModeSwitch` decision. Unit-tested in isolation.
- **`test/session-mode.test.js`** (new) — tests for the above.
- **`lib/model-command.js`** (modify) — add `planPrintModelSwitch(session, arg)`, the print-mode counterpart to `switchModelInSession`. Pure decision; the caller performs the restart.
- **`test/model-command.test.js`** (modify) — tests for `planPrintModelSwitch`.
- **`index.js`** (modify) — per-room resolution in `createSession` / `createInteractiveSessionForRoom`; new `recreateSession()` helper; `!restart` refactored to use it; new `applyModelSwitch()` helper; `!model` print branch + `model:` button dispatch; new `!mode` command + `mode:` button dispatch; `bridgeCommandNames` and help text updated.

---

## Task 1: `lib/session-mode.js` — pure mode/model helpers

**Files:**
- Create: `lib/session-mode.js`
- Test: `test/session-mode.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `resolveInteractive({ option, persisted, fallback }) -> boolean`
  - `resolveModel({ option, persisted }) -> string | undefined`
  - `normalizeModeArg(arg) -> 'interactive' | 'print' | null`
  - `modeLabel(interactive: boolean) -> string`
  - `modeButtons(currentInteractive: boolean) -> [{ id, label, value }]` (one toggle button; value `mode:interactive` or `mode:print`)
  - `planModeSwitch(session, wantInteractive: boolean) -> { ok, noop?, message }`

- [ ] **Step 1: Write the failing test**

Create `test/session-mode.test.js`:

```javascript
import { describe, it, expect } from 'vitest';
import {
  resolveInteractive,
  resolveModel,
  normalizeModeArg,
  modeLabel,
  modeButtons,
  planModeSwitch,
} from '../lib/session-mode.js';

describe('resolveInteractive', () => {
  it('prefers an explicit boolean option over everything', () => {
    expect(resolveInteractive({ option: true, persisted: false, fallback: false })).toBe(true);
    expect(resolveInteractive({ option: false, persisted: true, fallback: true })).toBe(false);
  });
  it('falls back to the persisted value when no option', () => {
    expect(resolveInteractive({ option: undefined, persisted: true, fallback: false })).toBe(true);
    expect(resolveInteractive({ option: undefined, persisted: false, fallback: true })).toBe(false);
  });
  it('falls back to the global default when neither is set', () => {
    expect(resolveInteractive({ option: undefined, persisted: undefined, fallback: true })).toBe(true);
    expect(resolveInteractive({ option: undefined, persisted: undefined, fallback: false })).toBe(false);
  });
});

describe('resolveModel', () => {
  it('prefers the explicit option, then persisted, then undefined', () => {
    expect(resolveModel({ option: 'sonnet', persisted: 'opus' })).toBe('sonnet');
    expect(resolveModel({ option: undefined, persisted: 'opus' })).toBe('opus');
    expect(resolveModel({ option: undefined, persisted: undefined })).toBeUndefined();
  });
});

describe('normalizeModeArg', () => {
  it('maps interactive aliases', () => {
    for (const a of ['interactive', 'iv', 'tui', 'INTERACTIVE', ' iv ']) {
      expect(normalizeModeArg(a)).toBe('interactive');
    }
  });
  it('maps print aliases', () => {
    for (const a of ['print', 'noniv', 'non-interactive', 'p']) {
      expect(normalizeModeArg(a)).toBe('print');
    }
  });
  it('returns null for anything else', () => {
    expect(normalizeModeArg('banana')).toBeNull();
    expect(normalizeModeArg('')).toBeNull();
    expect(normalizeModeArg(undefined)).toBeNull();
  });
});

describe('modeLabel', () => {
  it('labels both modes', () => {
    expect(modeLabel(true)).toBe('interactive');
    expect(modeLabel(false)).toBe('non-interactive');
  });
});

describe('modeButtons', () => {
  it('offers a single button that flips to the other mode', () => {
    expect(modeButtons(false)).toEqual([
      { id: 'mode-interactive', label: 'Switch to interactive', value: 'mode:interactive' },
    ]);
    expect(modeButtons(true)).toEqual([
      { id: 'mode-print', label: 'Switch to non-interactive', value: 'mode:print' },
    ]);
  });
});

describe('planModeSwitch', () => {
  it('no-ops when already in the requested mode', () => {
    const d = planModeSwitch({ iv: { alive: true } }, true);
    expect(d.ok).toBe(false);
    expect(d.noop).toBe(true);
    expect(d.message).toMatch(/already/i);
  });
  it('refuses while the session is busy', () => {
    const d = planModeSwitch({ iv: null, busy: true }, true);
    expect(d.ok).toBe(false);
    expect(d.message).toMatch(/turn/i);
  });
  it('refuses interactive->print while a TUI prompt is pending', () => {
    const d = planModeSwitch({ iv: { alive: true }, pendingInteractivePrompt: {} }, false);
    expect(d.ok).toBe(false);
    expect(d.message).toMatch(/question/i);
  });
  it('approves a clean switch', () => {
    const d = planModeSwitch({ iv: null, busy: false }, true);
    expect(d.ok).toBe(true);
    expect(d.message).toMatch(/interactive/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- session-mode`
Expected: FAIL — `Failed to resolve import "../lib/session-mode.js"`.

- [ ] **Step 3: Write minimal implementation**

Create `lib/session-mode.js`:

```javascript
// Pure per-room mode/model helpers. No side effects, no I/O — the caller in
// index.js performs the actual session restart. Kept in lib/ so the precedence
// and decision logic is unit-testable without spawning a claude process.

// Precedence: explicit call option -> persisted per-room value -> global default.
export function resolveInteractive({ option, persisted, fallback }) {
  if (typeof option === 'boolean') return option;
  if (typeof persisted === 'boolean') return persisted;
  return !!fallback;
}

// Precedence: explicit option -> persisted -> undefined (CLI default).
export function resolveModel({ option, persisted }) {
  return option ?? persisted ?? undefined;
}

const INTERACTIVE_WORDS = new Set(['interactive', 'iv', 'tui', 'on']);
const PRINT_WORDS = new Set(['print', 'noniv', 'non-interactive', 'p', 'off']);

// Parse a /mode argument to a canonical target, or null if unrecognized.
export function normalizeModeArg(arg) {
  const a = String(arg ?? '').trim().toLowerCase();
  if (INTERACTIVE_WORDS.has(a)) return 'interactive';
  if (PRINT_WORDS.has(a)) return 'print';
  return null;
}

export function modeLabel(interactive) {
  return interactive ? 'interactive' : 'non-interactive';
}

// A single button that flips to the opposite of the current mode. Value is
// namespaced `mode:<target>` so the button-response handler can dispatch it.
export function modeButtons(currentInteractive) {
  const target = currentInteractive ? 'print' : 'interactive';
  const label = currentInteractive ? 'Switch to non-interactive' : 'Switch to interactive';
  return [{ id: `mode-${target}`, label, value: `mode:${target}` }];
}

// Decide whether a /mode switch can proceed. `session.iv` truthy means the room
// is currently interactive. Returns a decision the caller acts on.
export function planModeSwitch(session, wantInteractive) {
  const currentInteractive = !!session.iv;
  if (currentInteractive === wantInteractive) {
    return { ok: false, noop: true, message: `Already in ${modeLabel(wantInteractive)} mode.` };
  }
  if (session.busy) {
    return { ok: false, message: 'Finish or interrupt the current turn before switching modes.' };
  }
  if (currentInteractive && !wantInteractive && session.pendingInteractivePrompt) {
    return { ok: false, message: 'Answer the pending question before switching to non-interactive mode.' };
  }
  return {
    ok: true,
    message: `Switching to ${modeLabel(wantInteractive)} mode — restarting (history preserved)…`,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- session-mode`
Expected: PASS (all cases green).

- [ ] **Step 5: Commit**

```bash
git add lib/session-mode.js test/session-mode.test.js
git commit -m "feat(session-mode): pure per-room mode/model resolution helpers"
```

---

## Task 2: `planPrintModelSwitch` in `lib/model-command.js`

**Files:**
- Modify: `lib/model-command.js`
- Test: `test/model-command.test.js`

**Interfaces:**
- Consumes: `isValidModelArg`, `normalizeModelArg`, `aliasLabel`, `VALID_ALIAS_HINT` (already imported in the file).
- Produces: `planPrintModelSwitch(session, arg) -> { ok, normalized?, message }`.

- [ ] **Step 1: Write the failing test**

Append to `test/model-command.test.js` (add `planPrintModelSwitch` to the import on line 2):

```javascript
import { switchModelInSession, modelButtons, planPrintModelSwitch } from '../lib/model-command.js';

// ... existing tests unchanged ...

describe('planPrintModelSwitch', () => {
  it('approves a valid alias and returns the normalized value', () => {
    const d = planPrintModelSwitch({ busy: false }, '  SONNET ');
    expect(d.ok).toBe(true);
    expect(d.normalized).toBe('sonnet');
    expect(d.message).toMatch(/Sonnet/);
  });
  it('rejects an unknown alias', () => {
    const d = planPrintModelSwitch({ busy: false }, 'banana');
    expect(d.ok).toBe(false);
    expect(d.message).toMatch(/Unknown model/);
  });
  it('refuses while the session is busy', () => {
    const d = planPrintModelSwitch({ busy: true }, 'sonnet');
    expect(d.ok).toBe(false);
    expect(d.message).toMatch(/turn/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- model-command`
Expected: FAIL — `planPrintModelSwitch is not a function` (or import undefined).

- [ ] **Step 3: Write minimal implementation**

Add to `lib/model-command.js` (after `switchModelInSession`, before `modelButtons`):

```javascript
// Decide whether a print-mode /model switch can proceed. Unlike
// switchModelInSession (which types into a live TUI), print mode has no TUI —
// the caller restarts the `claude -p` process with `--model <alias> --resume`.
// This helper only validates and gates on busy; it performs no I/O.
export function planPrintModelSwitch(session, arg) {
  if (!isValidModelArg(arg)) {
    return { ok: false, message: `Unknown model "${arg}". Try: ${VALID_ALIAS_HINT} (or a full claude-* name).` };
  }
  if (session.busy) {
    return { ok: false, message: 'Finish or interrupt the current turn before switching models.' };
  }
  const normalized = normalizeModelArg(arg);
  return {
    ok: true,
    normalized,
    message: `Switching to ${aliasLabel(arg)} — restarting to apply (history preserved)…`,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- model-command`
Expected: PASS (existing + new cases green).

- [ ] **Step 5: Commit**

```bash
git add lib/model-command.js test/model-command.test.js
git commit -m "feat(model-command): planPrintModelSwitch decision for print mode"
```

---

## Task 3: Per-room mode/model resolution in `createSession`

**Files:**
- Modify: `index.js` (imports near line 20; `createSession` at 280–329; `createInteractiveSessionForRoom` at 505–552)

**Interfaces:**
- Consumes: `resolveInteractive`, `resolveModel` (Task 1).
- Produces: `createSession(roomId, workdir, resumeSessionId, options)` now honors `options.interactive` (boolean) and `options.model` (string); interactive spawns honor `options.model` too.

This task wires resolution into the process-spawning code. `createSession` spawns a real `claude` process, so there is no isolated unit test — verification is: the Task 1 resolver tests (precedence), lint, and the full existing suite still passing. Verify carefully by reading the diff.

- [ ] **Step 1: Add the import**

At the top of `index.js`, next to the existing `import { switchModelInSession, modelButtons } from './lib/model-command.js';` (line 20), add:

```javascript
import { resolveInteractive, resolveModel } from './lib/session-mode.js';
```

- [ ] **Step 2: Resolve the mode in `createSession`**

Replace the head of `createSession` (currently lines 280–283):

```javascript
function createSession(roomId, workdir, resumeSessionId, options = {}) {
  if (INTERACTIVE_MODE) {
    return createInteractiveSessionForRoom(roomId, workdir, resumeSessionId, options);
  }
```

with:

```javascript
function createSession(roomId, workdir, resumeSessionId, options = {}) {
  const persistedMode = getPersistedSession(roomId);
  const interactive = resolveInteractive({
    option: options.interactive,
    persisted: persistedMode?.interactiveMode,
    fallback: INTERACTIVE_MODE,
  });
  if (interactive) {
    return createInteractiveSessionForRoom(roomId, workdir, resumeSessionId, options);
  }
```

- [ ] **Step 3: Add `--model` to the print args**

In `createSession`, immediately after the `args` array literal closes and before the `if (resumeSessionId)` block (currently line 327), insert the model resolution and arg push:

```javascript
  const printModel = resolveModel({ option: options.model, persisted: persistedMode?.model });
  if (printModel) {
    args.push('--model', printModel);
  }
  if (resumeSessionId) {
    args.push('--resume', resumeSessionId);
  }
```

(The existing `if (resumeSessionId)` block is folded in above — do not leave a duplicate.)

- [ ] **Step 4: Add `--model` to the interactive spawn**

In `createInteractiveSessionForRoom`, after `const sessionId = resumeSessionId || randomUUID();` (line 512), add:

```javascript
  const model = resolveModel({ option: options.model, persisted: persistedForRoom?.model });
```

Then after the `claudeArgs.push(...)` call that ends at line 552, append:

```javascript
  if (model) {
    claudeArgs.push('--model', model);
  }
```

(`persistedForRoom` is already defined at line 507.)

- [ ] **Step 5: Verify lint and the full suite still pass**

Run: `npx eslint index.js lib/`
Expected: no errors.

Run: `npm test`
Expected: all suites pass (no regressions; new Task 1/2 suites green).

- [ ] **Step 6: Manual smoke — model applied in print mode**

With the bridge in print mode (`MATRON_INTERACTIVE_MODE` unset), confirm the arg is built by adding a temporary debug or inspecting logs is optional; the authoritative check is a quick REPL:

```bash
node -e "import('./lib/session-mode.js').then(m => { console.log(m.resolveModel({option:'sonnet',persisted:undefined})); console.log(m.resolveInteractive({option:undefined,persisted:true,fallback:false})); })"
```
Expected output:
```
sonnet
true
```

- [ ] **Step 7: Commit**

```bash
git add index.js
git commit -m "feat(bridge): per-room mode/model resolution in createSession"
```

---

## Task 4: `recreateSession()` helper + refactor `!restart`

**Files:**
- Modify: `index.js` (add helper near `killSession` at 4883; refactor `!restart` handler at 3105–3144)

**Interfaces:**
- Consumes: `createSession`, `killSession`, `persistSession`, `sendButtonMessage`, module `sessions` map.
- Produces: `recreateSession(roomId, overrides, { sendReply, sendHtml }) -> session | null`. Tears down the room's live session and re-spawns it resuming the same session ID, merging `overrides` (`{ model, interactive, mcpExtras }`) into the `createSession` options and carrying live user-visible state across.

`recreateSession` calls the real `createSession` (which spawns), so verification is lint + the existing suite + a manual `!restart` smoke. Read the diff to confirm every carried field matches the crash-restart list at `index.js:448–459`.

- [ ] **Step 1: Add the helper**

Insert immediately before `function killSession(session, signal = 'SIGTERM') {` (line 4883):

```javascript
// Tear down a room's live session and re-spawn it resuming the SAME claude
// session id, applying `overrides` ({ model, interactive, mcpExtras }) to the
// new createSession options. Carries user-visible state (queue, per-room
// toggles, chat history) across the swap. Returns the new session, or null if
// the room has no live session. Shared by /restart, /model (print) and /mode.
function recreateSession(roomId, overrides, { sendReply, sendHtml }) {
  const existing = sessions.get(roomId);
  if (!existing) return null;
  const sessionId = existing.claudeSessionId;
  const workdir = existing.workdir;
  const originRoomId = existing.originRoomId;
  sessions.delete(roomId);
  killSession(existing);
  const next = createSession(roomId, workdir, sessionId, {
    mcpExtras: existing.mcpExtras,
    ...overrides,
  });
  next.sendCallback = sendReply;
  next.sendHtml = sendHtml;
  next.sendButtonMessage = (prompt, buttons, mode, plainText, html) =>
    sendButtonMessage(roomId, prompt, buttons, mode, plainText, html);
  next.originRoomId = originRoomId;
  next.firstMessageCaptured = existing.firstMessageCaptured;
  next.queuedMessages = existing.queuedMessages;
  next.queueNotifications = existing.queueNotifications;
  next.showWorking = existing.showWorking;
  next.showBashOutput = existing.showBashOutput;
  next.chatHistory = existing.chatHistory;
  next.pinnedSummaryText = existing.pinnedSummaryText;
  next.pinnedSummaryEventId = existing.pinnedSummaryEventId;
  if (sessionId) {
    persistSession(roomId, sessionId, workdir, originRoomId);
  }
  return next;
}
```

- [ ] **Step 2: Refactor `!restart` to use it**

Replace the body of the `!restart` case (lines 3116–3142, from `const { extras: restartFlagExtras }` through the final `await sendReply(...)`) with:

```javascript
      const { extras: restartFlagExtras } = extractMcpExtraFlags(parts.slice(1));
      const carriedExtras = Array.isArray(existing.mcpExtras) ? existing.mcpExtras : null;
      const effectiveRestartExtras = restartFlagExtras.length > 0
        ? restartFlagExtras
        : (carriedExtras || []);
      const restartSessionId = existing.claudeSessionId;
      const restartWorkdir = existing.workdir;
      await sendReply('🔄 Restarting session...');
      recreateSession(roomId, { mcpExtras: effectiveRestartExtras }, { sendReply, sendHtml });
      const extrasLine = effectiveRestartExtras.length > 0
        ? `\nExtras: ${effectiveRestartExtras.join(', ')}`
        : '';
      await sendReply(
        `Session restarted.\nSession: ${restartSessionId ? restartSessionId.slice(0, 8) + '...' : '(new)'}\nWorkdir: ${restartWorkdir}${extrasLine}`
      );
```

Note: `recreateSession` now performs the `sessions.delete` + `killSession` + `createSession` + rewire + persist that the old handler did inline. The `existing`/no-active-session guard at the top of the case (lines 3106–3110) stays.

- [ ] **Step 3: Verify lint and the suite**

Run: `npx eslint index.js lib/`
Expected: no errors (watch for an unused-var warning on any leftover from the old block — remove if flagged).

Run: `npm test`
Expected: all pass.

- [ ] **Step 4: Manual smoke — /restart still works**

In a live bridge room: send a message, then `/restart`. Expected: "🔄 Restarting session..." then "Session restarted." with the same 8-char session id, and the conversation continues on the next message.

- [ ] **Step 5: Commit**

```bash
git add index.js
git commit -m "refactor(bridge): extract recreateSession, use it for /restart"
```

---

## Task 5: `/model <alias>` in print mode (command + button)

**Files:**
- Modify: `index.js` (imports at 20; add `applyModelSwitch` helper; `!model` handler at 3583–3616; `model:` button dispatch at 3968–3972)

**Interfaces:**
- Consumes: `planPrintModelSwitch` (Task 2), `recreateSession` (Task 4), `switchModelInSession`, `persistSession`.
- Produces: `applyModelSwitch(roomId, session, arg, { sendReply, sendHtml }) -> void`. Routes interactive sessions to the typed `/model`, print sessions to a restart-with-`--model`.

- [ ] **Step 1: Extend the model-command import**

Change line 20 from:

```javascript
import { switchModelInSession, modelButtons } from './lib/model-command.js';
```

to:

```javascript
import { switchModelInSession, modelButtons, planPrintModelSwitch } from './lib/model-command.js';
```

- [ ] **Step 2: Add the `applyModelSwitch` helper**

Insert `applyModelSwitch` immediately above the `recreateSession` function added in Task 4 (both are module-level helpers near line 4883):

```javascript
// Apply a /model switch for either mode. Interactive sessions type /model into
// the live TUI (immediate); print sessions restart the claude -p process with
// --model <alias> --resume (history preserved). Used by the !model command and
// the model: picker button.
function applyModelSwitch(roomId, session, arg, { sendReply, sendHtml }) {
  if (session.iv) {
    switchModelInSession(session, arg, sendReply);
    return;
  }
  const decision = planPrintModelSwitch(session, arg);
  if (!decision.ok) {
    sendReply(decision.message);
    return;
  }
  sendReply(decision.message);
  persistSession(roomId, session.claudeSessionId, session.workdir, session.originRoomId, { model: decision.normalized });
  const next = recreateSession(roomId, { model: decision.normalized }, { sendReply, sendHtml });
  if (next) next.currentModel = decision.normalized;
}
```

- [ ] **Step 3: Route the `!model <arg>` command through it**

In the `!model` case, replace the `if (arg) { switchModelInSession(session, arg, sendReply); break; }` block (lines 3590–3593) with:

```javascript
      if (arg) {
        applyModelSwitch(roomId, session, arg, { sendReply, sendHtml });
        break;
      }
```

- [ ] **Step 4: Update the no-arg print-mode display**

In the same `!model` case, replace the final `else` branch that currently reads (line 3613–3615):

```javascript
      } else {
        await sendReply(`${currentLine}${extra}\n\nSwitching models needs interactive mode.`);
      }
```

with a print-mode-capable version that offers the picker buttons (which now work in print mode via Step 5):

```javascript
      } else if (session.sendButtonMessage) {
        const buttons = modelButtons();
        const plain = `${currentLine}${extra}\n\nTap a model to switch (restarts to apply), or type /model <name>.`;
        const htmlButtons = buttons.map(b => `<b>${escapeHtml(b.label)}</b>`).join(' · ');
        const html = `<b>🧠 ${escapeHtml(currentLine)}</b>${extra ? '<br/>' + escapeHtml(extra.trim()).replace(/\n/g, '<br/>') : ''}` +
          `<br/><br/>Tap a model to switch (restarts to apply), or type <code>/model &lt;name&gt;</code>.<br/>${htmlButtons}`;
        session.sendButtonMessage(currentLine, buttons, 'pick_one', plain, html);
      } else {
        await sendReply(`${currentLine}${extra}\n\nType /model <name> to switch (restarts to apply). Options: ${VALID_ALIAS_HINT}.`);
      }
```

- [ ] **Step 5: Route the `model:` button through it**

Replace the model-button dispatch block (lines 3967–3972):

```javascript
    // Model picker button (no-arg /model) — value is `model:<alias>`.
    const modelMatch = value.match(/^model:(.+)$/);
    if (modelMatch) {
      switchModelInSession(session, modelMatch[1], sendReply);
      return;
    }
```

with:

```javascript
    // Model picker button (no-arg /model) — value is `model:<alias>`.
    const modelMatch = value.match(/^model:(.+)$/);
    if (modelMatch) {
      applyModelSwitch(roomId, session, modelMatch[1], { sendReply, sendHtml: sendHtmlFn });
      return;
    }
```

(In the message handler that owns this block, the HTML callback is named `sendHtmlFn` — confirm the local name by reading the enclosing function; it is defined as `const sendHtmlFn = (plainText, html) => sendToRoom(roomId, plainText, html);`.)

- [ ] **Step 6: Verify lint and the suite**

Run: `npx eslint index.js lib/`
Expected: no errors.

Run: `npm test`
Expected: all pass.

- [ ] **Step 7: Manual smoke — /model in print mode**

Bridge in print mode. In a room: `/model sonnet`. Expected: "Switching to Sonnet — restarting to apply (history preserved)…", the session restarts on the same id, and the next reply runs on Sonnet (`/model` with no arg shows the new current model). Then `/model` (no arg) shows the model + tappable buttons; tap one and confirm the same restart flow.

- [ ] **Step 8: Commit**

```bash
git add index.js
git commit -m "feat(bridge): /model switches model in print mode via restart"
```

---

## Task 6: `/mode` command + button + help

**Files:**
- Modify: `index.js` (imports at 20; `bridgeCommandNames` at 3801–3805; add `!mode` case; add `mode:` button dispatch; help text at 3478 and 3513–3514)

**Interfaces:**
- Consumes: `normalizeModeArg`, `modeLabel`, `modeButtons`, `planModeSwitch` (Task 1), `recreateSession` (Task 4), `persistSession`, `escapeHtml`.
- Produces: the `/mode` command and its `mode:` button.

- [ ] **Step 1: Extend the session-mode import**

Change the Task-3 import line to also bring in the command helpers:

```javascript
import {
  resolveInteractive,
  resolveModel,
  normalizeModeArg,
  modeLabel,
  modeButtons,
  planModeSwitch,
} from './lib/session-mode.js';
```

- [ ] **Step 2: Allow `/mode` to normalize to `!mode`**

In `bridgeCommandNames` (lines 3801–3805) add `'mode'`:

```javascript
    const bridgeCommandNames = new Set([
      'start', 'stop', 'restart', 'resume', 'workdir', 'status',
      'show', 'show_working', 'working', 'sessions', 'help',
      'mcp', 'model', 'mode', 'effort', 'cost', 'usage', 'tools',
    ]);
```

- [ ] **Step 3: Add the `!mode` case**

Insert a new case immediately after the `!model` case closes (after its `break;` near line 3617), before `case '!effort':`:

```javascript
    case '!mode': {
      const session = sessions.get(roomId);
      if (!session || !session.alive) {
        await sendReply('No active session. Start a session first.');
        break;
      }
      const currentInteractive = !!session.iv;
      const arg = parts[1];
      if (!arg) {
        const line = `Mode: ${modeLabel(currentInteractive)}`;
        if (session.sendButtonMessage) {
          const buttons = modeButtons(currentInteractive);
          const plain = `${line}\n\nTap to switch, or type /mode interactive | /mode print.`;
          const htmlButtons = buttons.map(b => `<b>${escapeHtml(b.label)}</b>`).join(' · ');
          const html = `<b>🔀 ${escapeHtml(line)}</b><br/><br/>Tap to switch, or type <code>/mode interactive</code> | <code>/mode print</code>.<br/>${htmlButtons}`;
          session.sendButtonMessage(line, buttons, 'pick_one', plain, html);
        } else {
          await sendReply(`${line}\n\nType /mode interactive or /mode print to switch.`);
        }
        break;
      }
      const target = normalizeModeArg(arg);
      if (!target) {
        await sendReply('Usage: /mode interactive | /mode print');
        break;
      }
      const wantInteractive = target === 'interactive';
      const decision = planModeSwitch(session, wantInteractive);
      if (!decision.ok) {
        await sendReply(decision.message);
        break;
      }
      await sendReply(decision.message);
      persistSession(roomId, session.claudeSessionId, session.workdir, session.originRoomId, { interactiveMode: wantInteractive });
      recreateSession(roomId, { interactive: wantInteractive }, { sendReply, sendHtml });
      break;
    }
```

- [ ] **Step 4: Add the `mode:` button dispatch**

In the button-response block, immediately after the `model:` dispatch added in Task 5 (before the `effort:` block at line 3974), insert the following. This handler already has a `let session = sessions.get(roomId);` binding in scope (used by the `cancel:` block at line 3945), so **reuse it — do not re-declare `session`**:

```javascript
    // Mode toggle button — value is `mode:interactive` or `mode:print`.
    const modeMatch = value.match(/^mode:(interactive|print)$/);
    if (modeMatch) {
      if (!session || !session.alive) {
        sendReply('No active session. Start a session first.');
        return;
      }
      const wantInteractive = modeMatch[1] === 'interactive';
      const decision = planModeSwitch(session, wantInteractive);
      if (!decision.ok) {
        sendReply(decision.message);
        return;
      }
      sendReply(decision.message);
      persistSession(roomId, session.claudeSessionId, session.workdir, session.originRoomId, { interactiveMode: wantInteractive });
      recreateSession(roomId, { interactive: wantInteractive }, { sendReply, sendHtml: sendHtmlFn });
      return;
    }
```

- [ ] **Step 5: Add `/mode` to the help text**

In the plain-text help, after the `/effort [level] — ...` line (line 3479) add:

```javascript
        `/mode [interactive|print] — Show or switch interactive vs non-interactive\n` +
```

In the HTML help `Info` group (after the `/effort` entry at line 3514) add:

```javascript
          ['/mode [interactive|print]', 'Show or switch interactive vs non-interactive mode'],
```

- [ ] **Step 6: Verify lint and the suite**

Run: `npx eslint index.js lib/`
Expected: no errors (in particular, no `session` redeclaration error in the button block — Step 4 reuses the existing binding).

Run: `npm test`
Expected: all pass.

- [ ] **Step 7: Manual smoke — /mode round trip**

Bridge default print mode, in a room mid-conversation:
1. `/mode` → shows "Mode: non-interactive" + a "Switch to interactive" button.
2. `/mode interactive` → "Switching to interactive mode — restarting…"; same session id; next message runs through the PTY (interactive features like the in-TUI `/model` picker now available).
3. `/mode interactive` again → "Already in interactive mode."
4. `/mode print` → switches back; conversation intact.
5. Restart the bridge service; send a message in that room → it auto-resumes in the last chosen mode (persisted `interactiveMode`).

- [ ] **Step 8: Commit**

```bash
git add index.js
git commit -m "feat(bridge): /mode toggles interactive vs non-interactive per room"
```

---

## Self-Review

**Spec coverage:**
- Goal 1 (`/model` in print without mode switch) → Tasks 2 + 5.
- Goal 2 (`/mode` toggle) → Tasks 1 + 6.
- Goal 3 (persist per room, survive restart) → Task 3 resolution reads persisted values; Tasks 5/6 write them via `persistSession` `extra`; `{ ...existing }` in `persistSession` carries them across unrelated writes (verified — no `persistSession` edit needed). Task 6 Step 7.5 exercises the survive-restart path.
- Component 1 (per-room resolution) → Task 3.
- Component 2 (`recreateSession`) → Task 4.
- Component 3 (`/model` print) → Task 5.
- Component 4 (`/mode`) → Task 6.
- Component 5 (persistence) → satisfied without code change; documented in Task 3/Goal 3.
- Edge cases: busy → `planPrintModelSwitch` / `planModeSwitch` (Tasks 2, 1). Mid auto-resume → existing `switchModelInSession` `_awaitingInputReady` guard (interactive path, unchanged) + print restart only runs when not busy. Interactive→print pending prompt → `planModeSwitch` (Task 1). Invalid alias → `planPrintModelSwitch` (Task 2). No active session → each handler's guard (Tasks 5, 6). Already-in-mode → `planModeSwitch` noop (Task 1).

**Placeholder scan:** No TBD/TODO; every code step shows full code.

**Type consistency:** `resolveInteractive`/`resolveModel` object args match between Task 1 definition and Task 3 call sites. `recreateSession(roomId, overrides, { sendReply, sendHtml })` signature matches all callers (Tasks 4, 5, 6). `planModeSwitch` returns `{ ok, noop?, message }` consumed identically in Task 6 command + button. `planPrintModelSwitch` returns `{ ok, normalized?, message }` consumed in Task 5. Button values `mode:interactive|print` produced by `modeButtons` (Task 1) and matched by the dispatch regex (Task 6). `sendHtmlFn` is the correct local name in the button handler; `sendHtml` is the correct param name in `handleCommand`.
