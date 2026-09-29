# Coordinator session control: context size, /model, /compact, carry on

**Date:** 2026-09-29
**Status:** Draft — design questions filed for Dan on mission #4644; nothing built yet
**Depends on:** 2026-07-15 agent RPC design (journal-originated requests), 2026-08-09 agent spawns design (the `spawn_request` relay shape), 2026-09-23 Coordinator redesign, 2026-06-10 `/model` design, 2026-08-06 compact/queue design

## Problem

Dan (voice notes, 29 Sep): the Coordinator should be able to manage the
health of the user's other agent sessions —

1. **see each session's context size**: tokens in use against the window,
   and the model;
2. **switch a session's model**, the way `/model <alias>` does in that chat;
3. **compact a session** (`/compact`), at its next idle point, never mid-turn;
4. **tell a session to carry on** when it has stalled on a usage limit, and
   again once that limit has reset.

Today the Coordinator can only see `session_state` (running / waiting / done)
per conversation and a box's account limits, and its only lever on another
session is an agent chat room, which costs the target's context and does
nothing for a stalled session.

## What already exists (verified 2026-09-29)

**Context and model are already measured, per conversation.** Every Claude
session tracks `session.currentModel` (from each assistant record's
`message.model`) and `session._lastContextTokens` (input + cache-read +
cache-create tokens of the last request, `lib/session-status.js`
`contextTokensFromAssistantEvent`). Codex sessions get `_lastContextTokens`
and the real `_codexContextWindow` from `thread/tokenUsage/updated`.
`journalStatus(session)` (`index.js` ~1620) builds
`{model, context:{tokens, window, pct}, limits[], effort, workdir, …}` with
`buildSessionStatus` and publishes it as the **ephemeral `status` op**
(`journal-publisher.js publishStatus`) — at turn end, every 5 s mid-turn,
and right after `compact_boundary`. Claude's window is guessed from the
model name (1M for fable/mythos/`[1m]`, else 200k); Codex omits `context`
when its window is unknown.

**The journal keeps that status, but only in memory.** `makeStatusCache`
(journal `src/ws.js`) is a 2048-entry LRU replayed to a client that opens
the conversation. Nothing persists it; `GET /roster` and `mission_get`'s
conversation rows carry no model or context. A journal restart forgets every
gauge until the next turn end.

**The three actions already have local handlers.**

| Action | Claude iv-mode | Claude print mode | Codex |
|---|---|---|---|
| `/model X` | in-process: types `/model X` into the PTY (`lib/model-command.js`), applies on the next message | idle: `recreateSession` with `--model` + `--resume` (history kept); busy: parked in `session._deferredCommandText` and replayed at turn end | in-process (`applyModelSwitch`, refuses while busy) |
| `/compact` | typed straight into the PTY, even mid-turn (`isIvSlashPassthrough`) | queued at the **front** of `session.queuedMessages`, sent alone at the next idle point (`lib/compact-priority.js`, `compactBatchSize`) | native `thread/compact/start` |
| a text turn | `session.iv.sendText` or queued if busy | queued if busy, flushed at turn end | `turn/start` |

Busy/idle is `session.busy`, cleared at exactly three turn-end points
(`result` event, the Stop-hook `/turn-end` route, `finishCodexTurn`), each
of which runs `dispatchDeferredCommand(session)` and then
`flushPendingSessionQueue`. So "at the next idle point" is an existing
primitive for print mode, but iv-mode `/compact` and `/model` are typed
live today — a Coordinator-driven action must not do that.

**A limit stall is visible, but not recognised.** When the account's
5-hour / weekly meter is exhausted, Claude Code ends the turn with an
assistant text such as
`You've reached your Fable 5 limit. Run /usage-credits to continue or switch models with /model.`
(also `Error during compaction: You've reached …`). The bridge posts it as
ordinary assistant text and marks the session `waiting`; nothing flags the
stall or reads the reset time, although `limits[]` in the status frame
carries `resets_at` per meter (`lib/usage-limits.js`).

**Cross-box calls only go through the journal.** A bridge cannot send
`agent_request` (client connections only). The journal itself is an RPC
caller (`src/rpc-broker.js issue()`, `from_device_id: 0`) for `recent_folders`
and spawn's `start`; the bridge answers in `lib/journal-rpc.js`
(`recent_folders`, `local_memories`, `local_memory_get`, `start`). Spawn and
invites are the two existing "agent → journal → other agent" relays: a WS
op from the asking bridge, journal-side checks (same user, own
conversation, privacy, pending-ask cap), optional consent card, wake of a
sleeping box, then a journal-originated RPC and an outcome frame back.

**The Coordinator is a journal fact.** `user_settings.coordinator_convo_id`,
readable by any of the user's devices via `GET /coordinator`; the bridge
caches it (`lib/coordinator.js`) and flags `session.coordinator`. No route or
tool today is gated on it — the Coordinator's difference is its prompt,
its disabled edit tools and its default model.

## Design

Two independent halves: a **read path** (context stats on the roster) and a
**control path** (a Coordinator-only relay for the three actions). Each is
its own PR pair (journal, bridge); the read path has no bridge protocol
change at all.

### 1. Read path: persist the status header, show it on the roster

**Journal.** Persist a subset of every accepted `status` op alongside the
in-memory replay cache: a new table

```sql
CREATE TABLE conversation_status (
  convo_id     TEXT PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
  model        TEXT,
  context_tokens INTEGER,
  context_window INTEGER,
  context_pct  INTEGER,
  stall_json   TEXT,          -- see §3; null when not stalled
  limits_json  TEXT,          -- the frame's limits[] (id,label,percent,resets_at), ≤ 2 KiB
  reported_at  INTEGER NOT NULL
)
```

written from the same `status` handler (`ws.js` ~1803) with the same
ownership check, latest-wins, throttled to one write per conversation per
~5 s (the bridge already repaints at that rate mid-turn). `GET /roster`
conversations gain `status: {model, context:{tokens,window,pct}, stall?,
limits?, reported_at}` (omitted until first report); `mission_get`'s
conversation rows (`src/missions.js` SELECT) gain the same block. Both are
scoped by the existing privacy predicate. `GET /snapshot` is unchanged.

**Bridge.** `agent_roster` and `mission_get` render the block:
`(ang, waiting · opus[1m] · 87k/1M 9% · reported 2 min ago)`; a Codex or
never-reported row shows `context unknown`. The status frame itself gains
`stall` (§3) and, for Codex, nothing new: Codex reports `context` only when
`modelContextWindow` is known, which stays "unknown" otherwise. No new
tool; the Coordinator already calls both.

**Apps.** Out of scope here, but the same roster block is what the apps
would render for a "context" column later.

### 2. Control path: `session_control` relay

One journal WS op, mirroring `spawn_request` without the consent card by
default:

```json
{ "op": "session_control", "request_id": "…", "from_convo_id": "<coordinator convo>",
  "target_convo_id": "<session convo>",
  "action": "set_model" | "compact" | "carry_on",
  "model": "sonnet",              // set_model only, ≤ 64 chars, validated by the target bridge
  "message": "carry on with …",   // carry_on only, ≤ 2000 chars, sanitised like spawn.task
  "when": "now" | "after_limit_reset",   // carry_on only, default now
  "reason": "context at 92%" }     // optional, ≤ 200 chars, shown in the target chat
```

**Journal checks, in order**: agent connection (`forbidden` for clients);
`from_convo_id` is a top-level conversation this device owns **and** equals
`user_settings.coordinator_convo_id` (`forbidden`, detail `not_coordinator`)
— the one place the Coordinator role gates a route; `target_convo_id`
resolves, same user, top-level, has an `agent_device_id`, visible under
the caller's privacy regime (`not_found`, indistinguishable); target is not
the Coordinator itself and not a room (`bad_request`). Then
`wakeIfOffline(target device)`: an asleep box is woken and the request is
parked up to `MATRON_SPAWN_WAKE_WAIT_MS` like spawn approval;
`agent_unreachable` only when no wake is possible. Then a journal-originated
RPC `session_control {convo_id, action, model?, message?, when?, reason?,
from_convo_id, from_name}` to the target device, 30 s timeout, and the
reply relayed to the asking bridge as
`{kind:'session_control', event:'result', request_id, ok, result?|error?}`.
Nothing is journaled by the journal; the target bridge writes the visible
record (below). A `session_control` row is **not** counted against the
pending-ask cap (nothing awaits the user) — unless Dan chooses per-action
consent (question A), in which case it is parked `awaiting_user` exactly
like spawn, with a card and a tracker item, and counted.

**Target bridge** (`lib/journal-rpc.js` → new `lib/session-control.js`,
pure planner + thin wiring):

- resolve the session by conversation id (`not_found` if this bridge no
  longer runs it; `gone` if it ended);
- **never act mid-turn**: if `session.busy` or otherwise occupied
  (`_awaitingInputReady`, `waitingForAnswer`, `pendingInteractivePrompt`),
  park the action in a new per-session `deferredControls` list drained at
  the three turn-end points before `dispatchDeferredCommand`, and answer
  `{ok:true, applied:'deferred'}`; otherwise apply now and answer
  `{ok:true, applied:'now'}`;
- `set_model`: validate with `isValidModelArg` (Claude) or against the
  Codex model catalogue; apply through the existing `applyModelSwitch`
  path (iv: typed switch; print: recreate with `--model`; Codex: in-process).
  Errors: `bad_model`, `busy_codex` (Codex refuses a switch mid-turn; parked
  instead), `unsupported` (print-mode session in a state that cannot
  recreate);
- `compact`: Claude print → existing queue-front path; Claude iv → typed
  `/compact` **only at idle** (never the live passthrough); Codex → native
  compact. Second compact while one is queued → `already_queued`;
- `carry_on`: `when: now` → the message enters the session's queue as a
  turn attributed to the Coordinator (`[from the Coordinator] carry on: …`),
  the same shape as a spawn's opening turn. `when: after_limit_reset` →
  parked until the session's `stall.resets_at` (§3) has passed (timer,
  persisted in the session's state file so a bridge restart re-arms it; a
  box that sleeps fires it on the next boot's resume). If the session is
  not stalled, `after_limit_reset` is answered `not_stalled`. A `carry_on`
  never resets the self-restart budget (it is not user input).
- **Visible record** in the target chat, whatever the outcome: a notice
  `🛠 Coordinator: compacting this session once this turn finishes — context at 92%`
  / `… switched model to Sonnet` / `… carry on (after the Fable limit resets at 15:00)`,
  posted with the existing `notice()` helper, so Dan sees who did what and
  why in the session itself. The Coordinator's tool result says the same
  in one line; the `result` frame arrives as a later turn when the action
  was deferred or the box had to wake (like spawn outcomes).

**Coordinator's bridge** (`ask-user.js` + `lib/agent-spawn.js`-style
sender): three MCP tools, all refused locally with a clear message when
this session is not the Coordinator (the journal enforces it anyway).
Context is read from `agent_roster` / `mission_get` (§1); there is no
separate read tool unless Dan wants one:

- `session_set_model(convo_id, model, reason?)`
- `session_compact(convo_id, reason?)`
- `session_carry_on(convo_id, message, when?, reason?)`

Each returns immediately ("sent to <box>; applies at its next idle point")
and the outcome arrives as a turn. `BRIDGE_COORDINATOR.md` gains a
"Keep sessions healthy" section: when to compact (context ≥ ~80%), when to
switch a stalled session to another model versus waiting for the reset,
and never to act on a `running` session expecting an immediate effect.

### 3. Recognising a limit stall

The bridge sets `stall` in the status frame when a turn ends on an
assistant text matching `/reached your .* limit/i` (or the record's
`isApiErrorMessage`), or when a `/compact` fails with the same text:

```json
"stall": { "kind": "usage_limit", "model": "claude-fable-5-1",
           "resets_at": "2026-09-29T15:00:00Z", "since": 1790690000000 }
```

`resets_at` comes from the matching `limits[]` line (the "session" meter's
`resets_at`, else the weekly one); omitted when unknown. Cleared on the
next successful assistant record or model switch. Codex: its rate-limit
text differs and is not matched in v1 — reported as unknown. The journal
persists it (§1) so the roster shows `stalled: Fable limit, resets 15:00`
and the Coordinator can decide between `session_set_model` (switch away)
and `session_carry_on … after_limit_reset`.

Optional (question D): the bridge itself auto-sends "carry on" at
`resets_at` for a stalled session, without the Coordinator, and only
announces it.

## Questions filed for Dan (tracker, mission #4644)

- **A. Permissions and consent.** Journal-enforced: only the Coordinator's
  conversation, only the same user's sessions, never itself. Standing
  permission (no card) for all three actions, with the record in the
  target chat — or a consent card per action like spawn? Recommendation:
  standing for `compact` and `carry_on`, standing for `set_model` too (it
  is reversible and visible), no cards.
- **B. How each action appears in the target chat.** A one-line notice
  (`🛠 Coordinator: …reason`) from the bridge, plus the queued carry-on
  text shown as a Coordinator-attributed turn. Or also a milestone on the
  session's mission? Recommendation: notice only; the Coordinator posts a
  milestone itself if it matters.
- **C. Codex sessions.** Model switch and compact work natively; context is
  shown when Codex reports a window, else "unknown"; limit stalls are not
  recognised in v1. OK to ship Codex at that level?
- **D. Carry-on after the limit reset.** Who waits: the target bridge
  (parks until `resets_at`, survives restart), the Coordinator (sets a
  reminder and calls the tool again), or the bridge automatically without
  the Coordinator? Recommendation: the bridge parks it on the Coordinator's
  instruction (`when: after_limit_reset`); no fully automatic carry-on.
- **E. Never mid-turn.** Actions on a `running` session are parked and
  applied at its next idle point (the three turn-end hooks); the tool
  result says `deferred`. Is a hard refuse (`busy`, try later) preferable
  for `set_model`, since a parked model switch may land after the turn the
  Coordinator was worried about? Recommendation: park everything.
- **F. Read path.** Persist the status header in the journal and show it
  on `agent_roster` / `mission_get` rows (no new tool), rather than a
  live RPC (which cannot see asleep boxes). OK?

## Testing

- Journal: `session_control` op unit tests (every check above, wake path,
  relay of ok/error, non-Coordinator caller `forbidden`); `conversation_status`
  write throttle and roster/mission exposure; privacy predicate.
- Bridge: `lib/session-control.js` planner (pure: busy → deferred, model
  validation, Codex vs Claude paths, `after_limit_reset` with and without
  a stall); stall detector against the observed texts; roster formatting;
  tool handlers refusing a non-Coordinator caller; wiring pinned by source
  inspection like `test/coordinator-wiring.test.js`.
- Manual: two boxes, Coordinator on one, target on the other, all three
  actions while the target is idle, busy, and asleep.

## Rollout

Journal first (the new op answers `unknown_op` on an old journal, which the
bridge tools report verbatim), then bridges via the usual fleet pass. Old
bridges ignore the roster's `status` block and answer `unknown_method` to
the RPC, which the Coordinator sees as "that box's bridge predates session
control".
