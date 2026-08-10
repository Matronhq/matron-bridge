// Pure helpers for the print-mode permission prompt flow (spec:
// docs/superpowers/specs/2026-08-10-auto-permission-mode-design.md).
//
// Print-mode sessions spawn with `--permission-mode auto` and route the rare
// remaining permission prompts through the ask-user MCP server's
// permission_request tool to a Matron button card. The card's button VALUES
// are namespaced `perm:<requestId>:<verdict>` and ride the journal
// prompt_reply picker path (lib/picker-dispatch.js), exactly like
// `timer:cancel:<id>`. The registry here is the bridge-side pending store the
// tool polls via GET /permission-request/:id — the /secret/:id shape:
// answered entries are consumed on read; unanswered entries expire by TTL so
// the map never leaks (the tool's own 5-minute timeout fires first and
// fail-closes to deny).

export const DENY_MESSAGE = 'The user denied this tool use from Matron.';

const PREVIEW_MAX = 500;

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function previewFor(toolName, input) {
  if (toolName === 'Bash' && input && typeof input.command === 'string') {
    return input.description
      ? `${input.command}\n# ${input.description}`
      : input.command;
  }
  try {
    return JSON.stringify(input ?? {});
  } catch {
    return String(input);
  }
}

export function renderPermissionCard({ toolName, input }) {
  let preview = previewFor(toolName, input);
  if (preview.length > PREVIEW_MAX) preview = `${preview.slice(0, PREVIEW_MAX)}…`;
  return {
    plain: `🔐 Permission: Claude wants to run ${toolName}\n${preview}`,
    html: `🔐 <b>Permission:</b> Claude wants to run <code>${escapeHtml(toolName)}</code>`
      + `<br><pre><code>${escapeHtml(preview)}</code></pre>`,
  };
}

export function permissionButtons(requestId, toolName) {
  return {
    buttons: [
      { id: 'perm-allow', label: 'Allow once', value: `perm:${requestId}:allow` },
      { id: 'perm-always', label: `Always allow ${toolName} (session)`, value: `perm:${requestId}:always` },
      { id: 'perm-deny', label: 'Deny', value: `perm:${requestId}:deny` },
    ],
    mode: 'pick_one',
  };
}

// Strict shape validation (defense-in-depth like parsePickerValue): the
// request id must be a UUID and the verdict one of the three the buttons emit.
const PERM_TAP = /^perm:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}):(allow|always|deny)$/;

export function parsePermTap(value) {
  const m = typeof value === 'string' ? value.match(PERM_TAP) : null;
  return m ? { requestId: m[1], verdict: m[2] } : null;
}

// The spawn-arg fragment that replaces the hardwired
// '--dangerously-skip-permissions' in index.js print-mode spawns.
export function permissionSpawnArgs(bypass) {
  return bypass
    ? ['--dangerously-skip-permissions']
    : ['--permission-mode', 'auto', '--permission-prompt-tool', 'mcp__ask-user__permission_request'];
}
