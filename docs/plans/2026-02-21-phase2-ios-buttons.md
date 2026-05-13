# Phase 2: Element X iOS — Interactive Buttons Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Port the native interactive buttons feature from element-web to element-x-ios, using the same `com.yearbook.buttons` protocol. Also apply Yearbook Messages branding.

**Architecture:** The bridge sends `com.yearbook.buttons` on m.room.message events. The iOS client detects this field, renders native SwiftUI buttons, and sends `com.yearbook.button_response` messages back. Identical protocol to the web implementation.

**Tech Stack:** Swift/SwiftUI, matrix-rust-sdk

**Prerequisites:** Phase 1 complete (bridge + element-web). Bridge already handles button messages and responses.

**Reference implementation:** element-web-fork `src/components/views/messages/MButtonGroupBody.tsx`

---

## Task 1: Fork and set up element-x-ios

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

**Step 3: Verify build in Xcode**

Open the project, build for simulator, confirm it works unmodified.

**Commit:** None (just verify)

---

## Task 2: Create ButtonGroup timeline item model

**Files:**
- Create: `ElementX/Sources/Services/Timeline/TimelineItems/Items/ButtonGroupRoomTimelineItem.swift`

Follow `PollRoomTimelineItem` pattern. Key types:

```swift
import Foundation

struct YearbookButton: Hashable, Identifiable {
    let id: String
    let label: String
    let value: String
}

enum YearbookButtonMode: String {
    case pickOne = "pick_one"
    case pickMany = "pick_many"
}

struct YearbookButtonsContent: Hashable {
    let mode: YearbookButtonMode
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

    /// Pre-computed from timeline relations — nil if not yet answered
    let answeredValue: String?
}
```

**Commit:** `feat: add ButtonGroupRoomTimelineItem model`

---

## Task 3: Parse button events in timeline item factory

**Files:**
- Modify: `ElementX/Sources/Services/Timeline/TimelineItems/RoomTimelineItemFactory.swift`

Find where `m.room.message` text events are created. Add a check **before** the text message handling:

```swift
// Check for yearbook button content in the raw event JSON
if let buttonsData = content["com.yearbook.buttons"] as? [String: Any],
   let modeStr = buttonsData["mode"] as? String,
   let mode = YearbookButtonMode(rawValue: modeStr),
   let prompt = buttonsData["prompt"] as? String,
   let buttonsArray = buttonsData["buttons"] as? [[String: Any]] {

    let buttons = buttonsArray.compactMap { dict -> YearbookButton? in
        guard let id = dict["id"] as? String,
              let label = dict["label"] as? String,
              let value = dict["value"] as? String else { return nil }
        return YearbookButton(id: id, label: label, value: value)
    }

    guard !buttons.isEmpty else { return nil }

    // Check for existing answer from current user via relations
    var answeredValue: String? = nil
    // (derive from timeline relations — see Task 6)

    return ButtonGroupRoomTimelineItem(
        id: itemId,
        timestamp: timestamp,
        isOutgoing: isOutgoing,
        sender: sender,
        content: YearbookButtonsContent(mode: mode, prompt: prompt, buttons: buttons),
        properties: properties,
        answeredValue: answeredValue
    )
}
```

**Note:** The exact API for accessing raw event content depends on how `EventTimelineItemProxy` exposes the JSON. Check how polls access their content for the pattern.

**Also:** Filter out button response messages from the current user:

```swift
if let isButtonResponse = content["com.yearbook.button_response"] as? Bool,
   isButtonResponse,
   isOutgoing {
    return nil // Hide from sender's timeline
}
```

**Commit:** `feat: parse com.yearbook.buttons in timeline item factory`

---

## Task 4: Create ButtonGroup SwiftUI view

**Files:**
- Create: `ElementX/Sources/Screens/Timeline/View/TimelineItemViews/ButtonGroupRoomTimelineView.swift`

```swift
import SwiftUI

struct ButtonGroupRoomTimelineView: View {
    let timelineItem: ButtonGroupRoomTimelineItem
    @State private var selectedIds: Set<String> = []
    @State private var submitted = false

    let onSendResponse: (String) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(timelineItem.content.prompt)
                .font(.body)

            let buttons = timelineItem.content.buttons
            let mode = timelineItem.content.mode
            let totalLength = buttons.reduce(0) { $0 + $1.label.count }
            let useVertical = buttons.count > 4 || totalLength > 60

            if useVertical {
                VStack(spacing: 8) {
                    ForEach(buttons) { btn in
                        buttonView(btn, mode: mode)
                    }
                }
            } else {
                // Horizontal wrapping layout
                HStack(spacing: 8) {
                    ForEach(buttons) { btn in
                        buttonView(btn, mode: mode)
                    }
                }
            }

            if mode == .pickMany && !submitted {
                Button("Submit") {
                    let values = buttons
                        .filter { selectedIds.contains($0.id) }
                        .map(\.value)
                    guard !values.isEmpty else { return }
                    submitted = true
                    onSendResponse(values.joined(separator: ", "))
                }
                .disabled(selectedIds.isEmpty)
                .buttonStyle(.borderedProminent)
            }

            if mode == .pickMany && submitted {
                Text("Submitted")
                    .font(.caption)
                    .foregroundColor(.secondary)
            }
        }
        .padding(.vertical, 4)
        .onAppear {
            // Derive state from pre-computed answer
            if let answered = timelineItem.answeredValue {
                submitted = true
                let values = answered.components(separatedBy: ", ")
                for btn in timelineItem.content.buttons {
                    if values.contains(btn.value) {
                        selectedIds.insert(btn.id)
                    }
                }
            }
        }
    }

    @ViewBuilder
    private func buttonView(_ btn: YearbookButton, mode: YearbookButtonMode) -> some View {
        let isSelected = selectedIds.contains(btn.id)

        Button {
            if mode == .pickOne {
                selectedIds = [btn.id]
                submitted = true
                onSendResponse(btn.value)
            } else {
                if selectedIds.contains(btn.id) {
                    selectedIds.remove(btn.id)
                } else {
                    selectedIds.insert(btn.id)
                }
            }
        } label: {
            Text(btn.label)
                .padding(.horizontal, 16)
                .padding(.vertical, 8)
                .frame(maxWidth: mode == .pickMany ? .infinity : nil, alignment: .leading)
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

**Commit:** `feat: add ButtonGroupRoomTimelineView SwiftUI component`

---

## Task 5: Wire view into timeline rendering + send action

**Files:**
- Modify: Timeline view switch (likely in `TimelineStyler.swift` or wherever item types are dispatched to views)
- Modify: `TimelineViewModel.swift` (or equivalent) to handle send action

**Step 1:** Add case in the timeline view dispatch:

```swift
case let item as ButtonGroupRoomTimelineItem:
    ButtonGroupRoomTimelineView(
        timelineItem: item,
        onSendResponse: { value in
            context.send(viewAction: .sendButtonResponse(
                value: value,
                originalEventId: item.id.eventID
            ))
        }
    )
```

**Step 2:** Add action enum case:

```swift
case sendButtonResponse(value: String, originalEventId: String)
```

**Step 3:** Handle the action in the view model:

```swift
case .sendButtonResponse(let value, let originalEventId):
    Task {
        // Send as m.room.message with com.yearbook.button_response
        // and m.relates_to pointing to originalEventId
        // Use roomProxy's raw event send API
    }
```

**Note:** Finding the right API for sending raw JSON content is the key challenge. Check how polls send their responses in the existing code.

**Commit:** `feat: wire ButtonGroupRoomTimelineView into timeline and handle send`

---

## Task 6: Derive button state from timeline relations

**Files:**
- Modify: `RoomTimelineItemFactory.swift` (where ButtonGroupRoomTimelineItem is created)

When creating the item, check if the current user already answered:

```swift
// Check for existing button_answer relation from current user
var answeredValue: String? = nil
if let relations = eventItem.relations {
    for relation in relations {
        if relation.sender == ownUserID,
           let content = relation.content,
           content["com.yearbook.button_response"] as? Bool == true {
            answeredValue = content["body"] as? String
            break
        }
    }
}
```

Pass `answeredValue` to the `ButtonGroupRoomTimelineItem` constructor.

**Commit:** `feat: derive button state from timeline relations`

---

## Task 7: Apply Yearbook Messages branding to iOS

This follows the rebrand plan at `docs/plans/2026-02-21-yearbook-messages-rebrand.md` Phase 3 (Tasks 13-17).

Key changes:
- Update `project.yml` and `app.yml` (bundle ID, display name, org name)
- Update Info.plist files
- Update entitlements
- Replace app icons in Assets.xcassets
- Update hardcoded strings in AppSettings.swift

**Commit:** `feat: apply Yearbook Messages branding to iOS`

---

## Task 8: Lock iOS to homeserver

**Files:**
- Find: Where the iOS app configures its default homeserver
- Likely in: `AppSettings.swift` or a config file

Set default homeserver to `https://matrix-dev2.yearbooks.be` and disable server selection (equivalent to `disable_custom_urls` in web).

**Commit:** `feat: lock iOS to Yearbook Messages homeserver`

---

## Task 9: Build and end-to-end test

**Step 1:** Build in Xcode for simulator

**Step 2:** Test:
- Login screen: YM branding, no server picker, username/password only
- Send message that triggers `ask_user` with options
- Verify pick_one buttons render and work
- Verify pick_many buttons toggle and submit
- Verify queue management buttons (Send now / Cancel)
- Verify button responses hidden from sender
- Verify state persists (scroll away and back)
- Verify fallback on stock Element client

**Step 3:** Fix any issues, commit.
