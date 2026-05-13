# Secure Secret Sharing

## Problem

When Claude needs credentials (API keys, tokens, passwords), users currently paste them into the Matrix chat. This is insecure — secrets end up in Matrix message history and potentially in Claude's conversation context.

## Solution

Add a `request_secret` MCP tool that sends an HMAC-signed link to the Matrix room. The user clicks the link, enters the secret in a web form, and the value is written to a secure file on disk. Claude receives the file path — the secret value never appears in chat.

## Scope

This change also renames `ask-matrix-user` to `ask-user` (file, MCP server name, and tool name) since it doesn't need to know it's Matrix.

## Flow

```
Claude calls request_secret({ label: "AWS access key" })
  -> ask-user.js POSTs to bridge API: POST /secret { label }
  -> bridge generates secretId (UUID v4), stores pending request
  -> bridge sends HMAC-signed link to Matrix room
  -> ask-user.js polls: GET /secret/:secretId (500ms interval, 5min timeout)

User clicks link -> viewer serves GET /secret?token=...
  -> form page with label, password input, Submit button
  -> form POSTs to viewer: POST /secret { token, value }
  -> viewer verifies HMAC, extracts secretId + roomId
  -> viewer proxies to bridge API: POST /secret/:secretId/submit { value }
  -> bridge writes value to ~/.secrets/<secretId>.txt (mode 0600)
  -> bridge marks request as answered with the file path
  -> bridge schedules file deletion after 1 hour

ask-user.js polling picks up the answer
  -> returns file path to Claude
```

## Components

### ask-user.js (renamed from ask-matrix-user.js)

- Rename tool from `ask_matrix_user` to `ask_user`
- Add `request_secret` tool with `label` (string, required) parameter
- Same polling pattern as `ask_user`: POST to create, poll for answer
- Hits `/secret` endpoints instead of `/ask`
- Returns `{ path: "/home/danbarker/.secrets/<secretId>.txt" }` instead of text

### index.js (bridge API + Matrix bot)

- Update `--append-system-prompt` to reference `mcp__ask-user__ask_user`
- Three new API endpoints:
  - `POST /secret` — create pending secret request, send HMAC link to Matrix room
  - `GET /secret/:id` — poll endpoint, returns `{ answered, path }`
  - `POST /secret/:id/submit` — receive value, write file, mark answered
- New in-memory Map: `pendingSecrets`
- Ensure `~/.secrets/` exists with mode 0700 on startup
- Write secret files with mode 0600
- Schedule `fs.unlink` after 1 hour (3600000ms)

### viewer/server.js

- `GET /secret?token=...` — verify HMAC, serve dark-themed form page with label and password input
- `POST /secret` — receive form submission, verify HMAC token from hidden field, proxy value to bridge API

### mcp-config.json

- Rename `ask-matrix-user` key to `ask-user`
- Update args: `ask-matrix-user.js` -> `ask-user.js`

## Security

- HMAC-signed form links with 15-minute expiry (matches existing viewer pattern)
- Secret files: mode 0600 (owner read/write only)
- `~/.secrets/` directory: mode 0700 (owner only)
- Secret value never appears in Matrix messages — only the link does
- All traffic between viewer and bridge API is on localhost (127.0.0.1)
- Auto-cleanup: files deleted after 1 hour

## File naming

`~/.secrets/<secretId>.txt` where secretId is a UUID v4.
