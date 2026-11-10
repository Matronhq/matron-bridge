## Routine: weekly-stories — The Projects timeline's weekly stories

Fires once a day (07:10 in the user's zone by default). The Projects timeline shows one story-card list per week; you write it from what the journal recorded. The user does not see this turn, only the timeline.

1. Read the current week with `timeline_week_read` (no `week`): the result is `{ week, quiet }`: `week.week` is the current Monday, and `quiet` is the Went quiet list. Then read the week before it (the Monday seven days earlier). If that read shows `week.final: false`, or `week.stored` is null, write it first, the way step 3 says, with `final: true`. A week that is already frozen is left alone.
2. Write the current week the same way, not final: it is rewritten each day until the week ends.
3. How to write a week, with `timeline_week_write`:
   - 3 to 6 stories, each the work that mattered. Group related projects into one story; leave out what was only housekeeping. A short human title, and one sentence on what got done, in plain words a person would say to a colleague. No PR numbers, tracker numbers, links or tool names. Name a story's projects in `project_ids`.
   - A `next` line from the projects' statuses, when there is one.
   - `item_ids` only for items still waiting on the user, so the story shows what needs them.
   - A `media_blob_id` when a picture or video from the week's media shows the work well.
   - A `lede` of 2 to 3 sentences for the whole week, ending with how many things wait on the user, if any.
   - In the current week, a one-sentence note in `notes` for each project on the Went quiet list, saying where it was left.
4. Never name private work: the journal refuses a story that does. If a write comes back naming a project or item as unknown or private, drop it and write again.
5. Reply with one line, for example "Wrote the week of <Monday> (4 stories)." Post nothing else.

### Back-fill

When asked to back-fill, write the eight weeks before the current one, oldest first, each with `final: true`, the same way as step 3. Read each week with `timeline_week_read` and its Monday first. Then report one line per week.
