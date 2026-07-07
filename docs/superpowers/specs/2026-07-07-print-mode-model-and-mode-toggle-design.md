# Model switching in print mode + on-demand mode toggle

**Date:** 2026-07-07
**Status:** Approved for planning

## Problem

The bridge runs every room in a single process-wide mode, decided at startup by
`MATRON_INTERACTIVE_MODE` (`index.js:68`) and branched on in `createSession`
(`index.js:281`):

- **Interactive (PTY) mode** switches models by typing `/model <alias>` into the
  live TUI (`lib/model-command.js`).
- **Non-interactive (`claude -p`) mode** has no live TUI, so `switchModelInSession`
  (`lib/model-command.js:21`) and the `!model` handler
  (`index.js:3613`) refuse with *"Switching models needs interactive mode."*

Two gaps follow from this:

1. A non-interactive room cannot change model at all.
2. There is no way to move a single room between interactive and non-interactive
   mode without changing the global env var and restarting the whole bridge
   (which drops every room's session).

## Goals

1. `/model <alias>` works in a non-interactive room, **without** switching modes.
2. A `!mode` command toggles a single room between interactive and
   non-interactive on demand, preserving the conversation.
3. Both choices persist per room and survive bridge restarts / auto-resume.

## Non-goals

- Changing the global default mode mechanism (`MATRON_INTERACTIVE_MODE` stays the
  fallback default).
- Any change to how interactive mode switches model on a *live* TUI (still the
  typed `/model`).

## Key insight

Both features are the same operation `!restart` already performs (`index.js:3105`):
**tear down this room's Claude process and re-spawn it resuming the same session
ID, with a different launch parameter.** `claude -p` and interactive spawns both
support `--resume` and `--model` (confirmed via `claude --help`). Print mode
captures the model into `initData.model`, so the current-model display keeps
working after a restart.

So the work is: make `createSession`'s mode and model **per-room overridable**
instead of read from globals, extract the restart-and-resume logic into a shared
helper, and add the two commands on top.

## Design

### Component 1 — per-room resolution in `createSession`

Replace the hard `if (INTERACTIVE_MODE)` branch with resolved values. Precedence:
explicit call option → persisted per-room value → global default.

```js
const persisted = getPersistedSession(roomId);
const interactive = options.interactive ?? persisted?.interactiveMode ?? INTERACTIVE_MODE;
const model = options.model ?? persisted?.model ?? undefined;
```

- **Print path (`createSession`):** if `model` is set, push `'--model', model`
  into `args` (never passed today).
- **Interactive path (`createInteractiveSessionForRoom`):** if `model` is set,
  push `'--model', model` into `claudeArgs` too, so a persisted model survives
  interactive restarts. The in-TUI `/model` command still overrides the live
  session; `--model` only sets the starting model.

`options.model` / `options.interactive` are threaded through the existing
`createSession(roomId, workdir, resumeSessionId, options)` signature (same place
`options.mcpExtras` already lives).

### Component 2 — shared `recreateSession()` helper

Extract the body of the `!restart` handler into:

```js
function recreateSession(roomId, overrides, { sendReply, sendHtml, sendButtonMessage })
```

It captures `claudeSessionId` / `workdir` / `originRoomId` from the live session,
`killSession`s and deletes it, calls `createSession` with the merged overrides
(`{ mcpExtras, model, interactive, ... }`), re-wires callbacks, carries live
user-visible state across the swap (`queuedMessages`, `queueNotifications`,
`showWorking`, `showBashOutput`, `firstMessageCaptured`), and persists. Returns
the new session.

`!restart`, the print-mode `/model` path, and `!mode` all call it. `!restart` is
refactored to use it (removes the current duplication between the manual restart
and the crash-restart paths at `index.js:447` / `673`).

### Component 3 — `/model` in print mode

In the `!model <arg>` handler (`index.js:3583`):

1. `session.busy` → refuse ("finish or interrupt the current turn first").
2. mid auto-resume (`session._awaitingInputReady`) → refuse ("try again in a moment").
3. `session.iv` present → existing `switchModelInSession` (typed TUI path).
4. else (print mode) → validate the alias with `isValidModelArg`
   (`lib/model-aliases.js`), on invalid emit the existing `VALID_ALIAS_HINT`
   message; on valid: persist `model`, call `recreateSession({ model: normalized })`,
   set the new session's `currentModel`, reply
   *"Switched to <label> — restarted to apply (history preserved)."*

### Component 4 — `!mode` command

- **No arg** → show the current mode and a single toggle button. Button values
  `mode:interactive` / `mode:print`, dispatched in the button-response handler
  next to the existing `model:` dispatch (`index.js:3967`).
- **`!mode interactive` / `!mode print`** (accept `iv` / `print` aliases):
  - already in that mode → say so, no-op.
  - `session.busy` → refuse.
  - interactive → print while a TUI prompt is pending
    (`session.pendingInteractivePrompt`) → refuse (print mode can't carry an open
    AskUserQuestion).
  - else → persist `interactiveMode`, `recreateSession({ interactive: bool })`,
    reply with the new mode.

### Component 5 — persistence

Add `interactiveMode` (bool) and `model` (string) to the per-room persisted
record through the existing `persistSession(roomId, sessionId, workdir,
originRoomId, extra)` `extra` param (`index.js:249`). Auto-carry both from the
live session (like `mcpExtras` at `index.js:258`) so unrelated `persistSession`
calls don't clobber them.

## Edge cases

| Case | Behavior |
|------|----------|
| Session busy (mid-turn) | Refuse `/model` and `!mode` — never kill an in-flight turn |
| Mid auto-resume (`_awaitingInputReady`) | Refuse, "try again in a moment" |
| Interactive→print with a pending TUI prompt | Refuse |
| Same session ID resumed | Conversation history intact across both switches |
| Invalid model alias | Existing `VALID_ALIAS_HINT` message |
| `!model`/`!mode` with no active session | Existing "No active session" reply |
| Toggle to the mode already active | No-op with a note |

## Testing

Unit tests in the `test/` node:test style:

- **Resolution precedence** — `option → persisted → global` for both mode and
  model (extract the resolver so it is testable without spawning).
- **`recreateSession` carries state** — mock `createSession`; assert
  `queuedMessages` / `showWorking` / `showBashOutput` / callbacks / persisted
  fields survive.
- **`/model` print branch** — mock; asserts a restart with `--model <alias>` and
  no PTY typing; busy/invalid-alias refusals.
- **`!mode` dispatch + button** — arg parsing, `mode:` button value dispatch,
  busy / pending-prompt / already-in-mode refusals.
- **Persistence round-trip** — `interactiveMode` and `model` persist and are
  auto-carried across unrelated `persistSession` writes.

## Rollout

Pure additive change to command handling plus a launch-arg tweak; the global
`MATRON_INTERACTIVE_MODE` default is unchanged, so existing deployments behave
identically until a room uses `!model`/`!mode`.
