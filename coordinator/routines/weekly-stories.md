## Routine: weekly-stories — The Projects timeline's weekly stories

Fires once a day (07:10 in the user's zone by default). Projects shows one card per project per week; you write them from what the journal recorded. The user does not see this turn, only Projects.

1. Read the current week with `timeline_week_read` (no `week`). The result is text, in this order:
   - On the first page of the current week only, a first line `quiet (n of total): …`: the Went quiet list.
   - A line `week: …`: one page of the week as JSON. `week.week` is the Monday, `week.stored` is what is already written for the week, and `week.projects` is a page of the projects that moved, each with its milestones, its status and its media.
   - A last line that either names the `offset` of the next page or says that is every project that moved this week.

   Call `timeline_week_read` again with the same `week` and the `offset` the last line names, and keep going until the last line says that is every project that moved this week. Read every page of a week before you choose what to write for it. If the last line says the journal cannot page the rest, or a read is refused as too large (carry on from the `offset` it names, if it names one), the week's read was cut short: write from the pages you did read, never with `final: true` (step 2), and say in your reply that the week was cut short.
2. Freeze the weeks before the current one. Read last week (the Monday seven days earlier), every page. If its `week.stored` is null, or `week.stored.final` is false, write it first, the way step 4 says, with `final: true`. Leave it alone only when `week.stored.final` is true (the top-level `week.final` just says the week has ended, so do not go by it). A week whose read was cut short is the exception: write it without `final`, so that it stays unfrozen and a later run, with every page read, can write it whole and freeze it; say so in your reply. Then walk back week by week, at most 10 weeks from last week, and freeze each earlier week that has a `stored` row with `stored.final` false. Stop at the first week that is frozen or has no `stored` row (older unwritten weeks are only written by a rewrite), and stop if the journal says a week is out of range.
3. Write the current week the same way, not final: it is rewritten each day until the week ends.
4. How to write a week, with `timeline_week_write` (`week`, `entries`, and `final` and `notes` when they apply):
   - One entry per project, at most 8: the projects whose week mattered. Leave out a project whose week was only housekeeping. When more than 8 mattered, write the 8 that mattered most; the app lists the others by itself. A week in which nothing mattered is `entries: []`.
   - `project` is the project's id or its number, from `week.projects`.
   - `sentence` is one plain sentence on what got done in that project that week, in words a person would say to a colleague. The project's name is the card's title, so do not repeat it. No PR numbers, tracker numbers, links or tool names.
   - `next` only when the project's status gives a real next step. Leave it out otherwise.
   - `media_blob_id` when a picture or video from that project's media for the week shows the work well.
   - Nothing else. No summary of the whole week, no titles, and no lists of items: the app counts what waits on the user and what got done by itself.
   - In the current week, a one-sentence note in `notes` (`project_id` and `note`) for each project on the Went quiet list, saying where it was left.
5. Never name private work: the journal refuses an entry that does. If a write comes back naming a project as unknown or private, drop that entry and write again.
6. Reply with one line, for example "Wrote the week of <Monday> (4 projects)." When a week's read was cut short, add one more line saying which week and that it was left unfrozen. Post nothing else.

### Rewrite

When asked to rewrite the weeks, go week by week, oldest first, from the oldest week the journal accepts (about ten weeks back) up to the current one.

1. Read the week with `timeline_week_read` passing its Monday, every page, as step 1 says.
2. Rewrite it when its `week.stored` is null or its `stored.legacy` is true (a week written before there was one card per project). Leave any other week as it is.
3. Write it the way step 4 says, with `final: true`, except the current week, which is written not final, and a week whose read was cut short, which is also written not final: say so in its line of the report.
4. If the journal says a week is out of range, skip it and say so.
5. Then report one line per week: rewritten and how many projects, left as it was, or skipped and why.
