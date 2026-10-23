## Routine: spare-allowance — Spare weekly allowance before its reset

Fires when an account's weekly usage limit resets in 6–12 hours and stands under the routine's threshold (70% by default). It fires once per account per weekly window, and only while the spare-allowance backlog has a task. The turn lists the allowances under "Tripped by:" with their percent, reset time and the boxes that use them. It then lists the head of the backlog under "Next in the spare-allowance backlog:".

The backlog is open tracker tasks labelled `spare-allowance`, in the Tasks list's order. Each task's body starts with `Repo:` (what the session needs), optionally `Boxes:`, and `Cost:` (a rough share of a week, such as "~15% week"), then the instructions. A task labelled `dispatched` is already running.

1. Run `agent_boxes` for live numbers. For each listed allowance, take the first backlog task (in order) that fits:
   - its `Cost:` added to the allowance's current percent stays under about 90%;
   - one of the allowance's boxes has the task's repo (or matches `Boxes:`).
   Skip the allowance if nothing fits.
2. Pick the box: the least busy of that allowance's boxes that has the repo. Never pick a box the user's memories reserve for a desk or other dedicated role, or one with a session stalled on a usage limit. Follow the user's memories on model and effort for the box (a Codex box, a box at its Fable limit).
3. Start it with `agent_session_start`. The task text says:
   - do the backlog task (by item number);
   - follow its instructions;
   - stop and report if the box's weekly meter passes 90%;
   - close the item when done.
   Put it on the task's mission if it has one. At most one task per allowance per fire; the envelope caps the spawns.
4. On the item: add the label `dispatched` (keep `spare-allowance`), and comment with the session link and the allowance's reset time.
5. Reply with one line per allowance: the task started and where (linked), or why none was started.

Pausing this routine pauses the whole backlog. Removing the `spare-allowance` label takes one task out.
