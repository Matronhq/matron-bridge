# Plan approvals in the Decisions list — design

**Date:** 2026-09-22 · **Requested by:** Dan (2026-09-22, "I can never
find the approval cards"; item #2317 "ok yes all good" to mirroring plan
approvals bridge-side) · **Repos touched:** matron-bridge (this spec).
Sibling: matron-journal PR 83 mirrors spawn and agent-chat consent cards
the same way, journal-side.

## Problem

A "📋 Plan Ready — reply build to execute, or send feedback" card is a
consent ask that routinely waits for hours (the ExitPlanMode hook blocks
until the user answers, up to 29 min in iv-mode; print-mode waits
indefinitely). It lives only in one conversation's timeline, and only the
bridge knows about it. The Decisions list is where the user looks.

## Design

`lib/plan-approval-items.js`, an injected factory in the shape of
`lib/secret-requests.js`:

- **opened(session, plan)** — called wherever the card is posted (iv-mode
  `requestPlanDecision`, the print-mode ExitPlanMode-denial path). Files a
  `question` item on the session's journal conversation: title "Plan ready
  — reply build to execute it, or send feedback", label `plan`, body = the
  plan as markdown (capped at 8 000 chars, says when cut) plus how to
  answer. Remembers the item on the session (`session.planItemId`,
  persisted next to `pendingPlanDenialId` so a restart can still close
  it). An open plan item is closed as cancelled ("Replaced by a newer
  plan.") first, so one session has at most one open plan item.
- **resolved(session, 'build' | 'timeout')** — `approvePlanBuild` (build
  in the conversation or on the item) closes it `decided`; the iv-mode
  hook timeout closes it `cancelled`.
- **isBuildReply(session, marker)** — `journalOnItem` runs it before
  routing an item marker: the user's own `build` comment on this session's
  open plan item approves the plan through `approvePlanBuild`, gated on
  the same pending-plan predicate `dispatchPlanBuild` uses, instead of
  becoming a "📌 dan replied: build" turn. Any other reply on the item
  routes as it always did (feedback reaches the agent as a turn).

Feedback in the conversation does not close the item: the plan is still
pending in the session's own state until `build`, a timeout, or a revised
plan, and the revised plan's card replaces the item.

Best-effort throughout: a tracker failure never costs the plan flow, and
nothing here throws. Requires a journal (`items` client status 0 without
one → no item, logged).

## Out of scope

Tool-permission prompts (item #2317: left out — seconds-lived, many per
session). The apps need nothing: the item is answerable by replying
`build` in its own thread.
