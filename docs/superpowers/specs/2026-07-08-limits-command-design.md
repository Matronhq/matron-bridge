# Design: `/limits` command — subscription usage limits

**Date:** 2026-07-08
**Status:** Approved (design), pending implementation plan
**Branch:** `feat/limits-command`

## Problem

The bridge has a `/usage` command, but it only reports the current session's
token breakdown (input / output / cache) and cost. It does not show the Claude
*subscription* rate limits — the 5-hour session window and the weekly limits —
that Claude Code's own interactive `/usage` panel displays. Users want to see,
from Matrix, how much of their session/weekly allowance they've consumed.

## Decision summary

- Add a **new** command `/limits`. Leave the existing `/usage` (tokens/cost) and
  `/cost` (cost + turns) untouched — nothing is dropped or relocated.
- Show **headline lines only**: the `Current session` / `Current week …` lines
  with percent-used and reset time. Omit the "what's contributing" breakdown.

## Data source

`claude -p "/usage" --output-format text` returns the subscription limits as
plain text, e.g.:

```
You are currently using your subscription to power your Claude Code usage

Current session: 39% used · resets Jul 9, 12:59am (UTC)
Current week (all models): 66% used · resets Jul 12, 6:59pm (UTC)
Current week (Fable): 100% used · resets Jul 12, 6:59pm (UTC)

What's contributing to your limits usage?
... (breakdown — ignored)
```

This is the cleanest available source:

- The stream-json `usage` object the bridge already parses has **no** rate-limit
  fields (only `input_tokens`, `output_tokens`, `cache_*`, `service_tier`,
  `speed`, `iterations`). Confirmed by inspecting a live transcript.
- There is **no** `claude usage` subcommand or `--usage` flag.
- Reading `~/.claude/.credentials.json` + calling an undocumented Anthropic
  endpoint would work but is fragile and requires handling the OAuth token.

Shelling out to `claude -p "/usage"` lets Claude Code do the work and return
clean text. It runs as the same OS user against the same `~/.claude`, so it
authenticates as the same subscription. The `/usage` slash command returns
cached usage data and does not appear to consume model tokens. `< /dev/null`
avoids Claude Code's 3-second "no stdin" wait.

## Architecture

Follows the existing testable-lib pattern (`lib/model-command.js`,
`lib/session-mode.js`): pure logic in `lib/`, I/O in `index.js`.

### `lib/usage-limits.js` (new, pure, no I/O)

- `parseUsageLimits(rawText)` → `{ ok: boolean, lines: [{ label, percent, resets }] }`
  - Extracts lines matching `^Current (session|week…): N% used · resets …`.
  - `label` normalized generically by stripping the leading `Current ` prefix,
    so any per-model line works (`Session`, `Week (all models)`,
    `Week (<any model>)`) — no model name is hardcoded.
  - `percent` as a number (for color thresholds); `resets` as the trailing string.
  - `ok: false` when no such lines are found (triggers raw-text fallback).
- `formatLimits(parsed, rawText)` → `{ plain, html }`
  - Builds the `📊 Subscription Usage` message.
  - Percent color-coded via the same thresholds/`color()` idiom as `/cost`:
    green `<50`, orange `<80`, red `>=80`.
  - When `parsed.ok` is false, returns the raw text verbatim (fallback).

### `index.js` (I/O only)

- Spawn `claude -p "/usage" --output-format text` with stdin redirected from
  `/dev/null`, a ~30s timeout, capturing stdout.
- Pass stdout to `parseUsageLimits` → `formatLimits`, then `sendHtml(plain, html)`.
- The command does **not** require an active session (`sessions.get(roomId)` is
  not consulted) — it is a global subscription query.

### Registration (4 sites in `index.js`)

1. `bridgeCommandNames` set — add `'limits'` so `/limits` is intercepted by the
   bridge and not routed into the interactive TUI.
2. `handleCommand` switch — add `case '!limits':`.
3. Command registry array — `{ command: 'limits', description: 'Show subscription usage limits' }`.
4. `/help` text — add the `/limits` line.

## Error handling

- **Timeout (~30s):** reply "Couldn't fetch usage limits (timed out)."
- **Non-zero exit / `claude` not found:** reply with the error and a short hint.
- **No `Current …` lines parsed** (API-key user, or Claude Code changes the
  output format): fall back to posting the raw stdout so the feature degrades
  visibly rather than silently breaking.

## Testing

`test/usage-limits.test.js`, following `test/model-command.test.js`:

- Subscription sample (the block above) → parses 3 lines with correct labels,
  percents, resets; formats with expected color thresholds.
- No-match sample (e.g. API-key output or garbage) → `ok: false`, fallback
  returns raw text.
- Percent boundary cases → 49/50/79/80/100 map to the right colors.

## Out of scope

- The "what's contributing" breakdown.
- Changes to `/usage` or `/cost`.
- Caching/rate-limiting the subprocess (each `/limits` spawns a fresh call).
- Multi-machine / claude.ai aggregation (the numbers are per-machine, as noted
  in Claude Code's own output).
