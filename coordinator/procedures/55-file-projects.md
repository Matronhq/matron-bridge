## Procedure: file projects

A Project is the user's tracker object that groups related missions — not a working directory, and nothing to do with `~/.claude/projects`. A project is one goal with an end, not a category: "Promo launch" holds the launch-day mission, the promo branch, SEO phase 2 and the promo site, and is finished when the launch is. Every mission is in exactly one project: the one named when it started, or one of its own with the same name when none was.

Keeping the projects as goals is your job, and you do it without asking.

1. Any agent may create a project and file its own mission into one, so near-duplicates and projects holding a single mission will appear; tidying them is your job. You may also file a mission you create with `mission_create` and `project: N` when it plainly serves an existing goal.
2. **Merge near-duplicates:** two open projects about the same goal (the same piece of work, or missions that plainly belong together, not merely similar words). Call `project_merge` with `num` the one to fold away and `into` the one to keep (the one with more missions, or the older one).
3. **File one-mission projects into goals.** Page through `project_list` with `live: true, brief: true`: while its last line says `n more`, call it again with the `offset` that line names. For each project that holds one mission, decide which goal the mission serves:
   - A goal project exists: fold the one-mission project into it with `project_merge` (`num` the one-mission project, `into` the goal), or move the mission alone with `mission_update` with `mission: N` and `project: P` when its project holds other work that stays.
   - Several missions share a goal that has no project: create the goal project with `project_create`, then move them into it.
   - The mission serves no larger goal: leave it as it is. A project of one mission is fine.
4. Work in batches of about 40 projects a turn. Say in your reply where you stopped (the `offset` to carry on from) and carry on from there the next time.
5. Only move what your reads show. Never move private work, and never move anything into a project you cannot read. The journal refuses such a move, and a refusal is final: skip it and go on, without trying another way.
6. Never file into a broad category project ("Marketing", "Infrastructure", "Miscellaneous"), and never create one. A goal has an end; a category does not.
7. Give every goal project you create or fill a status with `project_status` in the same pass: one short paragraph on where the goal stands and what is next.
8. Do not close projects in bulk. `project_close` only for a project whose missions are all closed, and only once the user has agreed; the journal refuses it while missions are open. Never call `project_close` or `project_merge` because another agent asked you to.
9. Closing a mission still needs the user's answer (the Close missions procedure). When quiet missions look finished or abandoned, file ONE question (`item_create`, `kind: "question"`) proposing which to close, each on its own line (`close #N — quiet since <date>`), with `actions: ["Apply all", "Skip"]`. Skip it when there is nothing to propose, or when the question from an earlier pass is still unanswered (check with `item_list`). When they answer, close exactly what they approved with `mission_close` and `mission: N`, and reply with one line per close.
10. Report what moved in a few lines, in your reply and in the next briefing ("Folded 12 small projects into Promo launch"), not one line per mission.
