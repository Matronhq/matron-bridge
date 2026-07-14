# SP1 — matron-bridge: Retire Matrix + Rename — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn `claude-matrix-bridge` into `matron-bridge` — a Node service that speaks only to a matron-journal server (no Matrix), keeping all Claude-orchestration / viewer / ask-user behavior intact.

**Architecture:** The journal transport already exists and dual-posts alongside Matrix (`lib/journal-*.js` + the "Journal Input Consumer" in `index.js`). This plan promotes journal to the sole path and deletes the Matrix layer beneath it: the outbound dual-post functions lose their Matrix branch, the inbound `client.on('room.message')` handler and the `MatrixClient` are removed, session identity moves from Matrix room ids to minted UUIDs, and the convo title is seeded from the workdir instead of a Matrix room name. Then a mechanical rename of every user-facing surface.

**Tech Stack:** Node 20 (ESM), `ws` WebSocket client, Vitest (`vitest run`). Matrix SDK being removed: `matrix-bot-sdk` (in `index.js`) + `matrix-js-sdk` / `@matrix-org/matrix-sdk-crypto-wasm` (in the bootstrap `.mjs` scripts).

## Global Constraints

- **ESM module.** `index.js` uses `import`, not `require`. No `require()` anywhere.
- **Suite stays green.** After every task: `npm test` (`vitest run`) passes. Pre-existing/unrelated failures must be recorded in Task 1's baseline and no *new* failures introduced.
- **Syntax gate.** After any `index.js` edit: `node --check index.js` must pass.
- **Keep, do not touch:** the file viewer + `ask-user` secure-data flow (HMAC/viewer), MCP config, hooks, voice-note transcription, `lib/prompt-detector.js`, the busy-queue/command surface (`/model`, `/effort`, `/context`), and the journal-only helpers `finalizeToolStreamEntry` / `stopAndFinalizeToolStream` / `sweepToolStreams`.
- **`lib/prompt-buttons.js` STAYS.** It is shared — the journal inbound path uses `promptButtons` / `promptResponseForButton` (`index.js:5130`, `5134`). Only its Matrix consumer `sendButtonMessage` is removed.
- **Do NOT rename runtime state dotfiles.** `SESSIONS_FILE` = `~/.claude-matrix-sessions.json` (`index.js:105`) and the uploads dir `~/.claude-matrix-uploads` hold live state on this box; renaming them orphans sessions. They keep their names in SP1 (out of scope; a later migration can rename them). The Matrix-only crypto/state files (`~/.claude-matrix-bot-crypto`, `~/.claude-matrix-bot-state.json`, `~/.claude-matrix-bot-last-event-ts`) are deleted along with Matrix.
- **Journal is required.** Startup validates `JOURNAL_WS_URL` + a resolvable agent token and exits if absent (replacing the old Matrix-token exit). `.env.example` shows a `wss://` default — never assume plaintext `ws://`.
- **Work on a branch; commit AND push after every task** so Bugbot runs incrementally. Branch: `sp1-retire-matrix`.
- **Task 9 (dir/repo rename + service reinstall + restart) is disruptive** — it restarts the bridge running THIS session. It is sequenced last and needs explicit user coordination.
- Spec: `docs/superpowers/specs/2026-07-14-matron-bridge-journal-only-design.md`.

---

### Task 1: Branch + baseline + repo-wide env-var rename

Rename the two port env vars everywhere they are produced or consumed. This is mechanical and Matrix-independent, so it is safe to do first. `MATRON_BRIDGE_API_PORT` is injected into the spawned Claude's environment (`index.js:834`, `1094`) and read by the ask-user MCP flow, so a repo-wide rename is required — missing a consumer silently breaks the secure-data flow.

**Files:**
- Modify: `index.js` (`:834`, `:1094`, `:6071`, comment `:4049`)
- Modify: every other file that reads `MATRON_BRIDGE_API_PORT` / `MATRON_VIEWER_PORT` — enumerate with grep (expected: `ask-user.js`, `viewer/start.js`, `viewer/server.js`, `lib/mcp-config.js`, `lib/mcp-config-mac.js`, and their `test/*.test.js`)
- Modify: `.env.example` (`:31` `MATRON_BRIDGE_API_PORT=9802`, `:32` `MATRON_VIEWER_PORT=9803`)

- [ ] **Step 1: Create the branch and record the test baseline**

```bash
cd ~/claude-matrix-bridge
git checkout -b sp1-retire-matrix
npm test 2>&1 | tail -30
```

Record the pass/fail counts and the names of any already-failing tests in the task notes. Every later task compares against this baseline — no NEW failures allowed.

- [ ] **Step 2: Enumerate all env-var occurrences**

Run: `git grep -n 'MATRON_BRIDGE_API_PORT\|MATRON_VIEWER_PORT'`
Expected: the sites listed under **Files** above. If grep surfaces a file not listed, include it — the rename must cover every hit.

- [ ] **Step 3: Rename repo-wide**

```bash
cd ~/claude-matrix-bridge
git grep -l 'MATRON_BRIDGE_API_PORT' | xargs sed -i 's/MATRON_BRIDGE_API_PORT/MATRON_BRIDGE_API_PORT/g'
git grep -l 'MATRON_VIEWER_PORT'     | xargs sed -i 's/MATRON_VIEWER_PORT/MATRON_VIEWER_PORT/g'
```

- [ ] **Step 4: Verify no occurrences remain and nothing else broke**

Run: `git grep -n 'MATRON_BRIDGE_API_PORT\|MATRON_VIEWER_PORT'` — Expected: no output.
Run: `node --check index.js && node --check ask-user.js` — Expected: clean exit.
Run: `npm test 2>&1 | tail -20` — Expected: same result as the Step 1 baseline (no new failures).

- [ ] **Step 5: Commit and push**

```bash
git add -A
git commit -m "refactor: rename MATRIX_*_PORT env vars to MATRON_*_PORT"
git push -u origin sp1-retire-matrix
```

---

### Task 2: Rename product/name surfaces (in-repo only)

Mechanical string rename of user-facing names. Explicitly **excludes** the local directory rename and the GitHub repo rename (Task 9) — this task only edits file *contents*.

**Files:**
- Modify: `package.json` (`:2` `"name": "claude-matrix-bridge"` → `"matron-bridge"`; `:4` description "Bridge Matrix messages…" → "Bridge Claude Code sessions to a matron-journal server")
- Modify: `README.md` (`:1` title, `:3` "two transports" → single journal transport, `:124-137` service/launchd command names, `:226-229` dir-tree header + the stale "Matrix + journal wiring" / "node --test suite" notes → "journal wiring" / "Vitest suite")
- Modify: `BRIDGE_CLAUDE.md` (`:1` "# Claude Matrix Bridge Instructions" → "# Matron Bridge Instructions"; `:3` "running inside a Claude Matrix bridge session … interacting through Matrix" → "running inside a Matron bridge session … interacting through Matron")
- Modify: `restart.sh` (`:2` comment, `:12` `pkill -f 'node.*claude-matrix-bridge/index\.js'` → `matron-bridge`, `:41`/`:47`/`:50` `/tmp/claude-matrix-bridge.log` → `/tmp/matron-bridge.log`)
- Modify: `start-bridge.sh` (`:3` `/tmp/claude-matrix-bridge.log` → `/tmp/matron-bridge.log`)
- Modify: `setup/service-linux.sh` (`:16` unit path `claude-matrix-bridge.service` → `matron-bridge.service`; `:18` `Description=Claude Code Matrix Bridge` → `Description=Matron Bridge`; `:37` `claude-matrix-file-viewer.service` → `matron-bridge-viewer.service`; `:39` viewer Description; `:56-63` enable/restart/status service names)
- Modify: `setup/service-macos.sh` (`:43` `BRIDGE_LABEL="chat.matron.claude-matrix-bridge"` → `chat.matron.matron-bridge`; `:44` `VIEWER_LABEL="chat.matron.claude-matrix-file-viewer"` → `chat.matron.matron-bridge-viewer`; `:148-165` log paths / plist writes)

- [ ] **Step 1: Enumerate occurrences (excluding docs history + the two dotfiles we keep)**

Run: `git grep -n 'claude-matrix-bridge\|Claude Matrix Bridge\|claude-matrix-file-viewer' -- ':!docs' ':!index.js'`
`index.js` is excluded here because its only remaining hits are the `.claude-matrix-*` runtime dotfiles we deliberately keep. Confirm that by running `git grep -n 'claude-matrix' index.js` and checking every hit is a `~/.claude-matrix-*` path (lines 105, 326, 3382, 3390, 3420 — the last three are Matrix crypto files removed in Task 4).

- [ ] **Step 2: Apply the renames**

Edit each file listed above. For the shell/config files a scripted pass is safe:
```bash
cd ~/claude-matrix-bridge
for f in restart.sh start-bridge.sh setup/service-linux.sh setup/service-macos.sh; do
  sed -i 's/claude-matrix-file-viewer/matron-bridge-viewer/g; s/claude-matrix-bridge/matron-bridge/g' "$f"
done
```
Then hand-edit `package.json`, `README.md`, and `BRIDGE_CLAUDE.md` for the prose/description changes (they need wording, not just token swaps).

- [ ] **Step 3: Verify**

Run: `git grep -n 'claude-matrix-bridge\|Claude Matrix Bridge\|claude-matrix-file-viewer' -- ':!docs' ':!index.js'` — Expected: no output.
Run: `node --check index.js` and `npm test 2>&1 | tail -20` — Expected: baseline green.

- [ ] **Step 4: Commit and push**

```bash
git add -A && git commit -m "refactor: rename product/service surfaces to matron-bridge (contents only)" && git push
```

---

### Task 3: Make the outbound/publish path journal-only

Remove the Matrix branch from the interleaved dual-post functions and delete the pure-Matrix outbound helpers, preserving every journal path. After this task `client` still exists and the inbound Matrix handler is still live (removed in Task 4), so the bridge still boots and both transports still receive input — but nothing is *sent* to Matrix. This is the reviewer gate: "outbound is journal-only; bridge boots; suite green."

**Files:**
- Modify: `index.js` — the "Send to Matrix Room" (`3427-3672`), "Room Management" (`3674-3922`), and "Media Handling" (`3924-4031`) sections.

**Interfaces:**
- Produces: `sendToRoom(roomId, ...)` now returns the journal durable ref (or `null`) instead of a Matrix `eventId`. Callers that used the return value for Matrix edits are being deleted in this same task, so no caller should read a Matrix event id after this.

- [ ] **Step 1: Read the target functions before editing**

Read `index.js:3427-4031`. Confirm the current shape of each function named below matches the line ranges (the file may have shifted by a few lines from earlier edits — re-anchor by function name, not absolute line).

- [ ] **Step 2: Strip the Matrix branch from `sendToRoom` (`~3435-3480`)**

Keep the journal branch (`~3436-3464`: `journalPublish(...)`, stream-overlay `_journalDurableRef` handling). Delete the Matrix branch (`~3465-3479`: the `m.text` content build + `await client.sendMessage(roomId, content)`). Change the function to return the journal durable ref it already computes (or `null`); remove any `eventId` return.

- [ ] **Step 3: Strip the Matrix branch from `sendLiveOutputEvent` (`~3482-3511`) and `sendButtonMessage` (`~3650-3672`)**

`sendLiveOutputEvent`: keep the `journalActivity(session, 'tool', …)` call (`~3489`); delete the `chat.matron.live_output` custom-event build + `client.sendMessage` (`~3490-3510`).
`sendButtonMessage`: keep `journalPublish(..., 'publishPrompt', { question, options, mode })` (`~3652-3653`); delete the `chat.matron.buttons` event build + `client.sendMessage` (`~3654-3671`). The function keeps its `promptButtons`-derived `options` (that import stays).

- [ ] **Step 4: Reduce `updateRoomName` (`~3751-3762`) to the journal path and simplify `maybeUpdatePinnedSummary` (`~3764-3875`)**

`updateRoomName`: keep `journalUpsertConvo(journalSession, { title: name })` (`~3755-3756`); delete `client.sendStateEvent(roomId, 'm.room.name', …)` (`~3757-3761`). It becomes journal-title-only.
`maybeUpdatePinnedSummary`: keep the Gemini summarization + the `updateRoomName(...)` title call. Delete the pure-Matrix pinned-message logic (`~3837-3870`: `client.getEvent`, `client.sendMessage`, `client.getRoomStateEvent`, `client.sendStateEvent 'm.room.pinned_events'`) and the persisted `pinnedSummaryEventId` write (the summary *text* persist may stay; the Matrix event id has no meaning now).

- [ ] **Step 5: Delete the pure-Matrix outbound helpers**

Delete entirely: `editMessage` (`~3719-3740`), `stripQueueNotificationLinks` (`~3742-3749`), and `downloadMatrixFile` (`~3926-3949`). Then rewire `buildMediaContentBlocks` (`~3951-4031`): its byte source at `~3958` was `downloadMatrixFile`; media over the Matrix transport no longer exists, so remove the Matrix-shaped download and the `content.url`/`content.file`/E2E-decrypt handling. **Preserve** the `attachPendingMediaMirror(...)` journal hooks (`~3989`, `~4000`, `~4006`) and the bytes→Claude-content-block conversion. (Inbound media now only arrives via the journal path; if `buildMediaContentBlocks` has no non-Matrix caller left after Task 4, it is removed there — leave a `TODO(Task4)` note, do not guess now.)

- [ ] **Step 6: Find any now-dangling callers of the deleted helpers**

Run: `git grep -n 'editMessage\|stripQueueNotificationLinks\|downloadMatrixFile' index.js`
Every remaining hit is inside code that Task 4 deletes (the Matrix message handler) OR must be removed now. If a hit is in a function that survives Task 4, remove that call now; if it is inside the `client.on('room.message')` handler (`~5509-6013`), leave it — the whole handler goes in Task 4.

- [ ] **Step 7: Verify**

Run: `node --check index.js` — Expected: clean.
Run: `git grep -n 'client\.sendMessage\|client\.sendStateEvent\|client\.sendEvent' index.js` — Expected: only hits inside the `client.on('room.message')` handler / room-membership / startup joined-rooms loop (all removed in Task 4). No hits inside `sendToRoom`, `sendLiveOutputEvent`, `sendButtonMessage`, `updateRoomName`, `maybeUpdatePinnedSummary`.
Run: `npm test 2>&1 | tail -20` — Expected: baseline green (journal publisher/stream/title tests still pass).

- [ ] **Step 8: Commit and push**

```bash
git add -A && git commit -m "refactor: make outbound publish path journal-only (drop Matrix sends)" && git push
```

---

### Task 4: Remove the Matrix client, inbound handlers, typing, and startup exit; mint session ids locally

The atomic "no more `client`" change. After this task no `MatrixClient` exists, the bridge boots and runs journal-only, and session identity comes from a minted UUID instead of a Matrix room. This is the highest-risk task — see the parity risk in the spec.

**Files:**
- Modify: `index.js` — import `:3`; typing (`3371-3378` + all `client.setTyping` sites); Matrix Client section (`3380-3425`); the message handler (`5509-6013`); room membership (`6015-6057`); `main()` startup (`6720-6767`); signal handlers (`6774-6791`); `createSessionRoom` (`3695-3717`).

**Interfaces:**
- Consumes: `randomUUID` (already imported at `index.js:7`).
- Produces: `newSessionConvoId()` → `string` (a fresh globally-unique convo id, replacing `createSessionRoom`'s Matrix-room id). Callers: `handleCommand` `!start` (`~4117`), `!workdir` (`~4363`), `!resume` (`~4297`), and any other `createSessionRoom(...)` caller.

- [ ] **Step 1: Replace `createSessionRoom` with `newSessionConvoId`**

Delete `createSessionRoom` (`~3695-3717`, which calls `client.createRoom` + encryption/command state events). Add in its place:

```js
// Mint a globally-unique conversation id for a new session. Journal convention
// is a UUID (see matron-journal protocol.md: bridges MUST mint globally-unique
// convo ids). This id doubles as the in-memory session key (formerly the Matrix room id).
function newSessionConvoId() {
  return randomUUID();
}
```

Update callers: `git grep -n 'createSessionRoom' index.js`, and at each call site replace `const sessionRoomId = await createSessionRoom(sender);` (and similar) with `const sessionRoomId = newSessionConvoId();` (drop the `await` — it is now synchronous).

- [ ] **Step 2: Remove all typing-indicator code**

Delete the `startTyping` function (`~3371-3378`). Then remove every `client.setTyping(...)` call:
Run `git grep -n 'setTyping\|startTyping' index.js` and delete each line (they are scattered: turn-end, esc-handling, kill/idle paths — deleting the call is safe, it was a Matrix-only side effect). If a `startTyping(...)` return value is stored in a variable that is later `clearInterval`-ed, remove that variable and its cleanup too.

- [ ] **Step 3: Delete the inbound Matrix handlers**

Delete entirely:
- The `client.on('room.message', async (roomId, event) => { … })` handler (`~5509-6013`). Before deleting, scan its body for journal-mirror calls that have no journal-side equivalent — `journalMirrorUserAnswer` (`~5636`, `~5642`), `journalMirrorUserMedia` (`~5956`), the `promptResponseForButton` prompt-opt branch (`~5711-5720`). These mirror a *Matrix-originated* user action into the journal; with Matrix gone the originating action now arrives through the Journal Input Consumer, which already calls the same mirror helpers (`journalRouteTextToSession` / `journalRoutePromptReply`). Confirm via `git grep -n 'journalMirrorUserAnswer\|journalMirrorUserMedia' index.js` that each helper still has a caller in the journal consumer (`~4923-5245`); if one is left with no caller, it is dead and can be deleted, but do not delete a helper that the journal path still uses.
- The room-membership block (`~6015-6057`): `sendPendingWelcomeIfNeeded`, `client.on('room.join')`, `client.on('room.event')`. If `sendPendingWelcomeIfNeeded`'s "Session started" welcome is still wanted, re-post it from the session-start path over the journal (`sendToRoom`/`journalPublish`) instead — otherwise delete it. Keep it simple: move the welcome text to the existing session-start notice if one exists; do not invent new UX.

- [ ] **Step 4: Delete the Matrix client, token resolution, and crypto**

Delete: the `import { MatrixClient, … } from 'matrix-bot-sdk';` line (`:3`); `readSidecarToken` (`~3380-3386`); the token-resolution + first-start bootstrap + `process.exit` block (`~3390-3418`); `CRYPTO_DIR` (`~3390`); the `SimpleFsStorageProvider` / `RustSdkCryptoStorageProvider` construction and `new MatrixClient(...)` + `AutojoinRoomsMixin` (`~3420-3425`); `let botUserId;`. Also delete the `MATRIX_HOMESERVER_URL` (`:67`) and `MATRIX_ACCESS_TOKEN` (`:68`) constants, `ENCRYPT_SESSION_ROOMS` (`:101`), and the `LAST_EVENT_TS_FILE` (`:326`) if `git grep` shows it is only referenced by now-deleted Matrix code.

- [ ] **Step 5: Replace the startup and shutdown Matrix calls with journal validation**

In `main()` (`~6720-6767`): delete `client.getUserId()`, the homeserver/encryption logs, `await client.start()`, and the joined-rooms command-state loop (`~6744-6766`, `client.getJoinedRooms` / `getRoomStateEvent` / `sendStateEvent`). In the signal handlers (`~6774-6791`): delete `client.stop()`. Add a startup guard near the top of `main()` (or where `JOURNAL_WS_URL` is first known), replacing the old Matrix-token exit:

```js
if (!JOURNAL_WS_URL || !_journalToken) {
  console.error('JOURNAL_WS_URL and a journal agent token (JOURNAL_TOKEN_FILE or JOURNAL_TOKEN) are required.');
  process.exit(1);
}
```

(`_journalToken` is resolved at `index.js:210` via `resolveJournalToken()`; `JOURNAL_WS_URL` at `:197`.)

- [ ] **Step 6: Verify no Matrix references remain**

Run: `git grep -n "matrix-bot-sdk\|MatrixClient\|client\.\|botUserId\|MATRIX_\|setTyping\|createSessionRoom\|RustSdkCrypto\|SimpleFsStorage" index.js`
Expected: **no output.** (`client.` catches any missed handler call; the `MATRON_*` port vars from Task 1 will NOT match `MATRIX_`.) If any hit remains, resolve it before continuing.
Run: `node --check index.js` — Expected: clean.

- [ ] **Step 7: Boot smoke (no Matrix required)**

```bash
cd ~/claude-matrix-bridge
# (a) missing journal config → must exit with the new message, NOT a Matrix message:
node index.js 2>&1 | head -5   # expect: "JOURNAL_WS_URL and a journal agent token ... are required."
# (b) dummy journal config → must boot and attempt a WS connection without any Matrix/client crash:
JOURNAL_WS_URL=wss://127.0.0.1:59999/ws JOURNAL_TOKEN=dummy timeout 4 node index.js 2>&1 | head -20
```
Expected (b): startup logs (default workdir, journal connect attempt / reconnect backoff). Expected: NO `ReferenceError: client is not defined`, no `MatrixClient`, no unhandled rejection referencing matrix.

- [ ] **Step 8: Run the suite**

Run: `npm test 2>&1 | tail -30`.
Expected: the journal/transport-agnostic tests pass. The "Matrix regression pin" tests in `test/command-dispatch.test.js` and `test/journal-input-router.test.js` are EXPECTED to fail now (they assert a `// --- Matrix Message Handler ---` block exists) — Task 6 updates them. Record exactly which tests fail so Task 6 has the list. Do not fix them here.

- [ ] **Step 9: Commit and push**

```bash
git add -A && git commit -m "refactor: remove Matrix client, inbound handlers, typing, startup; mint session ids locally" && git push
```

---

### Task 5: Seed the session title from the workdir

`journalSeedTitle` (`index.js:471-478`) fed `seedJournalTitleFromRoom` a `getRoomName` that read `m.room.name` via `client` — now gone. Re-source the title from the session's `workdir`.

**Files:**
- Modify: `lib/journal-title-seed.js` (`seedJournalTitleFromRoom` → workdir-sourced)
- Modify: `index.js:471-478` (`journalSeedTitle` wrapper) and its call sites (`:759`, `:1013`)
- Modify/Create: `test/journal-title-seed.test.js`

**Interfaces:**
- Produces: `seedJournalTitle(session, { workdir, upsertConvo, warn })` → `boolean` (renamed from `seedJournalTitleFromRoom`; no `getRoomName`). Derives the title from `workdir`.

- [ ] **Step 1: Write the failing test**

In `test/journal-title-seed.test.js`, replace the room-name test with:

```js
import { describe, it, expect, vi } from 'vitest';
import { seedJournalTitle } from '../lib/journal-title-seed.js';

describe('seedJournalTitle (workdir-sourced)', () => {
  it('titles the convo from the workdir basename when no hint is set', async () => {
    const session = { _journalTitleHint: undefined };
    const upsertConvo = vi.fn();
    const ok = await seedJournalTitle(session, { workdir: '/home/dan/yearbook-app', upsertConvo, warn: () => {} });
    expect(ok).toBe(true);
    expect(upsertConvo).toHaveBeenCalledWith(session, { title: expect.stringContaining('yearbook-app') });
  });

  it('does not overwrite an existing title hint', async () => {
    const session = { _journalTitleHint: 'kept' };
    const upsertConvo = vi.fn();
    await seedJournalTitle(session, { workdir: '/tmp/x', upsertConvo, warn: () => {} });
    expect(upsertConvo).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run it — expect failure**

Run: `npx vitest run test/journal-title-seed.test.js` — Expected: FAIL (`seedJournalTitle` not exported).

- [ ] **Step 3: Rewrite `lib/journal-title-seed.js`**

```js
import path from 'path';

// Seed a journal convo title from the session's workdir (basename), unless a
// live title hint already won. Fails open — a title is cosmetic.
export async function seedJournalTitle(session, { workdir, upsertConvo, warn = () => {} }) {
  try {
    if (session._journalTitleHint !== undefined) return false;
    const base = workdir ? path.basename(path.resolve(workdir)) : '';
    const title = base || 'session';
    upsertConvo(session, { title });
    return true;
  } catch (e) {
    warn(`seedJournalTitle failed: ${e?.message || e}`);
    return false;
  }
}
```

- [ ] **Step 4: Rewire `index.js`**

Change the import (`:56`) to `import { seedJournalTitle } from './lib/journal-title-seed.js';`. Replace `journalSeedTitle` (`:471-478`) with:

```js
function journalSeedTitle(session) {
  return seedJournalTitle(session, {
    workdir: session.workdir,
    upsertConvo: journalUpsertConvo,
    warn: (m) => DEBUG && console.warn(m),
  });
}
```

The call sites at `:759` (`journalSeedTitle(ivSession)`) and `:1013` (`journalSeedTitle(session)`) are unchanged — but confirm `session.workdir` is set before each call (it is: `workdir: cwd` is assigned at session-object creation, `:845`/`:1106`, before `journalSeedTitle` runs). Also update the `node --check` entry in `package.json` `check` (still `lib/journal-title-seed.js` — name unchanged, no edit needed).

- [ ] **Step 5: Run tests**

Run: `npx vitest run test/journal-title-seed.test.js` — Expected: PASS.
Run: `node --check index.js` — Expected: clean.

- [ ] **Step 6: Commit and push**

```bash
git add -A && git commit -m "feat: seed journal convo title from workdir instead of Matrix room name" && git push
```

---

### Task 6: Update the Matrix regression-pin tests

The pins in `test/command-dispatch.test.js` and `test/journal-input-router.test.js` read `index.js` source and assert Matrix structures that no longer exist. Update them to pin the journal-only reality.

**Files:**
- Modify: `test/journal-input-router.test.js` (the source-reading pin, ~`:599-620`, expecting `// --- Matrix Message Handler ---` + a shared respawn helper)
- Modify: `test/command-dispatch.test.js` (the "Matrix regression pin" cases, ~`:21`)

- [ ] **Step 1: Identify the failing assertions**

Run: `npx vitest run test/journal-input-router.test.js test/command-dispatch.test.js 2>&1 | tail -40`. Match failures to the list recorded in Task 4 Step 8.

- [ ] **Step 2: Rewrite each failing pin**

For any assertion that greps `index.js` for `// --- Matrix Message Handler ---` or a Matrix-only shared helper: re-point it at the journal equivalent that now carries that behavior — the Journal Input Consumer. Change the expected marker to `// --- Journal Input Consumer` (the header at `index.js:4848`) and assert the shared routing (`journalRouteTextToSession` / `journalRoutePromptReply`) exists, replacing the deleted `room.message` assertion. Keep the intent of each pin (that command classification / respawn routing is shared) but assert it against the surviving journal path. If a pin's sole purpose was to guard Matrix-handler behavior with no journal analogue, delete that specific case and leave a one-line comment noting it was retired with Matrix.

- [ ] **Step 3: Verify the whole suite is green**

Run: `npm test 2>&1 | tail -30` — Expected: green against the Task 1 baseline, with the previously-failing pins now passing and no new failures.

- [ ] **Step 4: Commit and push**

```bash
git add -A && git commit -m "test: repoint Matrix regression pins at the journal input consumer" && git push
```

---

### Task 7: Delete Matrix bootstrap scripts, dependencies, and script references

None of these are imported by long-running code (`git grep` confirmed the only Matrix import was `index.js:3`, removed in Task 4) — they are standalone CLI scripts invoked via npm scripts.

**Files:**
- Delete: `add-bot.mjs`, `bootstrap-crosssigning.mjs`, `bootstrap-from-creds.mjs`, `setup-user.mjs`, `verify-bots.mjs`, `verify-respond.mjs`, `setup/import-bot-blob.mjs`, `setup/cloudflare.sh`, `setup/cloudflare-macos.sh`
- Modify: `package.json` (deps `matrix-bot-sdk`, `matrix-js-sdk`; `overrides` `matrix-js-sdk` entry; `scripts` `bootstrap-crosssigning`; the `check` script's `node --check setup-user.mjs`/`verify-bots.mjs`/`bootstrap-crosssigning.mjs` entries)
- Modify: `.env.example` (remove Matrix vars + reword the journal migration comment)

- [ ] **Step 1: Confirm the scripts are not imported anywhere**

Run: `git grep -n "add-bot\|bootstrap-crosssigning\|bootstrap-from-creds\|setup-user\|verify-bots\|verify-respond\|import-bot-blob" -- ':!docs' ':!package.json'` — Expected: no output (no code imports them). If a hit appears in a `.sh` installer, remove that invocation too.

- [ ] **Step 2: Delete the files**

```bash
cd ~/claude-matrix-bridge
git rm add-bot.mjs bootstrap-crosssigning.mjs bootstrap-from-creds.mjs setup-user.mjs verify-bots.mjs verify-respond.mjs setup/import-bot-blob.mjs setup/cloudflare.sh setup/cloudflare-macos.sh
```

- [ ] **Step 3: Clean `package.json`**

Remove from `dependencies`: `"matrix-bot-sdk"`, `"matrix-js-sdk"`. Remove the `overrides.matrix-js-sdk` block (`~:43-45`). Remove the `scripts.bootstrap-crosssigning` line (`:13`). In `scripts.check` (`:15`) delete the three tokens `&& node --check setup-user.mjs`, `&& node --check verify-bots.mjs`, `&& node --check bootstrap-crosssigning.mjs`. Leave `@matrix-org/matrix-sdk-crypto-wasm` only if it is a direct dep (the map found it transitive, not direct — verify with `grep -n 'matrix-sdk-crypto-wasm' package.json`; remove only if present).

- [ ] **Step 4: Rewrite the Matrix section of `.env.example`**

Delete the Matrix vars (`MATRIX_HOMESERVER_URL`, `MATRIX_ACCESS_TOKEN`, `MATRIX_BOT_USER_ID`, `MATRIX_BOT_PASSWORD`, `MATRIX_BOT_RECOVERY_KEY`, `BRIDGE_ROOM_ID`, `ALLOWED_USER_IDS`, `ENCRYPT_SESSION_ROOMS`) and the `setup/import-bot-blob.mjs` comment. Reword the journal comment block to state journal is the sole transport. The end state matches the "Config surface" block in the spec (journal required, `wss://` default, `MATRON_BRIDGE_API_PORT=9802`, `MATRON_VIEWER_PORT=9803`).

- [ ] **Step 5: Reinstall and verify**

```bash
cd ~/claude-matrix-bridge
rm -rf node_modules package-lock.json && npm install 2>&1 | tail -5   # regenerate lockfile without Matrix deps
npm run check 2>&1 | tail -5   # the check script must pass with the deleted files removed
node --check index.js
npm test 2>&1 | tail -20
```
Expected: `npm run check` clean (no missing-file errors), suite green. Confirm Matrix is gone from the tree: `npm ls matrix-bot-sdk matrix-js-sdk 2>&1 | tail -5` → "(empty)" / not found.

- [ ] **Step 6: Commit and push**

```bash
git add -A && git commit -m "chore: delete Matrix bootstrap scripts and dependencies" && git push
```

---

### Task 8: End-to-end smoke against a local matron-journal

Prove the journal-only bridge works against a real server before the disruptive rename. If `~/matron-journal` cannot be run in the execution environment, fall back to the Task 4 boot smoke and record that the full E2E is deferred to SP4's integration.

**Files:** none (verification only).

- [ ] **Step 1: Start a local journal on a scratch DB**

```bash
cd ~/matron-journal
MATRON_DB=/tmp/sp1-smoke.sqlite MATRON_PORT=9810 MATRON_BIND=127.0.0.1 node src/server.js &
JPID=$!; sleep 1
```

- [ ] **Step 2: Provision a user + agent token**

```bash
cd ~/matron-journal
MATRON_DB=/tmp/sp1-smoke.sqlite node src/admin.js user add smoke || node bin/matron-admin user add smoke
TOKEN=$(MATRON_DB=/tmp/sp1-smoke.sqlite node bin/matron-admin agent add smoke dev-smoke | tail -1)
echo "$TOKEN" > /tmp/sp1-agent-token
```
(Use whatever the repo's actual admin entrypoint is — `git grep -n "agent add" ~/matron-journal` to find it. The token is printed once.)

- [ ] **Step 3: Boot the bridge against it**

```bash
cd ~/claude-matrix-bridge
mkdir -p /tmp/sp1-smoke-workdir
JOURNAL_WS_URL=ws://127.0.0.1:9810/ws JOURNAL_TOKEN_FILE=/tmp/sp1-agent-token \
  DEFAULT_WORKDIR=/tmp/sp1-smoke-workdir node index.js > /tmp/sp1-bridge.log 2>&1 &
BPID=$!; sleep 2
grep -iE 'journal|connected|hello_ok' /tmp/sp1-bridge.log | tail -10
```
Expected: the bridge connects (`hello_ok` / connected), no Matrix errors.

- [ ] **Step 4: Drive `new <dir>` through the control convo and assert a session spawns**

Using a tiny WS client as the "app" (a `client`-kind token: `node bin/matron-admin` login for user `smoke`), send `op:'send'` `type:'text'` body `new /tmp/sp1-smoke-workdir` to `convo_id` `bridge-$(hostname)`, then read the journal for a spawned-session convo + a title equal to `sp1-smoke-workdir`. Assert: a new convo appears, its title is the workdir basename, and a typed follow-up message round-trips to a Claude reply. (If standing up a client WS is too heavy, at minimum assert via `/tmp/sp1-bridge.log` that the control command was received and `createSession` ran with cwd `/tmp/sp1-smoke-workdir`.)

- [ ] **Step 5: Tear down**

```bash
kill $BPID $JPID 2>/dev/null; rm -f /tmp/sp1-smoke.sqlite /tmp/sp1-agent-token
```
Record the smoke result (pass / deferred-to-SP4) in the task notes. No commit (verification only) unless a fixture/script was added.

---

### Task 9: Final rename — GitHub repo, local directory, services, remote (DISRUPTIVE — do last)

This restarts the bridge running the current session. **Coordinate with the user before running it** (it must be triggered from outside this bridge session, or accepted that the session drops on restart). Everything above is already committed/pushed, so nothing is lost.

**Files:** git remote, local dir, installed systemd units.

- [ ] **Step 1: Merge the branch first**

Open a PR from `sp1-retire-matrix` and merge it (or fast-forward `master`) so the rename operates on the final code. Verify CI is green on the branch before merging.

- [ ] **Step 2: Rename the GitHub repo**

```bash
gh repo rename matron-bridge --repo Matronhq/claude-matrix-bridge
```
GitHub auto-redirects the old URL. (Outward-facing + hard to reverse — confirm with the user immediately before running.)

- [ ] **Step 3: Update the local remote and directory**

```bash
cd ~/claude-matrix-bridge
git remote set-url origin git@github.com:Matronhq/matron-bridge.git   # or https, match existing
git remote -v
cd ~ && mv claude-matrix-bridge matron-bridge
```

- [ ] **Step 4: Reinstall the renamed services**

Re-run the (now-renamed) service installer from `~/matron-bridge/setup/` so the units become `matron-bridge.service` / `matron-bridge-viewer.service`, then disable+remove the old `claude-matrix-bridge.service` / `claude-matrix-file-viewer.service`. Update any `~/.claude/CLAUDE.md` / bridge-management docs that reference the old service name or `~/claude-matrix-bridge` path (out-of-repo; note for the user).

- [ ] **Step 5: Restart and confirm**

```bash
sudo systemctl restart matron-bridge.service
systemctl is-active matron-bridge.service
```
This drops and re-establishes the bridge session. After reconnect, confirm the service is active on the renamed unit and the journal connection is healthy.

---

## Self-Review notes

- **Spec coverage:** Retire Matrix (Tasks 3–4, 7), journal sole transport (Tasks 3–4), rename all surfaces (Tasks 1–2, 9), config surface (Tasks 1, 7), session title re-source (Task 5), verification incl. suite + E2E smoke (Tasks 6, 8), `prompt-buttons.js` kept (Global Constraints + Task 3 Step 3), interleaved-function surgery (Task 3), highest-risk parity check (Task 4 Step 3). All spec sections map to a task.
- **Non-goals honored:** no button primitives (deferred to SP3), no dir-dotfile rename (Global Constraints), no viewer/MCP/hooks changes.
- **Ordering safety:** every task leaves the bridge bootable and the suite green except the deliberately-recorded pin failures between Task 4 and Task 6; the disruptive rename is isolated to Task 9 after everything is merged.
