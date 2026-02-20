# Interactive Buttons Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add native inline buttons to forked Element clients, replacing the current external-browser signed link approach for interactive choices in the claude-matrix-bridge.

**Architecture:** The bridge populates a `com.yearbook.buttons` custom field on `m.room.message` events. Forked element-web and element-x-ios detect this field and render native buttons. Button presses send silent `com.yearbook.button_response` messages back to the room. The bridge handles these like normal user answers.

**Tech Stack:** Node.js (bridge), React/TypeScript (element-web), Swift/SwiftUI (element-x-ios)

**Design doc:** `docs/plans/2026-02-20-interactive-buttons-design.md`

---

## Phase 1: Bridge + Element Web

### Task 1: Bridge — Add button-aware send helper

**Files:**
- Modify: `/home/danbarker/claude-matrix-bridge/index.js` (near line 1042, the `sendToRoom` function)

**Step 1: Add `sendButtonMessage` function**

Add this function after the existing `sendToRoom` function (around line 1058):

```javascript
async function sendButtonMessage(roomId, prompt, buttons, mode, fallbackBody, fallbackHtml) {
  const content = {
    msgtype: 'm.text',
    body: fallbackBody,
    format: 'org.matrix.custom.html',
    formatted_body: fallbackHtml,
    'com.yearbook.buttons': {
      mode,       // 'pick_one' or 'pick_many'
      prompt,
      buttons,    // [{ id, label, value }]
    },
  };
  try {
    const eventId = await client.sendMessage(roomId, content);
    return eventId || null;
  } catch (e) {
    console.error('Failed to send button message:', e.message);
    return null;
  }
}
```

**Step 2: Commit**

```bash
git add index.js
git commit -m "feat: add sendButtonMessage helper for native button events"
```

---

### Task 2: Bridge — Convert ask_user questions to button messages

**Files:**
- Modify: `/home/danbarker/claude-matrix-bridge/index.js` (lines 293-364, `formatQuestion`, `formatQuestionHtml`, `sendAllQuestions`)

**Step 1: Modify `sendAllQuestions` to use buttons when options exist**

Replace the `sendAllQuestions` function (around line 351) to detect multiple-choice questions and send them as button messages. Keep the existing `formatQuestion`/`formatQuestionHtml` for the fallback body.

```javascript
function sendAllQuestions(session) {
  const questions = session.pendingQuestions;
  if (!questions || questions.length === 0) return;

  const total = questions.length;

  for (let i = 0; i < total; i++) {
    const q = questions[i];
    const plainText = formatQuestion(q, i, total);
    const html = formatQuestionHtml(q, i, total);

    if (q.options && q.options.length > 0 && session.sendButtonMessage) {
      // Build button array from options
      const buttons = q.options.map((opt, idx) => {
        const label = typeof opt.label === 'string' ? opt.label : typeof opt === 'string' ? opt : String(opt);
        const letter = String.fromCharCode(65 + idx);
        return {
          id: `opt_${letter.toLowerCase()}`,
          label: label,
          value: label,
        };
      });

      const prefix = total > 1 ? `Question ${i + 1}/${total}` : '';
      const prompt = prefix
        ? (q.header ? `${prefix} — ${q.header}\n\n${q.question}` : `${prefix}\n\n${q.question}`)
        : (q.header ? `${q.header}\n\n${q.question}` : q.question);

      const mode = q.multiSelect ? 'pick_many' : 'pick_one';
      session.sendButtonMessage(prompt, buttons, mode, plainText, html);
    } else if (session.sendHtml) {
      session.sendHtml(plainText, html);
    } else if (session.sendCallback) {
      session.sendCallback(plainText);
    }
  }
}
```

**Step 2: Wire up `session.sendButtonMessage` callback**

Find where `session.sendCallback` and `session.sendHtml` are assigned (search for `sendHtml =` and `sendCallback =` in session setup). Add a parallel `sendButtonMessage` assignment. It should be near where sessions are created/initialized. The pattern will be:

```javascript
session.sendButtonMessage = (prompt, buttons, mode, plainText, html) =>
  sendButtonMessage(roomId, prompt, buttons, mode, plainText, html);
```

**Step 3: Commit**

```bash
git add index.js
git commit -m "feat: send ask_user questions as native button messages"
```

---

### Task 3: Bridge — Convert queue notifications to button messages

**Files:**
- Modify: `/home/danbarker/claude-matrix-bridge/index.js` (lines 1932-1944, queue notification section)

**Step 1: Replace queue action links with button message**

Find the queue notification block (around line 1932) that currently generates `interruptLink` and `cancelLink`. Replace with:

```javascript
const plainNotif = `📨 Queued (${count}): ${preview}`;
if (session.sendButtonMessage) {
  const buttons = [
    { id: 'cancel', label: '✕ Cancel', value: `cancel:${queueIndex}` },
    { id: 'interrupt', label: '⚡ Send now', value: 'interrupt' },
  ];
  const htmlQueue = escapeHtml(plainNotif);
  const notifEventId = await session.sendButtonMessage(
    plainNotif, buttons, 'pick_one', plainNotif, htmlQueue
  );
  if (notifEventId) session.queueNotifications.push({ eventId: notifEventId, plain: plainNotif });
} else {
  // Fallback to signed links (existing behavior)
  const interruptLink = generateActionLink('interrupt', roomId);
  const cancelLink = generateActionLink('cancel', roomId, { index: queueIndex });
  if (interruptLink || cancelLink) {
    const links = [];
    if (cancelLink) links.push(`<a href="${cancelLink}">✕ Cancel</a>`);
    if (interruptLink) links.push(`<a href="${interruptLink}">⚡ Send now</a>`);
    const htmlQueue = `${escapeHtml(plainNotif)}<br/>${links.join(' · ')}`;
    const notifEventId = await sendHtmlFn(plainNotif, htmlQueue);
    if (notifEventId) session.queueNotifications.push({ eventId: notifEventId, plain: plainNotif });
  } else {
    await sendReply(plainNotif);
  }
}
```

**Step 2: Commit**

```bash
git add index.js
git commit -m "feat: send queue notifications as native button messages"
```

---

### Task 4: Bridge — Handle button response messages

**Files:**
- Modify: `/home/danbarker/claude-matrix-bridge/index.js` (lines 1780-1862, `room.message` handler)

**Step 1: Add button response detection early in the message handler**

Near the top of the `room.message` handler (after the basic validation and before the `waitingForAnswer` check around line 1851), add:

```javascript
// Handle native button responses
if (event.content['com.yearbook.button_response'] === true) {
  const relatesTo = event.content['m.relates_to'];
  const originalEventId = relatesTo?.event_id;
  const value = (event.content.body || '').trim();

  // Check if this is a queue action response
  if (value === 'interrupt') {
    const queued = session.queuedMessages || [];
    session.queuedMessages = null;
    stripQueueNotificationLinks(session);
    if (queued.length > 0) {
      if (session.sendCallback) {
        session.sendCallback(`⚡ Sending ${queued.length} queued message${queued.length > 1 ? 's' : ''} now...`);
      }
      flushQueue(session, queued);
    }
    return;
  }

  const cancelMatch = value.match(/^cancel:(\d+)$/);
  if (cancelMatch) {
    const index = parseInt(cancelMatch[1], 10);
    const queue = session.queuedMessages;
    if (queue && index >= 0 && index < queue.length) {
      queue.splice(index, 1);
      const notifs = session.queueNotifications || [];
      if (index < notifs.length) {
        const { eventId, plain } = notifs.splice(index, 1)[0];
        if (eventId) editMessage(session.roomId, eventId, `✕ ${plain} (cancelled)`);
      }
      if (queue.length === 0) session.queuedMessages = null;
      if (session.sendCallback) {
        const remaining = queue.length;
        session.sendCallback(remaining === 0
          ? '✕ Cancelled queued message (queue empty)'
          : `✕ Cancelled queued message (${remaining} remaining)`);
      }
    }
    return;
  }

  // Otherwise treat as a question answer — fall through to waitingForAnswer handling
  // The value is already the button label, so resolveQuestionAnswer will use it as-is
}
```

**Step 2: Ensure the `waitingForAnswer` block handles button values cleanly**

The existing `resolveQuestionAnswer` function (line 411) tries to parse letter/number answers. Button responses send the actual label as the value, so the function's fallback to `trimmed` (custom text) will handle it correctly. No changes needed.

**Step 3: Commit**

```bash
git add index.js
git commit -m "feat: handle native button response messages from clients"
```

---

### Task 5: Fork element-web and element-desktop

**Step 1: Fork the repos on GitHub**

```bash
gh repo fork element-hq/element-web --clone=false --org yearbook
gh repo fork element-hq/element-desktop --clone=false --org yearbook
```

**Step 2: Clone locally**

```bash
cd /home/danbarker
git clone git@github.com:yearbook/element-web.git element-web-fork
git clone git@github.com:yearbook/element-desktop.git element-desktop-fork
```

**Step 3: Create feature branch**

```bash
cd /home/danbarker/element-web-fork
git checkout -b feat/yearbook-buttons
cd /home/danbarker/element-desktop-fork
git checkout -b feat/yearbook-buttons
```

**Step 4: Install dependencies and verify build**

```bash
cd /home/danbarker/element-web-fork
corepack enable
pnpm install
pnpm build
```

**Step 5: Commit**

No code changes yet — just verify the build works.

---

### Task 6: Element Web — Create ButtonGroup component

**Files:**
- Create: `/home/danbarker/element-web-fork/src/components/views/messages/MButtonGroupBody.tsx`

**Step 1: Create the button group component**

This component renders when `com.yearbook.buttons` is present in the event content. Follow the same patterns as `MPollBody.tsx`.

```tsx
import React, { useCallback, useEffect, useMemo, useState } from "react";
import { MatrixEvent } from "matrix-js-sdk/src/matrix";
import { MatrixClientPeg } from "../../../MatrixClientPeg";

interface YearbookButton {
    id: string;
    label: string;
    value: string;
}

interface YearbookButtons {
    mode: "pick_one" | "pick_many";
    prompt: string;
    buttons: YearbookButton[];
}

interface IProps {
    mxEvent: MatrixEvent;
    getRelationsForEvent?: (
        eventId: string,
        relationType: string,
        eventType: string,
    ) => any;
}

interface IState {
    selectedIds: Set<string>;
    submitted: boolean;
    submittedValue: string | null;
}

export default function MButtonGroupBody({ mxEvent, getRelationsForEvent }: IProps): JSX.Element {
    const content = mxEvent.getContent();
    const buttonsData: YearbookButtons | undefined = content["com.yearbook.buttons"];

    const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
    const [submitted, setSubmitted] = useState(false);
    const [submittedValue, setSubmittedValue] = useState<string | null>(null);

    // Derive state from timeline — check for existing button_answer relation
    useEffect(() => {
        if (!getRelationsForEvent) return;
        const eventId = mxEvent.getId();
        if (!eventId) return;

        const relations = getRelationsForEvent(
            eventId,
            "com.yearbook.button_answer",
            "m.room.message",
        );
        if (!relations) return;

        const myUserId = MatrixClientPeg.safeGet().getUserId();
        const events = relations.getRelations?.() || [];
        for (const ev of events) {
            if (ev.getSender() === myUserId && ev.getContent()?.["com.yearbook.button_response"]) {
                const answeredValue = ev.getContent().body || "";
                setSubmitted(true);
                setSubmittedValue(answeredValue);

                // Reconstruct selected IDs from answered value
                if (buttonsData) {
                    const values = answeredValue.split(", ");
                    const ids = new Set<string>();
                    for (const btn of buttonsData.buttons) {
                        if (values.includes(btn.value)) ids.add(btn.id);
                    }
                    setSelectedIds(ids);
                }
                break;
            }
        }
    }, [mxEvent, getRelationsForEvent, buttonsData]);

    const sendResponse = useCallback(async (value: string) => {
        const cli = MatrixClientPeg.safeGet();
        const roomId = mxEvent.getRoomId();
        const eventId = mxEvent.getId();
        if (!roomId || !eventId) return;

        await cli.sendMessage(roomId, null, {
            msgtype: "m.text",
            body: value,
            "com.yearbook.button_response": true,
            "m.relates_to": {
                rel_type: "com.yearbook.button_answer",
                event_id: eventId,
            },
        });
    }, [mxEvent]);

    const handlePickOne = useCallback((btn: YearbookButton) => {
        if (submitted) return;
        setSelectedIds(new Set([btn.id]));
        setSubmitted(true);
        setSubmittedValue(btn.value);
        sendResponse(btn.value);
    }, [submitted, sendResponse]);

    const handleToggle = useCallback((btn: YearbookButton) => {
        if (submitted) return;
        setSelectedIds(prev => {
            const next = new Set(prev);
            if (next.has(btn.id)) next.delete(btn.id);
            else next.add(btn.id);
            return next;
        });
    }, [submitted]);

    const handleSubmitMany = useCallback(() => {
        if (submitted || !buttonsData) return;
        const selectedValues = buttonsData.buttons
            .filter(btn => selectedIds.has(btn.id))
            .map(btn => btn.value);
        if (selectedValues.length === 0) return;
        const value = selectedValues.join(", ");
        setSubmitted(true);
        setSubmittedValue(value);
        sendResponse(value);
    }, [submitted, buttonsData, selectedIds, sendResponse]);

    if (!buttonsData) return <></>;

    const { mode, prompt, buttons } = buttonsData;

    // Adaptive layout: horizontal if few short buttons, vertical otherwise
    const totalLabelLength = buttons.reduce((sum, b) => sum + b.label.length, 0);
    const useVertical = mode === "pick_many" || buttons.length > 4 || totalLabelLength > 60;

    return (
        <div className="mx_MButtonGroupBody">
            <div className="mx_MButtonGroupBody_prompt">{prompt}</div>
            <div className={`mx_MButtonGroupBody_buttons ${useVertical ? "mx_MButtonGroupBody_vertical" : "mx_MButtonGroupBody_horizontal"}`}>
                {buttons.map(btn => {
                    const isSelected = selectedIds.has(btn.id);
                    let className = "mx_MButtonGroupBody_button";
                    if (isSelected) className += " mx_MButtonGroupBody_button_selected";
                    if (submitted && !isSelected) className += " mx_MButtonGroupBody_button_disabled";
                    if (submitted) className += " mx_MButtonGroupBody_button_submitted";

                    return (
                        <button
                            key={btn.id}
                            className={className}
                            disabled={submitted}
                            onClick={() => mode === "pick_one" ? handlePickOne(btn) : handleToggle(btn)}
                        >
                            {btn.label}
                        </button>
                    );
                })}
            </div>
            {mode === "pick_many" && !submitted && (
                <button
                    className="mx_MButtonGroupBody_submit"
                    disabled={selectedIds.size === 0}
                    onClick={handleSubmitMany}
                >
                    Submit
                </button>
            )}
            {mode === "pick_many" && submitted && (
                <div className="mx_MButtonGroupBody_submitted">Submitted</div>
            )}
        </div>
    );
}
```

**Step 2: Commit**

```bash
cd /home/danbarker/element-web-fork
git add src/components/views/messages/MButtonGroupBody.tsx
git commit -m "feat: add MButtonGroupBody component for native button rendering"
```

---

### Task 7: Element Web — Create button group styles

**Files:**
- Create: `/home/danbarker/element-web-fork/res/css/views/messages/_MButtonGroupBody.pcss`
- Modify: `/home/danbarker/element-web-fork/res/css/_components.pcss` (add import)

**Step 1: Create the stylesheet**

Find the existing poll styles for reference (`res/css/views/messages/_MPollBody.pcss` or similar) and create a parallel file:

```css
.mx_MButtonGroupBody {
    margin-top: 8px;
}

.mx_MButtonGroupBody_prompt {
    margin-bottom: 12px;
    white-space: pre-wrap;
}

.mx_MButtonGroupBody_buttons {
    display: flex;
    gap: 8px;
}

.mx_MButtonGroupBody_horizontal {
    flex-direction: row;
    flex-wrap: wrap;
}

.mx_MButtonGroupBody_vertical {
    flex-direction: column;
}

.mx_MButtonGroupBody_button {
    padding: 8px 16px;
    border: 1px solid var(--cpd-color-border-interactive-primary);
    border-radius: 8px;
    background: var(--cpd-color-bg-canvas-default);
    color: var(--cpd-color-text-primary);
    cursor: pointer;
    font-size: var(--cpd-font-size-body-md);
    text-align: left;
    transition: background 0.15s, border-color 0.15s;
}

.mx_MButtonGroupBody_button:hover:not(:disabled) {
    background: var(--cpd-color-bg-subtle-secondary);
}

.mx_MButtonGroupBody_button_selected {
    background: var(--cpd-color-bg-action-primary-rest);
    color: var(--cpd-color-text-on-solid-primary);
    border-color: var(--cpd-color-bg-action-primary-rest);
}

.mx_MButtonGroupBody_button_disabled {
    opacity: 0.4;
    cursor: default;
}

.mx_MButtonGroupBody_button_submitted {
    cursor: default;
}

.mx_MButtonGroupBody_vertical .mx_MButtonGroupBody_button {
    width: 100%;
}

.mx_MButtonGroupBody_submit {
    margin-top: 8px;
    padding: 8px 24px;
    border: none;
    border-radius: 8px;
    background: var(--cpd-color-bg-action-primary-rest);
    color: var(--cpd-color-text-on-solid-primary);
    cursor: pointer;
    font-size: var(--cpd-font-size-body-md);
    font-weight: 600;
}

.mx_MButtonGroupBody_submit:hover:not(:disabled) {
    background: var(--cpd-color-bg-action-primary-hovered);
}

.mx_MButtonGroupBody_submit:disabled {
    opacity: 0.4;
    cursor: default;
}

.mx_MButtonGroupBody_submitted {
    margin-top: 8px;
    font-size: var(--cpd-font-size-body-sm);
    color: var(--cpd-color-text-secondary);
}
```

**Step 2: Add import to `_components.pcss`**

Find the existing imports in `res/css/_components.pcss` and add alongside the other message component imports:

```css
@import "./views/messages/_MButtonGroupBody.pcss";
```

**Step 3: Commit**

```bash
cd /home/danbarker/element-web-fork
git add res/css/views/messages/_MButtonGroupBody.pcss res/css/_components.pcss
git commit -m "feat: add styles for MButtonGroupBody component"
```

---

### Task 8: Element Web — Integrate into message rendering pipeline

**Files:**
- Modify: `/home/danbarker/element-web-fork/src/components/views/messages/MessageEvent.tsx` (lines 65-80, body type maps)

**Step 1: Understand the rendering approach**

The button data is a custom field on a standard `m.room.message` event, not a separate event type. So we don't add it to `baseEvTypes` or `baseBodyTypes`. Instead, we need to intercept in the `MessageEvent` render method and check for `com.yearbook.buttons` on the event content.

Find the `render()` method in `MessageEvent.tsx`. Before it dispatches to the body component, add a check:

```tsx
// At the top of the file, add import:
import MButtonGroupBody from "./MButtonGroupBody";

// In the render method, before the normal body dispatch:
const content = this.props.mxEvent.getContent();
if (content["com.yearbook.buttons"]) {
    return <MButtonGroupBody
        mxEvent={this.props.mxEvent}
        getRelationsForEvent={this.props.getRelationsForEvent}
    />;
}
```

This intercepts before the normal msgtype-based dispatch, so button messages get the custom component.

**Step 2: Commit**

```bash
cd /home/danbarker/element-web-fork
git add src/components/views/messages/MessageEvent.tsx
git commit -m "feat: wire MButtonGroupBody into message rendering pipeline"
```

---

### Task 9: Element Web — Hide button response messages from sender

**Files:**
- Modify: `/home/danbarker/element-web-fork/src/components/views/rooms/EventTile.tsx` or the timeline filtering logic

**Step 1: Find where timeline events are filtered**

Search for where events are filtered before rendering in the timeline. Look for the `shouldLiveInRoom` or `filterEvents` or similar function that decides what to show. The key location may be in:
- `src/components/structures/TimelinePanel.tsx`
- `src/components/views/rooms/EventTile.tsx`
- `src/events/EventTileFactory.tsx` (the `pickFactory` function)

In the appropriate filter location, add:

```typescript
// Hide button response messages sent by the current user
const content = mxEvent.getContent();
if (content["com.yearbook.button_response"] === true) {
    const myUserId = MatrixClientPeg.safeGet().getUserId();
    if (mxEvent.getSender() === myUserId) {
        return false; // or null, depending on the filter pattern
    }
}
```

**Note:** The exact insertion point depends on the codebase — explore `TimelinePanel.tsx` and `EventTileFactory.tsx` to find the right spot. The `pickFactory` function in `EventTileFactory.tsx` returns `null` for events that shouldn't render, so that may be the cleanest place.

**Step 2: Commit**

```bash
cd /home/danbarker/element-web-fork
git add -A
git commit -m "feat: hide button response messages from sender's timeline"
```

---

### Task 10: Element Web — Build and test

**Step 1: Build element-web**

```bash
cd /home/danbarker/element-web-fork
pnpm build
```

Fix any TypeScript or build errors.

**Step 2: Run dev server and test manually**

```bash
pnpm start
```

Open in browser. Send a test button message to a room using the bridge or a manual Matrix API call (via `curl` or the bridge's `/send` endpoint). Verify:
- Button messages render with native buttons
- pick_one sends immediately on click
- pick_many toggles and submits
- Buttons disable after submission
- Layout adapts (horizontal vs vertical)
- State persists when scrolling away and back

**Step 3: Commit any fixes**

```bash
cd /home/danbarker/element-web-fork
git add -A
git commit -m "fix: address build and rendering issues for button messages"
```

---

### Task 11: Element Desktop — Point to forked element-web

**Files:**
- Modify: `/home/danbarker/element-desktop-fork/package.json` or build config

**Step 1: Configure element-desktop to use forked element-web**

Element Desktop wraps element-web. Check how it references element-web (likely a dependency in `package.json` or a build script that downloads/copies it). Update the reference to point to the forked element-web build output.

The exact mechanism depends on the element-desktop build system — it may use `element.io/packages.json`, a `config.json`, or a direct npm dependency. Explore and adjust.

**Step 2: Build element-desktop**

```bash
cd /home/danbarker/element-desktop-fork
pnpm install
pnpm build
```

**Step 3: Commit**

```bash
cd /home/danbarker/element-desktop-fork
git add -A
git commit -m "feat: point element-desktop to forked element-web with button support"
```

---

### Task 12: End-to-end test Phase 1

**Step 1: Start the bridge with button support**

```bash
cd /home/danbarker/claude-matrix-bridge
npx tsc --declaration false --declarationMap false
node dist/index.js &
```

**Step 2: Open forked element-desktop or element-web dev server**

Send a message to the bridge that triggers an `ask_user` question with multiple choice options. Verify:
- Bridge sends event with `com.yearbook.buttons` field
- Forked client renders native buttons
- Clicking a button sends a `com.yearbook.button_response` message
- Bridge receives the response and forwards to Claude
- Button shows as "selected" after click
- Response message is hidden from sender's timeline

**Step 3: Test queue management**

Send a message while Claude is busy. Verify:
- Queue notification shows with native "Cancel" and "Send now" buttons
- Clicking "Send now" flushes the queue
- Clicking "Cancel" removes the queued message

**Step 4: Test fallback**

Open the same room in an unmodified Matrix client (e.g. the stock Element app or a web client). Verify:
- Button messages show readable fallback text with numbered options
- Button response messages appear as normal text

---

## Phase 2: Element X iOS

### Task 13: Fork element-x-ios

**Step 1: Fork on GitHub**

```bash
gh repo fork element-hq/element-x-ios --clone=false --org yearbook
```

**Step 2: Clone locally**

```bash
git clone git@github.com:yearbook/element-x-ios.git /home/danbarker/element-x-ios-fork
cd /home/danbarker/element-x-ios-fork
git checkout -b feat/yearbook-buttons
```

**Step 3: Open in Xcode and verify it builds**

The project uses Xcode + Swift Package Manager. Open the `.xcodeproj` or `.xcworkspace` file. Build and run on a simulator to verify the base project works before making changes.

---

### Task 14: Element X iOS — Create button timeline item model

**Files:**
- Create: `ElementX/Sources/Services/Timeline/TimelineItems/Items/ButtonGroupRoomTimelineItem.swift`

**Step 1: Create the timeline item model**

Follow the pattern of `PollRoomTimelineItem` (find it in `ElementX/Sources/Services/Timeline/TimelineItems/Items/`):

```swift
import Foundation

struct YearbookButton: Hashable {
    let id: String
    let label: String
    let value: String
}

struct YearbookButtonsContent: Hashable {
    let mode: String  // "pick_one" or "pick_many"
    let prompt: String
    let buttons: [YearbookButton]
}

struct ButtonGroupRoomTimelineItem: EventBasedTimelineItemProtocol {
    let id: TimelineItemIdentifier
    let timestamp: Date
    let isOutgoing: Bool
    let isEditable: Bool = false
    let canBeRepliedTo: Bool = false
    let sender: TimelineItemSender
    let content: YearbookButtonsContent
    var properties: RoomTimelineItemProperties
}
```

**Step 2: Commit**

```bash
cd /home/danbarker/element-x-ios-fork
git add ElementX/Sources/Services/Timeline/TimelineItems/Items/ButtonGroupRoomTimelineItem.swift
git commit -m "feat: add ButtonGroupRoomTimelineItem model"
```

---

### Task 15: Element X iOS — Parse button events in timeline item factory

**Files:**
- Modify: `ElementX/Sources/Services/Timeline/TimelineItems/RoomTimelineItemFactory.swift`

**Step 1: Find where message events are parsed**

Look for the switch/if-else that dispatches on `msgtype` or event content. Add a check for `com.yearbook.buttons` before the normal text message handling:

```swift
// Check for yearbook button content
if let buttonsDict = content["com.yearbook.buttons"] as? [String: Any],
   let mode = buttonsDict["mode"] as? String,
   let prompt = buttonsDict["prompt"] as? String,
   let buttonsArray = buttonsDict["buttons"] as? [[String: Any]] {

    let buttons = buttonsArray.compactMap { dict -> YearbookButton? in
        guard let id = dict["id"] as? String,
              let label = dict["label"] as? String,
              let value = dict["value"] as? String else { return nil }
        return YearbookButton(id: id, label: label, value: value)
    }

    let buttonsContent = YearbookButtonsContent(mode: mode, prompt: prompt, buttons: buttons)
    return ButtonGroupRoomTimelineItem(
        id: itemId,
        timestamp: timestamp,
        isOutgoing: isOutgoing,
        sender: sender,
        content: buttonsContent,
        properties: properties
    )
}
```

**Note:** The exact API for accessing raw event content depends on how matrix-rust-sdk exposes it. The content may come through as a dictionary or require JSON parsing. Explore `EventTimelineItemProxy` to find the right accessor.

**Step 2: Commit**

```bash
cd /home/danbarker/element-x-ios-fork
git add ElementX/Sources/Services/Timeline/TimelineItems/RoomTimelineItemFactory.swift
git commit -m "feat: parse com.yearbook.buttons in timeline item factory"
```

---

### Task 16: Element X iOS — Create button group SwiftUI view

**Files:**
- Create: `ElementX/Sources/Screens/Timeline/View/TimelineItemViews/ButtonGroupRoomTimelineView.swift`

**Step 1: Create the SwiftUI view**

Follow the pattern of `PollRoomTimelineView`:

```swift
import SwiftUI

struct ButtonGroupRoomTimelineView: View {
    let timelineItem: ButtonGroupRoomTimelineItem
    @State private var selectedIds: Set<String> = []
    @State private var submitted = false

    let onPickOne: (String) -> Void    // value
    let onPickMany: ([String]) -> Void  // values

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(timelineItem.content.prompt)
                .font(.body)

            let buttons = timelineItem.content.buttons
            let mode = timelineItem.content.mode
            let totalLength = buttons.reduce(0) { $0 + $1.label.count }
            let useVertical = mode == "pick_many" || buttons.count > 4 || totalLength > 60

            if useVertical {
                VStack(spacing: 8) {
                    ForEach(buttons, id: \.id) { btn in
                        buttonView(btn, mode: mode)
                    }
                }
            } else {
                FlowLayout(spacing: 8) {
                    ForEach(buttons, id: \.id) { btn in
                        buttonView(btn, mode: mode)
                    }
                }
            }

            if mode == "pick_many" && !submitted {
                Button("Submit") {
                    let values = buttons
                        .filter { selectedIds.contains($0.id) }
                        .map(\.value)
                    submitted = true
                    onPickMany(values)
                }
                .disabled(selectedIds.isEmpty)
                .buttonStyle(.borderedProminent)
            }

            if mode == "pick_many" && submitted {
                Text("Submitted")
                    .font(.caption)
                    .foregroundColor(.secondary)
            }
        }
        .padding(.vertical, 4)
    }

    @ViewBuilder
    private func buttonView(_ btn: YearbookButton, mode: String) -> some View {
        let isSelected = selectedIds.contains(btn.id)

        Button {
            if mode == "pick_one" {
                selectedIds = [btn.id]
                submitted = true
                onPickOne(btn.value)
            } else {
                if selectedIds.contains(btn.id) {
                    selectedIds.remove(btn.id)
                } else {
                    selectedIds.insert(btn.id)
                }
            }
        } label: {
            Text(btn.label)
                .frame(maxWidth: mode == "pick_many" || btn.label.count > 15 ? .infinity : nil, alignment: .leading)
                .padding(.horizontal, 16)
                .padding(.vertical, 8)
                .background(isSelected ? Color.accentColor : Color(.systemGray6))
                .foregroundColor(isSelected ? .white : .primary)
                .cornerRadius(8)
                .overlay(
                    RoundedRectangle(cornerRadius: 8)
                        .stroke(Color.accentColor, lineWidth: isSelected ? 0 : 1)
                )
        }
        .disabled(submitted)
        .opacity(submitted && !isSelected ? 0.4 : 1.0)
    }
}
```

**Step 2: Commit**

```bash
cd /home/danbarker/element-x-ios-fork
git add ElementX/Sources/Screens/Timeline/View/TimelineItemViews/ButtonGroupRoomTimelineView.swift
git commit -m "feat: add ButtonGroupRoomTimelineView SwiftUI component"
```

---

### Task 17: Element X iOS — Wire view into timeline rendering

**Files:**
- Modify: `ElementX/Sources/Screens/Timeline/View/Style/TimelineStyler.swift` (or wherever timeline items are switched to views)
- Modify: `ElementX/Sources/Screens/Timeline/TimelineViewModel.swift` (to handle button actions)

**Step 1: Add case for ButtonGroupRoomTimelineItem in the timeline view switch**

Find the switch statement (or if-else chain) that maps timeline item types to views. Add:

```swift
case let item as ButtonGroupRoomTimelineItem:
    ButtonGroupRoomTimelineView(
        timelineItem: item,
        onPickOne: { value in
            context.send(viewAction: .sendButtonResponse(
                value: value,
                originalEventId: item.id.eventID
            ))
        },
        onPickMany: { values in
            context.send(viewAction: .sendButtonResponse(
                value: values.joined(separator: ", "),
                originalEventId: item.id.eventID
            ))
        }
    )
```

**Step 2: Add action case in TimelineViewModel**

Find the `TimelineViewAction` enum and add:

```swift
case sendButtonResponse(value: String, originalEventId: String)
```

In the `TimelineViewModel`'s action handler, add:

```swift
case .sendButtonResponse(let value, let originalEventId):
    Task {
        let content: [String: Any] = [
            "msgtype": "m.text",
            "body": value,
            "com.yearbook.button_response": true,
            "m.relates_to": [
                "rel_type": "com.yearbook.button_answer",
                "event_id": originalEventId,
            ]
        ]
        // Use the room proxy to send a raw event
        await roomProxy.sendMessageEvent(content: content)
    }
```

**Note:** The exact API for sending raw events depends on how `RoomProxy` exposes matrix-rust-sdk's send functionality. Explore `RoomProxy.swift` to find the right method — it may be `sendMessageEventContent` or similar.

**Step 3: Commit**

```bash
cd /home/danbarker/element-x-ios-fork
git add -A
git commit -m "feat: wire ButtonGroupRoomTimelineView into timeline and handle actions"
```

---

### Task 18: Element X iOS — Hide button responses from sender

**Files:**
- Modify: `ElementX/Sources/Services/Timeline/TimelineItems/RoomTimelineItemFactory.swift`

**Step 1: Filter out button response events from the current user**

In the factory, before creating a timeline item for a text message, check:

```swift
if let isButtonResponse = content["com.yearbook.button_response"] as? Bool,
   isButtonResponse,
   isOutgoing {
    return nil  // Hide from timeline
}
```

This returns nil (skips rendering) for button response messages sent by the current user.

**Step 2: Commit**

```bash
cd /home/danbarker/element-x-ios-fork
git add ElementX/Sources/Services/Timeline/TimelineItems/RoomTimelineItemFactory.swift
git commit -m "feat: hide button response messages from sender's timeline"
```

---

### Task 19: Element X iOS — Derive button state from timeline

**Files:**
- Modify: `ElementX/Sources/Screens/Timeline/View/TimelineItemViews/ButtonGroupRoomTimelineView.swift`
- Modify: `ElementX/Sources/Services/Timeline/TimelineItems/Items/ButtonGroupRoomTimelineItem.swift`

**Step 1: Add answered state to the model**

Extend `ButtonGroupRoomTimelineItem` to carry pre-computed answer state:

```swift
struct ButtonGroupRoomTimelineItem: EventBasedTimelineItemProtocol {
    // ... existing fields ...
    let answeredValue: String?  // nil if not yet answered
}
```

**Step 2: Populate in factory**

When creating the item in `RoomTimelineItemFactory`, check related events for a button_answer from the current user:

```swift
// After creating buttonsContent, before returning:
var answeredValue: String? = nil
// Check relations for existing answer
if let relations = timelineItem.relations {
    for relation in relations {
        if relation.sender == currentUserId,
           let content = relation.content,
           content["com.yearbook.button_response"] as? Bool == true {
            answeredValue = content["body"] as? String
            break
        }
    }
}
```

**Step 3: Use in view**

Update `ButtonGroupRoomTimelineView` to initialize `selectedIds` and `submitted` from `timelineItem.answeredValue`:

```swift
.onAppear {
    if let answered = timelineItem.answeredValue {
        submitted = true
        let values = answered.split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) }
        for btn in timelineItem.content.buttons {
            if values.contains(btn.value) {
                selectedIds.insert(btn.id)
            }
        }
    }
}
```

**Step 4: Commit**

```bash
cd /home/danbarker/element-x-ios-fork
git add -A
git commit -m "feat: derive button state from timeline relations"
```

---

### Task 20: Element X iOS — Build and test

**Step 1: Build in Xcode**

Open the project, build for simulator, fix any compile errors.

**Step 2: Test on simulator**

Connect to the same Matrix homeserver as the bridge. Send messages that trigger ask_user questions and queue notifications. Verify the same behavior as tested in Phase 1 Task 12.

**Step 3: Commit any fixes**

```bash
cd /home/danbarker/element-x-ios-fork
git add -A
git commit -m "fix: address build and rendering issues for iOS button messages"
```

---

### Task 21: End-to-end test Phase 2

Same tests as Task 12, but on the iOS app:
- ask_user questions render as native buttons
- pick_one sends immediately
- pick_many toggles and submits
- Queue management buttons work
- Button responses hidden from sender
- State persists (derived from timeline)
- Fallback works on unmodified clients
