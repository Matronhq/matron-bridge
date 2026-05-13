# Send/Cancel Text Commands + Viewer Service Fix

**Date:** 2026-02-17

## Problem

1. **Viewer bug:** Clicking "Send now" or "Cancel" links from queued message notifications returns "Cannot GET /action". The matrix bridge's file viewer service (`claude-matrix-file-viewer`) was never installed on dev-3. The old `code-file-viewer` service (telegram's viewer, no `/action` route) was squatting on port 9801.

2. **No text command support:** Users can only send/cancel queued messages by clicking links (which open a browser tab). There's no way to control the queue by typing "send" or "cancel" in the Matrix chat.

## Solution

### Viewer fix (infra — already done)

The yearbook-infra repo already has the fix on master:
- Matrix viewer gets port 9801, telegram viewer moves to 9803
- Separate Cloudflare tunnel hostnames: `viewer3.yearbooks.be` (matrix), `tg-viewer3.yearbooks.be` (telegram)
- Telegram recipe looks up `tg-viewer*` hostnames instead of `viewer*`

**Deployment:** Run `sudo bash ~/claude-matrix-bridge/setup/systemd.sh` to install `claude-matrix-file-viewer.service`, then stop the old `code-file-viewer` service.

### Send/cancel text commands (code change)

**Location:** `index.js`, inside the `if (session.busy)` block (lines 1853-1901)

**"send"** — alias for existing interrupt behaviour:
- Add `lowerText === 'send'` to the existing interrupt check at line 1855
- Flushes all queued messages, strips notification links

**"cancel"** — cancel the most recently queued message:
- Add a new check for `lowerText === 'cancel'` before the queue-the-message logic
- Pop the last item from `session.queuedMessages`
- Edit the corresponding notification in `session.queueNotifications` to show cancelled
- If no queued messages exist, reply saying so

This follows the existing pattern used by `interrupt` (line 1855) and `build` (line 1844).
