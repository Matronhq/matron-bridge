# Interactive Buttons for Matrix Clients

## Problem

The claude-matrix-bridge currently presents interactive choices (ask_user questions, queue management) as cryptographically signed HTTP links in chat messages. Clicking these opens an external browser, which is clunky. We want native, inline buttons.

## Approach

Add a custom field (`com.yearbook.buttons`) to standard `m.room.message` events. Fork element-web and element-x-ios to detect this field and render native buttons. Pressing a button sends a silent text message back to the room, which the bridge picks up.

## Scope

Three repos to modify:

- **claude-matrix-bridge** — populate `com.yearbook.buttons` on outgoing events, handle `com.yearbook.button_response` on incoming events
- **element-web** (fork) — React component for button rendering, built via element-desktop (Electron wrapper)
- **element-x-ios** (fork) — SwiftUI equivalent

## Message Protocol

### Button message (bridge -> room)

```json
{
  "msgtype": "m.text",
  "body": "Which approach do you prefer?\n\n1. Option A\n2. Option B\n3. Option C",
  "formatted_body": "<p>Which approach do you prefer?</p><ol><li>Option A</li><li>Option B</li><li>Option C</li></ol>",
  "format": "org.matrix.custom.html",
  "com.yearbook.buttons": {
    "mode": "pick_one",
    "prompt": "Which approach do you prefer?",
    "buttons": [
      { "id": "opt_a", "label": "Option A", "value": "Option A" },
      { "id": "opt_b", "label": "Option B", "value": "Option B" },
      { "id": "opt_c", "label": "Option C", "value": "Option C" }
    ]
  }
}
```

### Button response (user -> room)

```json
{
  "msgtype": "m.text",
  "body": "Option A",
  "com.yearbook.button_response": true,
  "m.relates_to": {
    "rel_type": "com.yearbook.button_answer",
    "event_id": "$original_button_message_id"
  }
}
```

For pick_many, the body contains comma-separated values: `"dark_mode, notifications"`.

### Key fields

- `com.yearbook.buttons.mode` — `"pick_one"` or `"pick_many"`
- `com.yearbook.buttons.prompt` — clean question text for modified clients to display (ignoring body/formatted_body entirely)
- `com.yearbook.buttons.buttons[]` — array of `{ id, label, value }`
- `com.yearbook.button_response` — `true` on response messages, signals modified clients to hide from sender's timeline
- `m.relates_to` — links response back to the original button message for state derivation

## Two button modes

### pick_one

- Buttons render below the prompt
- Tapping a button immediately sends its `value` as a silent message
- The pressed button shows a "selected" style, all others grey out, all become non-interactive

### pick_many

- Buttons render as toggleable selections below the prompt
- Tapping toggles selected/unselected state
- A "Submit" button at the bottom sends all selected values as a single comma-separated silent message
- After submission, all buttons lock, selected ones stay highlighted, Submit shows "Submitted"

## Adaptive layout

- **Few short buttons** (4 or fewer, total label length under ~60 chars) — horizontal row
- **Many buttons or long labels** — vertical stack, full-width
- **pick_many** — always vertical stack (toggle states clearer, Submit button at bottom)

## Client rendering

### Modified clients (forked element-web, element-x-ios)

When `com.yearbook.buttons` is present in event content:

1. Render `com.yearbook.buttons.prompt` as the message text
2. Completely ignore `body` and `formatted_body`
3. Render native buttons below the prompt using adaptive layout
4. On button press, send a `com.yearbook.button_response` message via the Matrix send API
5. Hide outgoing `com.yearbook.button_response` messages from the sender's timeline (or show minimal "You selected: X" indicator)

### Unmodified clients

- See the full `body` text with the question and numbered options listed naturally
- Button response messages appear as normal text
- Fully usable, just not interactive

## Button state persistence

State is derived from the timeline, not local storage. The client checks whether a `com.yearbook.button_answer` relation exists for the button message from the current user. If yes, render as already answered. This is consistent across devices and survives logout.

## Bridge changes

### Sending buttons

Where the bridge currently generates signed HTML links (ask_user questions, queue management), it populates `com.yearbook.buttons` instead. The `body` gets a clean human-readable version for unmodified clients.

Two use cases:
1. **ask_user / multiple choice** — Claude asks the user to pick from options
2. **Queue management** — "Send now" / "Cancel" on queued messages (pick_one)

### Receiving responses

The bridge listens for room messages with `com.yearbook.button_response: true`. It matches via `m.relates_to` back to the original prompt, then:
- For ask_user: forwards the value to Claude via the MCP ask endpoint
- For queue actions: maps the value to existing interrupt/cancel logic

### File links unchanged

Signed URL system stays for file viewing — those are read-only links, not interactive choices.

## Backward compatibility

- Unmodified clients see full human-readable body text
- Button responses appear as normal text in unmodified clients
- No changes to Matrix protocol or homeserver required
- Custom field is ignored by clients that don't know about it
