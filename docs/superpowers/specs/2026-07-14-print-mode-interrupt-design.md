# Print-Mode Turn Interrupt (!esc) — Design

**Decision (2026-07-14):** `!esc` / `!escape` cancel the current turn for
print-mode sessions, from both transports (Matrix room text and the journal
session-text route), by writing a `control_request` / `interrupt` line to the
claude CLI's stream-json stdin. The process survives and accepts the next
turn. This closes the gap PR #55 diagnosed: rescue keystrokes are iv-only
today, so a print-mode session mid-turn cannot be cancelled at all — typing
`!esc` while busy just queues the literal text as a message to claude.

Verified against the installed CLI (claude 2.1.207, 2026-07-14) with a live
script: `{type:'control_request', request_id:<uuid>,
request:{subtype:'interrupt'}}` on stdin produced a `control_response`, ended
the in-flight turn with `result` (`is_error: true`, `subtype:
'error_during_execution'`), left the process alive, and a follow-up user turn
completed normally (`result/success`). The bridge's existing `case 'result':`
block therefore clears busy on a successful interrupt with no changes; the
`control_response` event falls into the parser's silent `default:` and the
synthetic interrupt `user` event only matches tool_result handling — neither
needs code.

## Command surface

- `!esc` and `!escape` **only**. `!stop` is deliberately excluded from the
  print-mode classifier even though iv-mode maps it to Esc: in print mode
  `!stop` has a documented meaning (stop the session) enforced by the command
  dispatcher, and shadowing it would remove the way to kill a stuck session.
  `!enter` stays iv-only (no input box to nudge in print mode).
- iv-mode behavior is untouched: the existing PTY Esc path takes precedence
  whenever `session.iv?.alive`.
- Busy-queue magic words (`send` / `interrupt` = flush, `cancel` = pop last)
  keep their meaning; this feature is reached via the rescue-keystroke seams,
  which run before busy-queueing on both transports.
- Not added to `MATRON_COMMANDS` discovery: entries there advertise
  `/`-dispatchable commands; `/esc` would not classify. Revisit only if a
  client wants an interrupt affordance (it can send the `!esc` text today).

## Components

### `lib/print-interrupt.js` (new)

- `buildInterruptRequest(requestId = randomUUID())` → the control_request
  object (pure).
- `sendPrintInterrupt({stdin, onWedge, onError, timeoutMs =
  INTERRUPT_FALLBACK_MS, setTimeoutFn, clearTimeoutFn})` → writes one
  newline-terminated JSON line and arms a fallback timer; returns
  `{requestId, cancel}` or `null` when the write throws (reported via
  `onError`, no timer armed). Never throws (fail-open, same stance as
  journal-publisher). `INTERRUPT_FALLBACK_MS = 10000`.
- Timer injection seams (`setTimeoutFn`/`clearTimeoutFn`) exist for tests.

### `lib/command-dispatch.js`

- New `classifyPrintRescue(text)` → `'interrupt'` for `!esc`/`!escape`
  (trimmed, case-insensitive), else `null`. Narrower than
  `classifyRescueKeystroke` by design (see Command surface).
- `dispatchJournalRescueKeystroke(text, ivActive, opts)` gains optional
  `opts.printActive` (default false) and `opts.sendPrintInterrupt` (default
  null): when not iv-active but print-active and the text classifies, it
  flushes the cursor, awaits `sendPrintInterrupt()`, and returns true.
  Existing iv behavior and call sites are unchanged (new keys are optional).

### `index.js`

- Shared `printModeInterrupt(session, sendReply)` — single implementation
  used verbatim by both transports (same convention as `approvePlanBuild`):
  - no live proc → "No claude process to interrupt."
  - not busy → "Nothing to interrupt — claude is idle."
  - interrupt already pending → say so, don't double-send.
  - else `sendPrintInterrupt(...)`, stash the handle on
    `session.pendingInterrupt`, reply "⏹ Interrupt sent — waiting for claude
    to stop this turn."
- **Wedge guard** (the busy-flag gap flagged on PR #55): if no `result`
  arrives within 10s, the timer clears busy state + typing indicator, sets
  journal session state `waiting` / activity `idle`, nulls
  `pendingInterrupt`, and notifies ("turn may still be running; !stop kills
  the session"). The timer no-ops if busy was already cleared.
- `clearPendingInterrupt(session)` cancels the timer; called from the
  `case 'result':` busy-clear paths (normal and fatal-error) and from
  `killSession` — a completed or dead session must never fire a stale wedge
  into a later turn.
- Matrix seam: `else if (classifyPrintRescue(text))` branch directly after
  the existing iv-rescue block → `printModeInterrupt(session, sendReply)`.
- Journal seam: the existing `dispatchJournalRescueKeystroke` call gains
  `printActive` + `sendPrintInterrupt` wired to the same
  `printModeInterrupt`.
- `!help` (plain + HTML) documents `!esc` — cancel claude's current turn
  without killing the session.

## Testing

- `test/print-interrupt.test.js` (new, vitest): request shape + unique ids;
  newline-terminated JSON written; wedge fires at `timeoutMs` (fake timers);
  `cancel()` prevents it; write throw → `onError`, `null` return, no timer.
- `test/command-dispatch.test.js`: `classifyPrintRescue` table
  (`!esc`/`!escape`/case/whitespace vs `!stop`/`!enter`/bare `esc`/non-string);
  journal dispatch print path (dispatches on `!esc`, ignores `!stop`,
  iv-active takes precedence, absent callbacks → false); existing iv cases
  unchanged.
- `index.js` wiring has no unit harness (established); covered by
  lint/`node --check`/full suite plus a manual end-to-end check against a
  real print-mode session after deploy.
- `lib/print-interrupt.js` joins the `check` script in package.json.

## Out of scope

- `!enter` for print mode; changes to busy-queue magic words; a Matron
  client interrupt button (client work; the text `!esc` already routes).
- iv-mode refactors. PR #55 gets closed in favor of this once merged.
