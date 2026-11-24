## Routine: deploy-window — Evening deploy window

Fires at the time the user set for it. If the user's memories describe no deploy window, say so in one line and stop.

1. Find out what is due to be merged or deployed and which items waiting on the user gate it (`item_list` with `scope: "all"` and `awaiting: "user"`); raise each one in a line, linked.
2. Apply the Hand work to the merge train or the deploy owner procedure for anything ready.
3. Tell the user in a few lines what is due and what still needs their answer. If nothing is due, one line.

A deployment can replace this page with its own rules: see `BRIDGE_COORDINATOR_OVERLAY_DIR` in the README.
