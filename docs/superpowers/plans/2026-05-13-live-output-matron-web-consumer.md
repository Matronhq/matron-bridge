# Live Output Renderer for matron-web Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the missing client-side renderer in matron-web that consumes `chat.matron.live_output.v1` Matrix events and displays a live-streaming command-output tile, and bump the bridge's TTL default from 4 h to 24 h.

**Architecture:** A new React function component (`MLiveOutputBody`) opens a WebSocket directly to the bridge's `/live/ws` endpoint and streams JSON frames (`{type:"data",chunk}` and `{type:"complete",…}`) into a styled `<pre>`. Wired into matron-web via two integration points (`EventTileFactory` + `MessageEvent`) that mirror the existing `MATRON_BUTTONS` pattern. The bridge is unchanged except for a single default-literal bump.

**Tech Stack:** TypeScript, React 18+ (function components + hooks), jest via nx, jest-matrix-react testing, PostCSS, hand-rolled WebSocket mock in tests (no new test dependency).

**Spec:** [`docs/superpowers/specs/2026-05-13-live-output-matron-web-consumer-design.md`](../specs/2026-05-13-live-output-matron-web-consumer-design.md)

**Two branches:**

- matron-web: `feat/live-output-renderer` (off `matron-ui-divergence`)
- claude-matrix-bridge: `chore/bump-live-output-ttl` (off `master`)

---

## Phase 0 — Workspace setup

### Task 0.1: Branch matron-web

**Files:** none

- [ ] **Step 1: Confirm matron-ui-divergence is clean and at the expected base**

Run:
```bash
cd /Users/danbarker/Dev/matron-web
git fetch origin
git status -s
git log -1 --format='%h %s' matron-ui-divergence
```

Expected: empty working tree, `matron-ui-divergence` checked out (or switchable). If anything else is open, stash or resolve before continuing.

- [ ] **Step 2: Create the feature branch**

Run:
```bash
cd /Users/danbarker/Dev/matron-web
git checkout matron-ui-divergence
git checkout -b feat/live-output-renderer
git branch --show-current
```

Expected: `feat/live-output-renderer`.

### Task 0.2: Branch claude-matrix-bridge

**Files:** none

- [ ] **Step 1: Create the bridge branch off master**

Run:
```bash
cd /Users/danbarker/Dev/claude-matrix-bridge
git fetch origin
git checkout master
git pull --ff-only
git checkout -b chore/bump-live-output-ttl
```

Expected: branch `chore/bump-live-output-ttl` created, working tree clean.

---

## Phase 1 — Event type constants

### Task 1.1: Add the two new constants to EventTypes.ts

**Files:**
- Modify: `/Users/danbarker/Dev/matron-web/src/matron/EventTypes.ts`

- [ ] **Step 1: Open the file and add two exports below the existing ones**

Edit `src/matron/EventTypes.ts`. Add after the existing `MATRON_COMMANDS` line:

```ts
export const MATRON_LIVE_OUTPUT_EVENT_TYPE = "chat.matron.live_output.v1";
export const MATRON_LIVE_OUTPUT_CONTENT_KEY = "chat.matron.live_output";
```

Final file should look like:

```ts
/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

export const MATRON_BUTTONS = "chat.matron.buttons";
export const MATRON_BUTTON_RESPONSE = "chat.matron.button_response";
export const MATRON_BUTTON_ANSWER = "chat.matron.button_answer";
export const MATRON_COMMANDS = "chat.matron.commands";
export const MATRON_LIVE_OUTPUT_EVENT_TYPE = "chat.matron.live_output.v1";
export const MATRON_LIVE_OUTPUT_CONTENT_KEY = "chat.matron.live_output";
```

- [ ] **Step 2: Verify TypeScript compiles**

Run:
```bash
cd /Users/danbarker/Dev/matron-web
pnpm exec tsc --noEmit -p src 2>&1 | head -20
```

Expected: no errors related to the new constants. (Some unrelated warnings in the repo are pre-existing — only care about new errors.)

- [ ] **Step 3: Commit**

```bash
cd /Users/danbarker/Dev/matron-web
git add src/matron/EventTypes.ts
git commit -m "Add Matron live-output event type constants"
```

---

## Phase 2 — Skeleton component (renders nothing dynamic yet)

We build the component shell first (no WS, no state machine) so the routing can be tested end-to-end before adding networking.

### Task 2.1: Create MLiveOutputBody skeleton + first test

**Files:**
- Create: `/Users/danbarker/Dev/matron-web/src/components/views/messages/MLiveOutputBody.tsx`
- Create: `/Users/danbarker/Dev/matron-web/test/unit-tests/components/views/messages/MLiveOutputBody-test.tsx`

- [ ] **Step 1: Write the failing skeleton test**

Create `test/unit-tests/components/views/messages/MLiveOutputBody-test.tsx`:

```tsx
/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

import React from "react";
import { render } from "jest-matrix-react";
import { MatrixEvent } from "matrix-js-sdk/src/matrix";

import MLiveOutputBody from "../../../../../src/components/views/messages/MLiveOutputBody";
import {
    MATRON_LIVE_OUTPUT_EVENT_TYPE,
    MATRON_LIVE_OUTPUT_CONTENT_KEY,
} from "../../../../../src/matron/EventTypes";

function makeLiveOutputEvent(overrides: Record<string, any> = {}) {
    const expires_at = overrides.expires_at ?? Math.floor(Date.now() / 1000) + 3600;
    return new MatrixEvent({
        type: MATRON_LIVE_OUTPUT_EVENT_TYPE,
        sender: "@user:server",
        room_id: "!room:server",
        event_id: "$evt1",
        origin_server_ts: Date.now(),
        content: {
            msgtype: "m.text",
            body: "$ ls -la\n[live output: https://viewer.example/live?token=abc]",
            [MATRON_LIVE_OUTPUT_CONTENT_KEY]: {
                tool_use_id: "toolu_01",
                command: "ls -la",
                viewer_url: "https://viewer.example/live?token=abc",
                expires_at,
            },
        },
    });
}

describe("<MLiveOutputBody/>", () => {
    it("renders the command in the header", () => {
        const { getByText } = render(<MLiveOutputBody mxEvent={makeLiveOutputEvent()} />);
        expect(getByText("$ ls -la")).toBeInTheDocument();
    });
});
```

- [ ] **Step 2: Run the test, confirm it fails**

Run:
```bash
cd /Users/danbarker/Dev/matron-web
pnpm exec jest test/unit-tests/components/views/messages/MLiveOutputBody-test.tsx 2>&1 | tail -20
```

Expected: FAIL — `Cannot find module '.../MLiveOutputBody'`.

- [ ] **Step 3: Write the minimal component**

Create `src/components/views/messages/MLiveOutputBody.tsx`:

```tsx
/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

import React from "react";
import { type MatrixEvent } from "matrix-js-sdk/src/matrix";

import { MATRON_LIVE_OUTPUT_CONTENT_KEY } from "../../../matron/EventTypes";

interface IProps {
    mxEvent: MatrixEvent;
}

interface LiveOutputContent {
    tool_use_id: string;
    command: string;
    viewer_url: string;
    expires_at: number;
}

const MLiveOutputBody: React.FC<IProps> = ({ mxEvent }) => {
    const content = mxEvent.getContent()[MATRON_LIVE_OUTPUT_CONTENT_KEY] as LiveOutputContent | undefined;
    if (!content) return null;
    return (
        <div className="mx_MLiveOutputBody">
            <header className="mx_MLiveOutputBody_header">
                <code className="mx_MLiveOutputBody_cmd">$ {content.command}</code>
            </header>
        </div>
    );
};

export default MLiveOutputBody;
```

- [ ] **Step 4: Run the test, confirm it passes**

Run:
```bash
cd /Users/danbarker/Dev/matron-web
pnpm exec jest test/unit-tests/components/views/messages/MLiveOutputBody-test.tsx 2>&1 | tail -10
```

Expected: PASS, 1 test.

- [ ] **Step 5: Commit**

```bash
cd /Users/danbarker/Dev/matron-web
git add src/components/views/messages/MLiveOutputBody.tsx \
        test/unit-tests/components/views/messages/MLiveOutputBody-test.tsx
git commit -m "Add MLiveOutputBody component skeleton"
```

### Task 2.2: Route the custom event type through EventTileFactory

**Files:**
- Modify: `/Users/danbarker/Dev/matron-web/src/events/EventTileFactory.tsx`

- [ ] **Step 1: Add the import**

In `src/events/EventTileFactory.tsx`, find the existing line:

```ts
import { MATRON_BUTTON_RESPONSE } from "../matron/EventTypes";
```

Change it to:

```ts
import { MATRON_BUTTON_RESPONSE, MATRON_LIVE_OUTPUT_EVENT_TYPE } from "../matron/EventTypes";
```

- [ ] **Step 2: Register the event type in EVENT_TILE_TYPES**

Find the `EVENT_TILE_TYPES` map (around line 105):

```ts
const EVENT_TILE_TYPES = new Map<string, Factory>([
    [EventType.RoomMessage, MessageEventFactory],
    [EventType.Sticker, MessageEventFactory],
    [M_POLL_START.name, MessageEventFactory],
    [M_POLL_START.altName, MessageEventFactory],
    [M_POLL_END.name, MessageEventFactory],
    [M_POLL_END.altName, MessageEventFactory],
]);
```

Add a row for the live-output type:

```ts
const EVENT_TILE_TYPES = new Map<string, Factory>([
    [EventType.RoomMessage, MessageEventFactory],
    [EventType.Sticker, MessageEventFactory],
    [M_POLL_START.name, MessageEventFactory],
    [M_POLL_START.altName, MessageEventFactory],
    [M_POLL_END.name, MessageEventFactory],
    [M_POLL_END.altName, MessageEventFactory],
    [MATRON_LIVE_OUTPUT_EVENT_TYPE, MessageEventFactory],
]);
```

- [ ] **Step 3: TS check**

Run:
```bash
cd /Users/danbarker/Dev/matron-web
pnpm exec tsc --noEmit -p src 2>&1 | grep "EventTileFactory" | head -5
```

Expected: no errors in `EventTileFactory.tsx`.

- [ ] **Step 4: Commit**

```bash
cd /Users/danbarker/Dev/matron-web
git add src/events/EventTileFactory.tsx
git commit -m "Route chat.matron.live_output.v1 through MessageEvent"
```

### Task 2.3: Dispatch the content key in MessageEvent.render()

**Files:**
- Modify: `/Users/danbarker/Dev/matron-web/src/components/views/messages/MessageEvent.tsx`

- [ ] **Step 1: Add imports**

Find the existing line in `MessageEvent.tsx`:

```ts
import { MATRON_BUTTONS } from "../../../matron/EventTypes";
```

Change to:

```ts
import { MATRON_BUTTONS, MATRON_LIVE_OUTPUT_CONTENT_KEY } from "../../../matron/EventTypes";
```

Add the component import near the top of the imports block (group with other `M*Body` imports):

```ts
import MLiveOutputBody from "./MLiveOutputBody";
```

- [ ] **Step 2: Add the dispatch branch**

In `MessageEvent.render()`, find the existing buttons check (around line 251):

```tsx
if (!this.props.mxEvent.isRedacted() && content[MATRON_BUTTONS]) {
    return (
        <MButtonGroupBody mxEvent={this.props.mxEvent} getRelationsForEvent={this.props.getRelationsForEvent} />
    );
}
```

Add an analogous branch immediately after it:

```tsx
if (!this.props.mxEvent.isRedacted() && content[MATRON_LIVE_OUTPUT_CONTENT_KEY]) {
    return <MLiveOutputBody mxEvent={this.props.mxEvent} />;
}
```

- [ ] **Step 3: Write a routing test in MessageEvent-test.tsx**

Open `test/unit-tests/components/views/messages/MessageEvent-test.tsx`. Add this mock alongside the existing component mocks at the top of the file:

```ts
jest.mock("../../../../../src/components/views/messages/MLiveOutputBody", () => ({
    __esModule: true,
    default: () => <div data-testid="live-output-body" />,
}));
```

Add a test inside the main `describe` block (the test file already has many test cases — append one):

```tsx
it("dispatches to MLiveOutputBody when content has the live-output key", () => {
    const event = mkEvent({
        event: true,
        type: "chat.matron.live_output.v1",
        user: "@user:server",
        room: "!room:server",
        content: {
            msgtype: "m.text",
            body: "$ ls\n[live output: https://example/live?token=x]",
            "chat.matron.live_output": {
                tool_use_id: "toolu_1",
                command: "ls",
                viewer_url: "https://example/live?token=x",
                expires_at: Math.floor(Date.now() / 1000) + 600,
            },
        },
    });
    const { getByTestId } = render(<MessageEvent mxEvent={event} />);
    expect(getByTestId("live-output-body")).toBeInTheDocument();
});
```

Note: the existing test file already has helpers (`mkEvent`, `mkRoom`, `stubClient`) imported and a client set up via `beforeEach`. Reuse those — don't duplicate setup. If `MessageEvent` requires additional props in the existing test pattern, supply them the same way the surrounding tests do.

- [ ] **Step 4: Run the routing test**

Run:
```bash
cd /Users/danbarker/Dev/matron-web
pnpm exec jest test/unit-tests/components/views/messages/MessageEvent-test.tsx 2>&1 | tail -10
```

Expected: all existing tests still pass, plus the new one.

- [ ] **Step 5: Commit**

```bash
cd /Users/danbarker/Dev/matron-web
git add src/components/views/messages/MessageEvent.tsx \
        test/unit-tests/components/views/messages/MessageEvent-test.tsx
git commit -m "Dispatch chat.matron.live_output content key to MLiveOutputBody"
```

---

## Phase 3 — WebSocket lifecycle

The component needs to open a WS to the bridge's `/live/ws`, dispatch on the all-JSON frame protocol (`{type:"data",chunk}` / `{type:"complete",…}`), and handle close/error.

### Task 3.1: Add a hand-rolled WebSocket mock helper for tests

**Files:**
- Create: `/Users/danbarker/Dev/matron-web/test/unit-tests/components/views/messages/__mocks__/MockWebSocket.ts`

- [ ] **Step 1: Create the mock**

```ts
/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

export class MockWebSocket {
    public static instances: MockWebSocket[] = [];
    public static last(): MockWebSocket {
        return MockWebSocket.instances[MockWebSocket.instances.length - 1];
    }
    public static reset(): void {
        MockWebSocket.instances = [];
    }

    public readyState: number = WebSocket.CONNECTING;
    public url: string;
    public onopen: ((ev: Event) => void) | null = null;
    public onmessage: ((ev: MessageEvent) => void) | null = null;
    public onclose: ((ev: CloseEvent) => void) | null = null;
    public onerror: ((ev: Event) => void) | null = null;

    public constructor(url: string) {
        this.url = url;
        MockWebSocket.instances.push(this);
    }

    public close(code?: number, reason?: string): void {
        this.readyState = WebSocket.CLOSED;
        this.onclose?.({ code: code ?? 1000, reason: reason ?? "", wasClean: true } as CloseEvent);
    }

    public send(_data: string): void {
        // Client-to-server send is not used by MLiveOutputBody. No-op.
    }

    // Test helpers (driven from the test body)
    public _open(): void {
        this.readyState = WebSocket.OPEN;
        this.onopen?.({} as Event);
    }
    public _message(data: unknown): void {
        const payload = typeof data === "string" ? data : JSON.stringify(data);
        this.onmessage?.({ data: payload } as MessageEvent);
    }
    public _close(code = 1000, reason = ""): void {
        this.readyState = WebSocket.CLOSED;
        this.onclose?.({ code, reason, wasClean: code === 1000 } as CloseEvent);
    }
    public _error(): void {
        this.onerror?.({} as Event);
    }
}

export function installMockWebSocket(): void {
    MockWebSocket.reset();
    (globalThis as any).WebSocket = MockWebSocket;
}

export function restoreWebSocket(original: typeof WebSocket): void {
    (globalThis as any).WebSocket = original;
}
```

- [ ] **Step 2: Commit**

```bash
cd /Users/danbarker/Dev/matron-web
git add test/unit-tests/components/views/messages/__mocks__/MockWebSocket.ts
git commit -m "Add hand-rolled WebSocket test mock"
```

### Task 3.2: Test + implement WS open → status running

**Files:**
- Modify: `/Users/danbarker/Dev/matron-web/test/unit-tests/components/views/messages/MLiveOutputBody-test.tsx`
- Modify: `/Users/danbarker/Dev/matron-web/src/components/views/messages/MLiveOutputBody.tsx`

- [ ] **Step 1: Extend the test file**

Add `installMockWebSocket`, `restoreWebSocket`, `MockWebSocket` imports and a `beforeEach`/`afterEach` block at the top of the `describe` block:

```ts
import { MockWebSocket, installMockWebSocket, restoreWebSocket } from "./__mocks__/MockWebSocket";

describe("<MLiveOutputBody/>", () => {
    const realWebSocket = globalThis.WebSocket;
    beforeEach(() => installMockWebSocket());
    afterEach(() => restoreWebSocket(realWebSocket));

    // existing test stays here
```

Then add a new test inside the same `describe`:

```ts
it("opens a WebSocket to the live-output endpoint and shows 'running…' once open", () => {
    const { getByText } = render(<MLiveOutputBody mxEvent={makeLiveOutputEvent()} />);
    const ws = MockWebSocket.last();
    expect(ws.url).toBe("wss://viewer.example/live/ws?token=abc");
    ws._open();
    expect(getByText("running…")).toBeInTheDocument();
});
```

- [ ] **Step 2: Run the test, confirm it fails**

Run:
```bash
cd /Users/danbarker/Dev/matron-web
pnpm exec jest test/unit-tests/components/views/messages/MLiveOutputBody-test.tsx 2>&1 | tail -15
```

Expected: FAIL — `MockWebSocket.last()` undefined or `'running…'` not in document.

- [ ] **Step 3: Implement the WS open + status state**

Replace `src/components/views/messages/MLiveOutputBody.tsx` with:

```tsx
/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

import React, { useEffect, useRef, useState } from "react";
import { type MatrixEvent } from "matrix-js-sdk/src/matrix";

import { MATRON_LIVE_OUTPUT_CONTENT_KEY } from "../../../matron/EventTypes";

interface IProps {
    mxEvent: MatrixEvent;
}

interface LiveOutputContent {
    tool_use_id: string;
    command: string;
    viewer_url: string;
    expires_at: number;
}

type Status = "connecting" | "running" | "complete" | "expired" | "denied" | "error";

function viewerUrlToWsUrl(viewerUrl: string): string {
    // http(s)://host/live?token=… -> ws(s)://host/live/ws?token=…
    const wsScheme = viewerUrl.replace(/^http/, "ws");
    return wsScheme.replace(/\/live(\?|$)/, "/live/ws$1");
}

function statusLabel(status: Status, exitCode: number | null, truncated: boolean): string {
    switch (status) {
        case "connecting": return "connecting…";
        case "running":    return "running…";
        case "complete":
            if (exitCode === 0) return truncated ? "✓ exit 0 · truncated" : "✓ exit 0";
            return `✗ exit ${exitCode ?? "?"}`;
        case "denied":     return "not executed";
        case "expired":    return "expired";
        case "error":      return "⚠ disconnected";
    }
}

const MLiveOutputBody: React.FC<IProps> = ({ mxEvent }) => {
    const content = mxEvent.getContent()[MATRON_LIVE_OUTPUT_CONTENT_KEY] as LiveOutputContent | undefined;
    const [status, setStatus] = useState<Status>("connecting");
    const [exitCode] = useState<number | null>(null);
    const [truncated] = useState(false);

    useEffect(() => {
        if (!content) return;
        const ws = new WebSocket(viewerUrlToWsUrl(content.viewer_url));
        ws.onopen = () => setStatus("running");
        return () => {
            try { ws.close(); } catch { /* noop */ }
        };
    }, [content?.viewer_url]);

    if (!content) return null;

    return (
        <div className="mx_MLiveOutputBody" data-status={status}>
            <header className="mx_MLiveOutputBody_header">
                <code className="mx_MLiveOutputBody_cmd">$ {content.command}</code>
                <span className="mx_MLiveOutputBody_status">{statusLabel(status, exitCode, truncated)}</span>
            </header>
        </div>
    );
};

export default MLiveOutputBody;
```

- [ ] **Step 4: Run the tests, confirm they pass**

Run:
```bash
cd /Users/danbarker/Dev/matron-web
pnpm exec jest test/unit-tests/components/views/messages/MLiveOutputBody-test.tsx 2>&1 | tail -15
```

Expected: 2 PASS.

- [ ] **Step 5: Commit**

```bash
cd /Users/danbarker/Dev/matron-web
git add src/components/views/messages/MLiveOutputBody.tsx \
        test/unit-tests/components/views/messages/MLiveOutputBody-test.tsx
git commit -m "Open WebSocket and surface 'running' status"
```

### Task 3.3: Test + implement `data` frame handling

**Files:**
- Modify: `/Users/danbarker/Dev/matron-web/test/unit-tests/components/views/messages/MLiveOutputBody-test.tsx`
- Modify: `/Users/danbarker/Dev/matron-web/src/components/views/messages/MLiveOutputBody.tsx`

- [ ] **Step 1: Add the test**

Inside the same `describe`:

```ts
it("appends streamed data chunks into the pre", () => {
    const { getByText, container } = render(<MLiveOutputBody mxEvent={makeLiveOutputEvent()} />);
    const ws = MockWebSocket.last();
    ws._open();
    ws._message({ type: "data", chunk: "hello\n" });
    ws._message({ type: "data", chunk: "world\n" });
    const pre = container.querySelector(".mx_MLiveOutputBody_output");
    expect(pre?.textContent).toContain("hello");
    expect(pre?.textContent).toContain("world");
    expect(getByText("running…")).toBeInTheDocument();
});
```

- [ ] **Step 2: Run, confirm it fails**

Run:
```bash
cd /Users/danbarker/Dev/matron-web
pnpm exec jest test/unit-tests/components/views/messages/MLiveOutputBody-test.tsx 2>&1 | tail -15
```

Expected: FAIL — `.mx_MLiveOutputBody_output` element not in DOM.

- [ ] **Step 3: Implement data-frame handling**

Update `src/components/views/messages/MLiveOutputBody.tsx`. Add `output` state and the `onmessage` handler that dispatches on `frame.type`:

Replace the existing component body with:

```tsx
const MLiveOutputBody: React.FC<IProps> = ({ mxEvent }) => {
    const content = mxEvent.getContent()[MATRON_LIVE_OUTPUT_CONTENT_KEY] as LiveOutputContent | undefined;
    const [status, setStatus] = useState<Status>("connecting");
    const [exitCode, setExitCode] = useState<number | null>(null);
    const [truncated, setTruncated] = useState(false);
    const [output, setOutput] = useState<string>("");

    useEffect(() => {
        if (!content) return;
        const ws = new WebSocket(viewerUrlToWsUrl(content.viewer_url));
        ws.onopen = () => setStatus("running");
        ws.onmessage = (ev: MessageEvent) => {
            let frame: any;
            try { frame = JSON.parse(ev.data); }
            catch { console.warn("MLiveOutputBody: malformed frame", ev.data); return; }
            if (frame.type === "data" && typeof frame.chunk === "string") {
                setOutput(o => o + frame.chunk);
            } else if (frame.type === "complete") {
                setExitCode(frame.exitCode ?? null);
                setTruncated(!!frame.truncated);
                setStatus(frame.denied ? "denied" : "complete");
            }
        };
        return () => {
            try { ws.close(); } catch { /* noop */ }
        };
    }, [content?.viewer_url]);

    if (!content) return null;

    return (
        <div className="mx_MLiveOutputBody" data-status={status}>
            <header className="mx_MLiveOutputBody_header">
                <code className="mx_MLiveOutputBody_cmd">$ {content.command}</code>
                <span className="mx_MLiveOutputBody_status">{statusLabel(status, exitCode, truncated)}</span>
            </header>
            {status !== "expired" && status !== "denied" && (
                <pre className="mx_MLiveOutputBody_output">{output}</pre>
            )}
        </div>
    );
};
```

- [ ] **Step 4: Run tests, confirm pass**

Run:
```bash
cd /Users/danbarker/Dev/matron-web
pnpm exec jest test/unit-tests/components/views/messages/MLiveOutputBody-test.tsx 2>&1 | tail -15
```

Expected: 3 PASS.

- [ ] **Step 5: Commit**

```bash
cd /Users/danbarker/Dev/matron-web
git add src/components/views/messages/MLiveOutputBody.tsx \
        test/unit-tests/components/views/messages/MLiveOutputBody-test.tsx
git commit -m "Stream data frames into output <pre>"
```

### Task 3.4: Test + implement `complete` frame: exit 0, exit N, truncated, denied

**Files:**
- Modify: `/Users/danbarker/Dev/matron-web/test/unit-tests/components/views/messages/MLiveOutputBody-test.tsx`

(Implementation is already in place from Task 3.3 — this task confirms behavior with more tests.)

- [ ] **Step 1: Add four tests**

Inside the same `describe`:

```ts
it("transitions to ✓ exit 0 on a complete frame with exitCode 0", () => {
    const { getByText } = render(<MLiveOutputBody mxEvent={makeLiveOutputEvent()} />);
    const ws = MockWebSocket.last();
    ws._open();
    ws._message({ type: "complete", exitCode: 0, denied: false, truncated: false });
    expect(getByText("✓ exit 0")).toBeInTheDocument();
});

it("transitions to ✗ exit N for non-zero exit codes", () => {
    const { getByText } = render(<MLiveOutputBody mxEvent={makeLiveOutputEvent()} />);
    const ws = MockWebSocket.last();
    ws._open();
    ws._message({ type: "complete", exitCode: 1, denied: false, truncated: false });
    expect(getByText("✗ exit 1")).toBeInTheDocument();
});

it("appends '· truncated' to ✓ exit 0 when complete frame is truncated", () => {
    const { getByText } = render(<MLiveOutputBody mxEvent={makeLiveOutputEvent()} />);
    const ws = MockWebSocket.last();
    ws._open();
    ws._message({ type: "complete", exitCode: 0, denied: false, truncated: true });
    expect(getByText("✓ exit 0 · truncated")).toBeInTheDocument();
});

it("transitions to 'not executed' on denied", () => {
    const { getByText } = render(<MLiveOutputBody mxEvent={makeLiveOutputEvent()} />);
    const ws = MockWebSocket.last();
    ws._open();
    ws._message({ type: "complete", exitCode: null, denied: true, truncated: false });
    expect(getByText("not executed")).toBeInTheDocument();
    expect(getByText("Command not executed")).toBeInTheDocument();
});
```

- [ ] **Step 2: Add the "denied" placeholder rendering**

The last test asserts `Command not executed` is in the document — add the placeholder for `denied`. Update the JSX in `MLiveOutputBody.tsx`:

Replace:

```tsx
{status !== "expired" && status !== "denied" && (
    <pre className="mx_MLiveOutputBody_output">{output}</pre>
)}
```

With:

```tsx
{status !== "expired" && status !== "denied" && (
    <pre className="mx_MLiveOutputBody_output">{output}</pre>
)}
{status === "denied" && (
    <p className="mx_MLiveOutputBody_placeholder">Command not executed</p>
)}
```

- [ ] **Step 3: Run tests, confirm pass**

Run:
```bash
cd /Users/danbarker/Dev/matron-web
pnpm exec jest test/unit-tests/components/views/messages/MLiveOutputBody-test.tsx 2>&1 | tail -15
```

Expected: 7 PASS.

- [ ] **Step 4: Commit**

```bash
cd /Users/danbarker/Dev/matron-web
git add src/components/views/messages/MLiveOutputBody.tsx \
        test/unit-tests/components/views/messages/MLiveOutputBody-test.tsx
git commit -m "Render complete-frame statuses and denied placeholder"
```

### Task 3.5: Test + implement abnormal close → error state

**Files:**
- Modify: `/Users/danbarker/Dev/matron-web/test/unit-tests/components/views/messages/MLiveOutputBody-test.tsx`
- Modify: `/Users/danbarker/Dev/matron-web/src/components/views/messages/MLiveOutputBody.tsx`

- [ ] **Step 1: Add the test**

```ts
it("transitions to ⚠ disconnected when WS closes abnormally before complete", () => {
    const { getByText } = render(<MLiveOutputBody mxEvent={makeLiveOutputEvent()} />);
    const ws = MockWebSocket.last();
    ws._open();
    ws._close(1006, "abnormal");
    expect(getByText("⚠ disconnected")).toBeInTheDocument();
});

it("stays on ✓ exit 0 when WS closes normally after complete", () => {
    const { getByText } = render(<MLiveOutputBody mxEvent={makeLiveOutputEvent()} />);
    const ws = MockWebSocket.last();
    ws._open();
    ws._message({ type: "complete", exitCode: 0, denied: false, truncated: false });
    ws._close(1000, "done");
    expect(getByText("✓ exit 0")).toBeInTheDocument();
});
```

- [ ] **Step 2: Implement `onclose` / `onerror`**

In `MLiveOutputBody.tsx`'s useEffect, **before** the return cleanup, add `onclose` and `onerror`. The full useEffect body should look like:

```tsx
useEffect(() => {
    if (!content) return;
    const ws = new WebSocket(viewerUrlToWsUrl(content.viewer_url));
    let terminal = false; // set true after we've moved to complete/denied/expired
    ws.onopen = () => setStatus(s => (s === "connecting" ? "running" : s));
    ws.onmessage = (ev: MessageEvent) => {
        let frame: any;
        try { frame = JSON.parse(ev.data); }
        catch { console.warn("MLiveOutputBody: malformed frame", ev.data); return; }
        if (frame.type === "data" && typeof frame.chunk === "string") {
            setOutput(o => o + frame.chunk);
        } else if (frame.type === "complete") {
            terminal = true;
            setExitCode(frame.exitCode ?? null);
            setTruncated(!!frame.truncated);
            setStatus(frame.denied ? "denied" : "complete");
        }
    };
    ws.onclose = (ev: CloseEvent) => {
        if (terminal) return;
        if (ev.code === 1000) return;
        setStatus("error");
    };
    ws.onerror = () => {
        if (terminal) return;
        setStatus("error");
    };
    return () => {
        try { ws.close(); } catch { /* noop */ }
    };
}, [content?.viewer_url]);
```

- [ ] **Step 3: Run tests, confirm pass**

Run:
```bash
cd /Users/danbarker/Dev/matron-web
pnpm exec jest test/unit-tests/components/views/messages/MLiveOutputBody-test.tsx 2>&1 | tail -15
```

Expected: 9 PASS.

- [ ] **Step 4: Commit**

```bash
cd /Users/danbarker/Dev/matron-web
git add src/components/views/messages/MLiveOutputBody.tsx \
        test/unit-tests/components/views/messages/MLiveOutputBody-test.tsx
git commit -m "Surface 'disconnected' on abnormal WS close"
```

---

## Phase 4 — Expiry handling

### Task 4.1: Test + implement: skip WS connect when already expired

**Files:**
- Modify: `/Users/danbarker/Dev/matron-web/test/unit-tests/components/views/messages/MLiveOutputBody-test.tsx`
- Modify: `/Users/danbarker/Dev/matron-web/src/components/views/messages/MLiveOutputBody.tsx`

- [ ] **Step 1: Add the test**

```ts
it("renders 'expired' and skips WS connect when expires_at is in the past at mount", () => {
    const past = Math.floor(Date.now() / 1000) - 60;
    const { getByText } = render(
        <MLiveOutputBody mxEvent={makeLiveOutputEvent({ expires_at: past })} />,
    );
    expect(MockWebSocket.instances).toHaveLength(0);
    expect(getByText("expired")).toBeInTheDocument();
    expect(getByText("Output expired")).toBeInTheDocument();
});
```

- [ ] **Step 2: Run, confirm it fails**

Expected: FAIL — `MockWebSocket.instances` length is 1 because component opens a WS regardless.

- [ ] **Step 3: Implement the skip**

In `MLiveOutputBody.tsx`, initialize `status` based on `expires_at` and short-circuit the useEffect when already expired. Replace the `useState<Status>("connecting")` line with:

```tsx
const initialStatus: Status =
    content && Date.now() >= content.expires_at * 1000 ? "expired" : "connecting";
const [status, setStatus] = useState<Status>(initialStatus);
```

And at the start of the useEffect (just after `if (!content) return;`), add:

```tsx
if (Date.now() >= content.expires_at * 1000) return;
```

Then add the expired placeholder to the JSX. Just below the existing `denied` placeholder:

```tsx
{status === "expired" && (
    <p className="mx_MLiveOutputBody_placeholder">Output expired</p>
)}
```

- [ ] **Step 4: Run, confirm pass**

Run:
```bash
cd /Users/danbarker/Dev/matron-web
pnpm exec jest test/unit-tests/components/views/messages/MLiveOutputBody-test.tsx 2>&1 | tail -15
```

Expected: 10 PASS.

- [ ] **Step 5: Commit**

```bash
cd /Users/danbarker/Dev/matron-web
git add src/components/views/messages/MLiveOutputBody.tsx \
        test/unit-tests/components/views/messages/MLiveOutputBody-test.tsx
git commit -m "Skip WS connect and render 'expired' when already past TTL"
```

### Task 4.2: Test + implement: auto-expiry while mounted

**Files:**
- Modify: `/Users/danbarker/Dev/matron-web/test/unit-tests/components/views/messages/MLiveOutputBody-test.tsx`
- Modify: `/Users/danbarker/Dev/matron-web/src/components/views/messages/MLiveOutputBody.tsx`

- [ ] **Step 1: Add the test (uses jest fake timers)**

```ts
it("flips to 'expired' when the expiry timer fires while mounted", () => {
    jest.useFakeTimers();
    try {
        const expires_at = Math.floor(Date.now() / 1000) + 2;
        const { getByText } = render(
            <MLiveOutputBody mxEvent={makeLiveOutputEvent({ expires_at })} />,
        );
        const ws = MockWebSocket.last();
        ws._open();
        expect(getByText("running…")).toBeInTheDocument();
        jest.advanceTimersByTime(2500);
        expect(getByText("expired")).toBeInTheDocument();
        expect(ws.readyState).toBe(WebSocket.CLOSED);
    } finally {
        jest.useRealTimers();
    }
});
```

- [ ] **Step 2: Run, confirm it fails**

Expected: FAIL — timer not implemented.

- [ ] **Step 3: Implement the expiry timer**

In the useEffect, after the `onerror` handler but before the return cleanup, add:

```tsx
const msUntilExpiry = content.expires_at * 1000 - Date.now();
const expiryTimer = setTimeout(() => {
    terminal = true;
    setStatus("expired");
    try { ws.close(); } catch { /* noop */ }
}, msUntilExpiry);
```

And update the return cleanup:

```tsx
return () => {
    clearTimeout(expiryTimer);
    try { ws.close(); } catch { /* noop */ }
};
```

- [ ] **Step 4: Run, confirm pass**

Run:
```bash
cd /Users/danbarker/Dev/matron-web
pnpm exec jest test/unit-tests/components/views/messages/MLiveOutputBody-test.tsx 2>&1 | tail -15
```

Expected: 11 PASS.

- [ ] **Step 5: Commit**

```bash
cd /Users/danbarker/Dev/matron-web
git add src/components/views/messages/MLiveOutputBody.tsx \
        test/unit-tests/components/views/messages/MLiveOutputBody-test.tsx
git commit -m "Auto-expire tile when the TTL fires while mounted"
```

---

## Phase 5 — Auto-scroll (sticky-bottom)

### Task 5.1: Test + implement sticky-bottom auto-scroll

**Files:**
- Modify: `/Users/danbarker/Dev/matron-web/test/unit-tests/components/views/messages/MLiveOutputBody-test.tsx`
- Modify: `/Users/danbarker/Dev/matron-web/src/components/views/messages/MLiveOutputBody.tsx`

- [ ] **Step 1: Add the tests**

```ts
it("auto-scrolls to bottom when streaming while sticky-bottom is engaged", () => {
    const { container } = render(<MLiveOutputBody mxEvent={makeLiveOutputEvent()} />);
    const ws = MockWebSocket.last();
    ws._open();
    const pre = container.querySelector(".mx_MLiveOutputBody_output") as HTMLPreElement;
    // jsdom does not implement layout, so we stub scroll properties
    Object.defineProperty(pre, "scrollHeight", { configurable: true, get: () => 1000 });
    Object.defineProperty(pre, "clientHeight", { configurable: true, get: () => 200 });
    let observedScrollTop = 0;
    Object.defineProperty(pre, "scrollTop", {
        configurable: true,
        get: () => observedScrollTop,
        set: (v: number) => { observedScrollTop = v; },
    });
    ws._message({ type: "data", chunk: "line\n" });
    expect(observedScrollTop).toBe(1000); // pinned to bottom
});

it("disengages sticky-bottom when the user scrolls up, re-engages near bottom", () => {
    const { container } = render(<MLiveOutputBody mxEvent={makeLiveOutputEvent()} />);
    const ws = MockWebSocket.last();
    ws._open();
    const pre = container.querySelector(".mx_MLiveOutputBody_output") as HTMLPreElement;
    let scrollTop = 100;
    Object.defineProperty(pre, "scrollHeight", { configurable: true, get: () => 1000 });
    Object.defineProperty(pre, "clientHeight", { configurable: true, get: () => 200 });
    Object.defineProperty(pre, "scrollTop", {
        configurable: true,
        get: () => scrollTop,
        set: (v: number) => { scrollTop = v; },
    });
    // User scrolled up: trigger scroll handler
    pre.dispatchEvent(new Event("scroll"));
    ws._message({ type: "data", chunk: "more\n" });
    expect(scrollTop).toBe(100); // unchanged — sticky disengaged
    // User scrolls back to bottom (clientHeight + scrollTop >= scrollHeight - 8)
    scrollTop = 800;
    pre.dispatchEvent(new Event("scroll"));
    ws._message({ type: "data", chunk: "and more\n" });
    expect(scrollTop).toBe(1000); // re-engaged
});
```

- [ ] **Step 2: Run, confirm it fails**

Expected: FAIL — no auto-scroll behavior, no scroll handler.

- [ ] **Step 3: Implement sticky-bottom**

In `MLiveOutputBody.tsx`, add the ref + state + useEffect + onScroll. Updated component:

```tsx
const MLiveOutputBody: React.FC<IProps> = ({ mxEvent }) => {
    const content = mxEvent.getContent()[MATRON_LIVE_OUTPUT_CONTENT_KEY] as LiveOutputContent | undefined;
    const initialStatus: Status =
        content && Date.now() >= content.expires_at * 1000 ? "expired" : "connecting";
    const [status, setStatus] = useState<Status>(initialStatus);
    const [exitCode, setExitCode] = useState<number | null>(null);
    const [truncated, setTruncated] = useState(false);
    const [output, setOutput] = useState<string>("");
    const [stickyBottom, setStickyBottom] = useState(true);
    const preRef = useRef<HTMLPreElement | null>(null);

    // WS lifecycle: unchanged from prior task (keep the existing useEffect body)

    // Sticky-bottom auto-scroll
    useEffect(() => {
        if (!stickyBottom) return;
        const pre = preRef.current;
        if (!pre) return;
        pre.scrollTop = pre.scrollHeight;
    }, [output, stickyBottom]);

    const onScroll: React.UIEventHandler<HTMLPreElement> = (e) => {
        const pre = e.currentTarget;
        const nearBottom = pre.scrollTop + pre.clientHeight >= pre.scrollHeight - 8;
        setStickyBottom(nearBottom);
    };

    if (!content) return null;

    return (
        <div className="mx_MLiveOutputBody" data-status={status}>
            <header className="mx_MLiveOutputBody_header">
                <code className="mx_MLiveOutputBody_cmd">$ {content.command}</code>
                <span className="mx_MLiveOutputBody_status">{statusLabel(status, exitCode, truncated)}</span>
            </header>
            {status !== "expired" && status !== "denied" && (
                <pre ref={preRef} className="mx_MLiveOutputBody_output" onScroll={onScroll}>
                    {output}
                </pre>
            )}
            {status === "denied" && (
                <p className="mx_MLiveOutputBody_placeholder">Command not executed</p>
            )}
            {status === "expired" && (
                <p className="mx_MLiveOutputBody_placeholder">Output expired</p>
            )}
        </div>
    );
};
```

- [ ] **Step 4: Run, confirm pass**

Run:
```bash
cd /Users/danbarker/Dev/matron-web
pnpm exec jest test/unit-tests/components/views/messages/MLiveOutputBody-test.tsx 2>&1 | tail -15
```

Expected: 13 PASS.

- [ ] **Step 5: Commit**

```bash
cd /Users/danbarker/Dev/matron-web
git add src/components/views/messages/MLiveOutputBody.tsx \
        test/unit-tests/components/views/messages/MLiveOutputBody-test.tsx
git commit -m "Sticky-bottom auto-scroll on streamed output"
```

---

## Phase 6 — Expand / collapse

### Task 6.1: Test + implement expand/collapse toggle

**Files:**
- Modify: `/Users/danbarker/Dev/matron-web/test/unit-tests/components/views/messages/MLiveOutputBody-test.tsx`
- Modify: `/Users/danbarker/Dev/matron-web/src/components/views/messages/MLiveOutputBody.tsx`

- [ ] **Step 1: Add the test**

```ts
it("starts collapsed (data-expanded=false) and toggles via the expand button", () => {
    const { container, getByRole } = render(<MLiveOutputBody mxEvent={makeLiveOutputEvent()} />);
    const root = container.querySelector(".mx_MLiveOutputBody")!;
    expect(root.getAttribute("data-expanded")).toBe("false");
    const toggle = getByRole("button", { name: /expand/i });
    toggle.click();
    expect(root.getAttribute("data-expanded")).toBe("true");
    const collapseBtn = getByRole("button", { name: /collapse/i });
    collapseBtn.click();
    expect(root.getAttribute("data-expanded")).toBe("false");
});
```

- [ ] **Step 2: Run, confirm it fails**

Expected: FAIL — no `data-expanded` attribute, no toggle button.

- [ ] **Step 3: Implement expand state and toggle**

Add to the component (immediately after the existing `useState` declarations):

```tsx
const [expanded, setExpanded] = useState(false);
```

Update the rendered `<div>` to include `data-expanded`:

```tsx
<div className="mx_MLiveOutputBody" data-status={status} data-expanded={expanded}>
```

Update the `<header>` to include the toggle button:

```tsx
<header className="mx_MLiveOutputBody_header">
    <code className="mx_MLiveOutputBody_cmd">$ {content.command}</code>
    <span className="mx_MLiveOutputBody_status">{statusLabel(status, exitCode, truncated)}</span>
    <button
        type="button"
        className="mx_MLiveOutputBody_toggle"
        aria-label={expanded ? "Collapse" : "Expand"}
        onClick={() => setExpanded(e => !e)}
    >
        {expanded ? "−" : "+"}
    </button>
</header>
```

- [ ] **Step 4: Run, confirm pass**

Run:
```bash
cd /Users/danbarker/Dev/matron-web
pnpm exec jest test/unit-tests/components/views/messages/MLiveOutputBody-test.tsx 2>&1 | tail -15
```

Expected: 14 PASS.

- [ ] **Step 5: Commit**

```bash
cd /Users/danbarker/Dev/matron-web
git add src/components/views/messages/MLiveOutputBody.tsx \
        test/unit-tests/components/views/messages/MLiveOutputBody-test.tsx
git commit -m "Expand/collapse toggle on tile header"
```

### Task 6.2: Test + render truncation marker in the body when complete carries truncated

**Files:**
- Modify: `/Users/danbarker/Dev/matron-web/test/unit-tests/components/views/messages/MLiveOutputBody-test.tsx`
- Modify: `/Users/danbarker/Dev/matron-web/src/components/views/messages/MLiveOutputBody.tsx`

- [ ] **Step 1: Add the test**

```ts
it("renders an inline truncation marker in the pre when complete is truncated", () => {
    const { container } = render(<MLiveOutputBody mxEvent={makeLiveOutputEvent()} />);
    const ws = MockWebSocket.last();
    ws._open();
    ws._message({ type: "data", chunk: "lots of output\n" });
    ws._message({ type: "complete", exitCode: 0, denied: false, truncated: true });
    const pre = container.querySelector(".mx_MLiveOutputBody_output");
    expect(pre?.textContent).toContain("output truncated");
});
```

- [ ] **Step 2: Run, confirm it fails**

Expected: FAIL — no truncation marker.

- [ ] **Step 3: Add the marker to the rendered pre**

Replace the `<pre>` JSX block with:

```tsx
<pre ref={preRef} className="mx_MLiveOutputBody_output" onScroll={onScroll}>
    {output}
    {truncated && "\n[output truncated]\n"}
</pre>
```

- [ ] **Step 4: Run, confirm pass**

Run:
```bash
cd /Users/danbarker/Dev/matron-web
pnpm exec jest test/unit-tests/components/views/messages/MLiveOutputBody-test.tsx 2>&1 | tail -15
```

Expected: 15 PASS.

- [ ] **Step 5: Commit**

```bash
cd /Users/danbarker/Dev/matron-web
git add src/components/views/messages/MLiveOutputBody.tsx \
        test/unit-tests/components/views/messages/MLiveOutputBody-test.tsx
git commit -m "Show inline truncation marker in output pre"
```

---

## Phase 7 — Styling

### Task 7.1: Create the PCSS file

**Files:**
- Create: `/Users/danbarker/Dev/matron-web/res/css/views/messages/_MLiveOutputBody.pcss`

- [ ] **Step 1: Create the file**

```css
/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

.mx_MLiveOutputBody {
    border: 1px solid var(--cpd-color-border-interactive-secondary);
    border-radius: var(--cpd-radius-pill-effect, 8px);
    background-color: var(--cpd-color-bg-canvas-default);
    margin: 4px 0;
    font-family: var(--cpd-font-family-mono, monospace);
    overflow: hidden;
}

.mx_MLiveOutputBody_header {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 10px;
    background-color: var(--cpd-color-bg-subtle-secondary);
    cursor: default;
    font-size: 13px;
}

.mx_MLiveOutputBody_cmd {
    flex: 1 1 auto;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--cpd-color-text-primary);
}

.mx_MLiveOutputBody_status {
    flex: 0 0 auto;
    color: var(--cpd-color-text-secondary);
    font-size: 12px;
}

.mx_MLiveOutputBody_toggle {
    flex: 0 0 auto;
    width: 22px;
    height: 22px;
    border: none;
    background: transparent;
    color: var(--cpd-color-text-secondary);
    font-size: 18px;
    line-height: 1;
    cursor: pointer;
    border-radius: 4px;
}

.mx_MLiveOutputBody_toggle:hover {
    background-color: var(--cpd-color-bg-subtle-primary);
}

.mx_MLiveOutputBody_output {
    margin: 0;
    padding: 8px 10px;
    max-height: 240px;
    overflow-y: auto;
    font-size: 12px;
    line-height: 1.4;
    color: var(--cpd-color-text-primary);
    background-color: var(--cpd-color-bg-canvas-default);
    white-space: pre-wrap;
    word-break: break-all;
}

.mx_MLiveOutputBody[data-expanded="true"] .mx_MLiveOutputBody_output {
    max-height: 600px;
}

.mx_MLiveOutputBody_placeholder {
    margin: 0;
    padding: 12px 10px;
    color: var(--cpd-color-text-secondary);
    font-style: italic;
    font-size: 13px;
}
```

- [ ] **Step 2: Regenerate the PCSS aggregator**

The aggregator at `res/css/_components.pcss` is regenerated by `res/css/rethemendex.sh`.

Run:
```bash
cd /Users/danbarker/Dev/matron-web
sh res/css/rethemendex.sh
```

- [ ] **Step 3: Verify the new file is included**

Run:
```bash
cd /Users/danbarker/Dev/matron-web
grep "_MLiveOutputBody" res/css/_components.pcss
```

Expected: one line, e.g. `@import "./views/messages/_MLiveOutputBody.pcss";`.

- [ ] **Step 4: Commit**

```bash
cd /Users/danbarker/Dev/matron-web
git add res/css/views/messages/_MLiveOutputBody.pcss res/css/_components.pcss
git commit -m "Style MLiveOutputBody tile"
```

---

## Phase 8 — Bridge TTL bump

### Task 8.1: Change the default in index.js

**Files:**
- Modify: `/Users/danbarker/Dev/claude-matrix-bridge/index.js`

- [ ] **Step 1: Edit the default**

Find the line:

```js
const _rawLiveOutputTtl = parseInt(process.env.MATRON_LIVE_OUTPUT_TTL || '14400', 10);
```

Change to:

```js
const _rawLiveOutputTtl = parseInt(process.env.MATRON_LIVE_OUTPUT_TTL || '86400', 10);
```

Also update the fallback constant on the next line:

```js
const LIVE_OUTPUT_TTL = Number.isFinite(_rawLiveOutputTtl) && _rawLiveOutputTtl > 0 ? _rawLiveOutputTtl : 14400;
```

to:

```js
const LIVE_OUTPUT_TTL = Number.isFinite(_rawLiveOutputTtl) && _rawLiveOutputTtl > 0 ? _rawLiveOutputTtl : 86400;
```

- [ ] **Step 2: Lint and test**

Run:
```bash
cd /Users/danbarker/Dev/claude-matrix-bridge
npm run lint 2>&1 | tail -5
npm test 2>&1 | tail -10
```

Expected: lint clean, all tests pass.

- [ ] **Step 3: Commit**

```bash
cd /Users/danbarker/Dev/claude-matrix-bridge
git add index.js
git commit -m "$(printf 'chore: bump live-output TTL default to 24h\n\nDeployment fits long Claude Code sessions better than the 4h default.\nEnv var override (MATRON_LIVE_OUTPUT_TTL) still honoured.\n\nCo-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>')"
```

---

## Phase 9 — Push and open PRs

### Task 9.1: Push and open the matron-web PR

**Files:** none

- [ ] **Step 1: Run the full matron-web unit-test suite once for sanity**

Run:
```bash
cd /Users/danbarker/Dev/matron-web
pnpm exec jest test/unit-tests/components/views/messages/MLiveOutputBody-test.tsx \
                test/unit-tests/components/views/messages/MessageEvent-test.tsx 2>&1 | tail -15
```

Expected: both files green. (Running the full suite via `pnpm test` is also fine but slow.)

- [ ] **Step 2: Push and open PR**

Run:
```bash
cd /Users/danbarker/Dev/matron-web
git push -u origin feat/live-output-renderer
gh pr create --base matron-ui-divergence \
  --title "Add live-output tile renderer (chat.matron.live_output.v1)" \
  --body "$(cat <<'EOF'
## Summary

Adds the missing client-side half of the live-bash-output feature. The bridge already emits `chat.matron.live_output.v1` events with a viewer URL; this PR adds the React component that renders the inline streaming-output tile.

Architecture matches the existing `MATRON_BUTTONS` pattern: two new constants in `src/matron/EventTypes.ts`, one entry in `EVENT_TILE_TYPES`, one dispatch branch in `MessageEvent.render()`, and a new `MLiveOutputBody` component that opens a WebSocket directly to the bridge's `/live/ws` endpoint.

## Behaviour

- Header shows `$ <cmd>` with a status badge (`connecting…` / `running…` / `✓ exit 0` / `✗ exit N` / `expired` / `not executed` / `⚠ disconnected`).
- Body is a styled `<pre>` that streams the bridge's `{type:"data",chunk}` frames.
- Sticky-bottom auto-scroll; disengages when the user scrolls up.
- Collapsed by default (240 px); expand toggle in the header opens to 600 px.
- After `expires_at` passes (24 h after the command starts in the new bridge default), the tile shows `Output expired` without making a request.

## Test plan
- [x] New unit tests in `test/unit-tests/components/views/messages/MLiveOutputBody-test.tsx` (15 cases covering open, streaming, complete, denied, truncated, error, expired, auto-expiry, sticky-bottom, expand/collapse).
- [x] Routing test added to `MessageEvent-test.tsx` to confirm the content-key dispatch.
- [ ] Manual smoke test against a live bridge (separate item in the project tracker — needs bridge deployed with the new TTL).

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

### Task 9.2: Push and open the bridge PR

**Files:** none

- [ ] **Step 1: Push and open PR**

Run:
```bash
cd /Users/danbarker/Dev/claude-matrix-bridge
git push -u origin chore/bump-live-output-ttl
gh pr create --title "chore: bump live-output TTL default to 24h" --body "$(cat <<'EOF'
## Summary

Bumps the default `MATRON_LIVE_OUTPUT_TTL` from `14400` (4 h) to `86400` (24 h). The env-var override remains, so anyone wanting a tighter expiry can still set it explicitly.

## Context

Pairs with the matron-web live-output renderer PR. The 4-hour default was a placeholder; 24 hours matches a typical Claude Code session better — users scrolling back through a day's work can still expand the tile and view the streamed output. The log is still deleted on the bridge's host after TTL, so no permanent output history accrues.

## Test plan
- [x] `npm run lint` clean
- [x] `npm test` passes
- [ ] Manual: env-var override still honoured when set

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

## Phase 10 — Manual end-to-end smoke test

Run after both PRs are merged and the bridge is redeployed. Not strictly part of the implementation, but the only real validation that the WS plumbing works end-to-end through a browser.

### Task 10.1: Manual smoke test

**Files:** none

- [ ] **Step 1: Make sure the bridge is running with `MATRON_LIVE_OUTPUT_TTL=60` (short, for testing)**

This is a temporary env override to make the expiry path testable. Restart the bridge with `MATRON_LIVE_OUTPUT_TTL=60` in the env (`setup/service-linux.sh` re-export, or directly `MATRON_LIVE_OUTPUT_TTL=60 node index.js`).

- [ ] **Step 2: Toggle `showBashOutput` on for a test room**

In matron-web, in the test room, run `!showBashOutput on` (the bridge command). Wait for the bridge to reply.

- [ ] **Step 3: Verify each scenario**

In the same room, ask Claude to run each of the following and confirm the listed observation:

1. `ls -la` — tile appears, streams instantly, transitions to `✓ exit 0`.
2. `sleep 5 && echo done` — tile shows `running…`, after 5 s shows `done` and transitions to `✓ exit 0`.
3. `seq 1 1000` — tile is scrollable; chat layout unaffected; sticky-bottom holds scroll at the latest line.
4. `false` — tile shows `✗ exit 1`.
5. `yes | head -c 60M` — tile shows `truncated` suffix and `[output truncated]` marker.
6. Wait 60 s past completion of one of the above — tile shows `expired`.
7. Run `!showBashOutput off`, then a Bash command — no tile is posted (only the `🔧 \`cmd\`` indicator).

- [ ] **Step 4: View the same room on stock Element Web**

Open the same Matrix room in a stock Element Web instance (a `app.element.io` browser tab). Events of type `chat.matron.live_output.v1` should be invisible (no tile, no text). Expected behaviour.

- [ ] **Step 5: Restore the default TTL on the bridge**

Remove the `MATRON_LIVE_OUTPUT_TTL=60` override. Restart the bridge. New default is 86400 (24 h).
