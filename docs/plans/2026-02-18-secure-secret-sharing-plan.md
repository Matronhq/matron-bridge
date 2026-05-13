# Secure Secret Sharing Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a `request_secret` MCP tool that lets Claude request credentials via a secure web form, writing them to files instead of exposing them in chat.

**Architecture:** Extends the existing ask-user MCP pattern. Claude calls `request_secret` → bridge API creates a pending request and sends an HMAC-signed link to Matrix → user clicks link, enters secret in viewer form → viewer proxies to bridge API → bridge writes file to `~/.secrets/` and resolves the pending request → MCP polling returns the file path.

**Tech Stack:** Node.js, MCP SDK, Express (viewer), native `http` (bridge API), `crypto` for HMAC + UUID

---

### Task 1: Rename ask-matrix-user to ask-user

**Files:**
- Rename: `ask-matrix-user.js` → `ask-user.js`
- Modify: `mcp-config.json`
- Modify: `index.js:122`

**Step 1: Rename the file**

```bash
cd /home/danbarker/claude-matrix-bridge
git mv ask-matrix-user.js ask-user.js
```

**Step 2: Update the MCP server name and tool name in ask-user.js**

In `ask-user.js`, change:
- Line 16: `name: 'ask-matrix-user'` → `name: 'ask-user'`
- Line 21: `'ask_matrix_user'` → `'ask_user'`
- Line 22: description stays the same but remove "Matrix" → `'Ask the user a question...'`

**Step 3: Update mcp-config.json**

Change the server key and args:
```json
{
  "mcpServers": {
    "ask-user": {
      "command": "node",
      "args": ["./ask-user.js"],
      "env": {
        "BRIDGE_API_URL": "http://127.0.0.1:9802"
      }
    },
    ...
  }
}
```

**Step 4: Update --append-system-prompt in index.js**

Line 122: change `mcp__ask-matrix-user__ask_matrix_user` to `mcp__ask-user__ask_user`.

**Step 5: Commit**

```bash
git add -A && git commit -m "refactor: rename ask-matrix-user to ask-user"
```

---

### Task 2: Add request_secret tool to ask-user.js

**Files:**
- Modify: `ask-user.js`

**Step 1: Add the request_secret tool**

After the existing `ask_user` tool definition (after line 65), add a second `server.tool()` call:

```javascript
server.tool(
  'request_secret',
  'Request a secret from the user via a secure web form. The secret is written to a file and the file path is returned. Use this for API keys, tokens, passwords — anything that should not appear in chat.',
  {
    label: z.string().describe('A short label describing what secret is needed, e.g. "AWS access key" or "database password"'),
  },
  async ({ label }) => {
    try {
      const postRes = await fetch(`${BRIDGE_API}/secret`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ label }),
      });

      if (!postRes.ok) {
        const err = await postRes.text();
        return { content: [{ type: 'text', text: `Error requesting secret: ${err}` }] };
      }

      const { secretId } = await postRes.json();

      // Poll for the secret to be submitted
      const deadline = Date.now() + POLL_TIMEOUT_MS;
      while (Date.now() < deadline) {
        await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));

        const pollRes = await fetch(`${BRIDGE_API}/secret/${secretId}`);
        if (!pollRes.ok) continue;

        const data = await pollRes.json();
        if (data.answered) {
          return { content: [{ type: 'text', text: `Secret written to: ${data.path}` }] };
        }
      }

      return { content: [{ type: 'text', text: 'Secret request timed out — no input received within 5 minutes.' }] };
    } catch (err) {
      return { content: [{ type: 'text', text: `Error: ${err.message}` }] };
    }
  }
);
```

**Step 2: Commit**

```bash
git add ask-user.js && git commit -m "feat: add request_secret MCP tool to ask-user"
```

---

### Task 3: Add secret endpoints to bridge API (index.js)

**Files:**
- Modify: `index.js`

**Step 1: Add imports and constants**

Near the top of the file (after existing imports around line 8-12), add:

```javascript
import { randomUUID } from 'crypto';
```

After the config section (around line 45, near LINK_EXPIRY_MS), add:

```javascript
const SECRETS_DIR = path.join(os.homedir(), '.secrets');
const SECRET_TTL_MS = 3600000; // 1 hour
```

**Step 2: Ensure ~/.secrets/ directory exists on startup**

In the `main()` function (line 2205), add at the start before `botUserId = await client.getUserId()`:

```javascript
// Ensure secrets directory exists with restricted permissions
try {
  await fs.promises.mkdir(SECRETS_DIR, { mode: 0o700, recursive: true });
} catch {}
```

Note: `fs` is already imported as `import fs from 'fs'` on line 8. Use `fs.promises.mkdir`.

**Step 3: Add pendingSecrets map**

After `const pendingMcpQuestions = new Map();` (line 1984), add:

```javascript
const pendingSecrets = new Map();
```

**Step 4: Add a generateSecretLink function**

After `generateActionLink` (around line 66), add:

```javascript
function generateSecretLink(secretId, label, roomId) {
  if (!HMAC_SECRET || !VIEWER_BASE_URL) return null;
  const exp = Math.floor((Date.now() + LINK_EXPIRY_MS) / 1000);
  const payload = Buffer.from(JSON.stringify({ secretId, label, roomId, exp })).toString('base64url');
  const sig = createHmac('sha256', HMAC_SECRET).update(payload).digest('base64url');
  return `${VIEWER_BASE_URL}/secret?token=${payload}.${sig}`;
}
```

**Step 5: Add GET /secret/:id poll endpoint**

In the API server handler (after the `GET /ask/:id` block, around line 2008), add:

```javascript
  // GET /secret/:id — MCP server polls for secret submission
  if (req.method === 'GET' && url.pathname.startsWith('/secret/')) {
    const secretId = url.pathname.split('/')[2];
    const s = pendingSecrets.get(secretId);
    if (!s) {
      res.writeHead(404);
      res.end(JSON.stringify({ error: 'Secret request not found' }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ answered: s.answered, path: s.path || null }));
    if (s.answered) {
      pendingSecrets.delete(secretId);
    }
    return;
  }
```

**Step 6: Add POST /secret endpoint (create secret request)**

Inside the POST body handler, after the `POST /ask` block (around line 2073), add:

```javascript
      if (url.pathname === '/secret') {
        const { label } = data;
        if (!label) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: 'label is required' }));
          return;
        }

        const secretId = randomUUID();

        pendingSecrets.set(secretId, {
          label,
          answered: false,
          path: null,
        });

        // Find active session and send the link to its room
        let activeSession = null;
        for (const [, s] of sessions) {
          if (s.alive) { activeSession = s; break; }
        }

        if (activeSession) {
          const link = generateSecretLink(secretId, label, activeSession.roomId);
          if (link && activeSession.sendHtml) {
            const plain = `🔐 Secret requested: ${label} — Enter secret: ${link}`;
            const html = `🔐 Secret requested: <b>${label}</b> — <a href="${link}">Enter secret</a>`;
            activeSession.sendHtml(plain, html);
          } else if (activeSession.sendCallback) {
            activeSession.sendCallback(`🔐 Secret requested: ${label} (viewer not configured)`);
          }
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ secretId }));
        return;
      }
```

**Step 7: Add POST /secret/:id/submit endpoint**

Inside the POST body handler, right after the new `/secret` block, add:

```javascript
      const secretSubmitMatch = url.pathname.match(/^\/secret\/([^/]+)\/submit$/);
      if (secretSubmitMatch) {
        const secretId = secretSubmitMatch[1];
        const s = pendingSecrets.get(secretId);
        if (!s) {
          res.writeHead(404);
          res.end(JSON.stringify({ error: 'Secret request not found or already submitted' }));
          return;
        }

        const { value } = data;
        if (!value) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: 'value is required' }));
          return;
        }

        // Write secret to file
        const filePath = path.join(SECRETS_DIR, `${secretId}.txt`);
        try {
          fs.writeFileSync(filePath, value, { mode: 0o600 });
        } catch (err) {
          res.writeHead(500);
          res.end(JSON.stringify({ error: `Failed to write secret: ${err.message}` }));
          return;
        }

        s.answered = true;
        s.path = filePath;

        // Schedule cleanup after 1 hour
        setTimeout(() => {
          fs.unlink(filePath, () => {});
        }, SECRET_TTL_MS);

        res.writeHead(200);
        res.end(JSON.stringify({ ok: true, path: filePath }));
        return;
      }
```

**Step 8: Commit**

```bash
git add index.js && git commit -m "feat: add secret request/submit/poll API endpoints"
```

---

### Task 4: Add secret form page to viewer

**Files:**
- Modify: `viewer/server.js`

**Step 1: Add body parsing middleware**

After `const app = express();` (line 15), add:

```javascript
app.use(express.urlencoded({ extended: false }));
app.use(express.json());
```

**Step 2: Add renderSecretForm function**

After the `renderHtml` function (after line 77), add:

```javascript
function renderSecretForm(label, token) {
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Enter Secret</title>
  <style>
    body { margin: 0; background: #0d1117; color: #e6edf3; font-family: -apple-system, BlinkMacSystemFont, sans-serif; display: flex; align-items: center; justify-content: center; min-height: 100vh; }
    .card { background: #161b22; border: 1px solid #30363d; border-radius: 8px; padding: 32px; max-width: 480px; width: 100%; }
    h2 { margin: 0 0 8px; font-size: 18px; }
    .label { color: #8b949e; margin-bottom: 20px; font-size: 14px; }
    input[type="password"] { width: 100%; padding: 10px 12px; background: #0d1117; border: 1px solid #30363d; border-radius: 6px; color: #e6edf3; font-family: 'SF Mono', 'Fira Code', monospace; font-size: 14px; box-sizing: border-box; }
    input[type="password"]:focus { outline: none; border-color: #58a6ff; }
    button { margin-top: 16px; padding: 10px 24px; background: #238636; border: none; border-radius: 6px; color: #fff; font-size: 14px; font-weight: 600; cursor: pointer; width: 100%; }
    button:hover { background: #2ea043; }
    .note { margin-top: 12px; font-size: 12px; color: #8b949e; }
  </style>
</head>
<body>
  <div class="card">
    <h2>🔐 Enter Secret</h2>
    <div class="label">${label.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')}</div>
    <form method="POST" action="/secret">
      <input type="hidden" name="token" value="${token}">
      <input type="password" name="value" placeholder="Paste secret here..." autofocus required>
      <button type="submit">Submit</button>
    </form>
    <div class="note">This value will be written to a secure file and auto-deleted after 1 hour. It will not appear in chat.</div>
  </div>
</body>
</html>`;
}

function renderSecretSuccess() {
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Secret Submitted</title>
  <style>
    body { margin: 0; background: #0d1117; color: #e6edf3; font-family: -apple-system, BlinkMacSystemFont, sans-serif; display: flex; align-items: center; justify-content: center; min-height: 100vh; }
    .card { text-align: center; padding: 40px; }
    h2 { color: #3fb950; }
  </style>
</head>
<body>
  <div class="card">
    <h2>✅ Secret submitted</h2>
    <p>The secret has been securely saved. You can close this tab.</p>
  </div>
</body>
</html>`;
}
```

**Step 3: Add GET /secret route (serve form)**

Before the `/health` route (before line 150), add:

```javascript
app.get('/secret', (req, res) => {
  const { token } = req.query;
  if (!token) return res.status(400).send('Missing token');

  const data = verifyToken(token);
  if (!data) return res.status(403).send('Invalid or expired token');
  if (!data.secretId || !data.label) return res.status(400).send('Invalid secret token');

  res.type('html').send(renderSecretForm(data.label, token));
});
```

**Step 4: Add POST /secret route (handle form submission)**

Right after the GET /secret route, add:

```javascript
app.post('/secret', async (req, res) => {
  const { token, value } = req.body;
  if (!token || !value) return res.status(400).send('Missing token or value');

  const data = verifyToken(token);
  if (!data) return res.status(403).send('Invalid or expired token');
  if (!data.secretId) return res.status(400).send('Invalid secret token');

  try {
    const resp = await fetch(`http://127.0.0.1:${BRIDGE_API_PORT}/secret/${data.secretId}/submit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ value }),
    });

    if (!resp.ok) {
      const err = await resp.text();
      return res.status(resp.status).type('html').send(
        `<!DOCTYPE html><html><body style="background:#0d1117;color:#e6edf3;font-family:sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;"><div><h2>Submission failed</h2><p>${err}</p></div></body></html>`
      );
    }

    res.type('html').send(renderSecretSuccess());
  } catch (err) {
    console.error('Secret submit proxy error:', err);
    res.status(500).send('Failed to reach bridge API');
  }
});
```

**Step 5: Commit**

```bash
git add viewer/server.js && git commit -m "feat: add secret input form page to viewer"
```

---

### Task 5: Test end-to-end

**Step 1: Restart the bridge service**

```bash
sudo systemctl restart claude-matrix-bridge
```

**Step 2: Verify the service is running**

```bash
sudo systemctl status claude-matrix-bridge
```

**Step 3: Start a new session in Matrix and ask Claude to request a secret**

Send a message like: "I need to give you an API key securely. Please request it."

Claude should call `request_secret`, a link should appear in the room, clicking it should show the form, and submitting should return the file path to Claude.

**Step 4: Verify file permissions**

```bash
ls -la ~/.secrets/
```

Files should be `-rw-------` (mode 0600), directory should be `drwx------` (mode 0700).

**Step 5: Verify auto-cleanup**

After 1 hour, the file should be automatically deleted. For testing, temporarily change `SECRET_TTL_MS` to a shorter value.

**Step 6: Commit any fixes**

```bash
git add -A && git commit -m "fix: address issues found during testing"
```
