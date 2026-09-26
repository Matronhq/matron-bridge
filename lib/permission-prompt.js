// Pure helpers for the print-mode permission prompt flow (spec:
// docs/superpowers/specs/2026-08-10-auto-permission-mode-design.md).
//
// Print-mode sessions spawn with `--permission-mode auto` and route every gated
// MCP call through the ask-user MCP server's permission_request tool to the
// bridge, which is the deciding layer (the classifier in permission-eval.js is
// the automatic tier on top; see permissionSpawnArgs and decidePermissionOutcome
// below). Undecided calls surface as a Matron button card. The card's button VALUES
// are namespaced `perm:<requestId>:<verdict>` and ride the journal
// prompt_reply picker path (lib/picker-dispatch.js), exactly like
// `timer:cancel:<id>`. The registry here is the bridge-side pending store the
// tool polls via GET /permission-request/:id — the /secret/:id shape:
// answered entries are consumed on read; unanswered entries expire by TTL in
// lockstep with the tool's own poll deadline, which fail-closes to deny.

import { randomUUID } from 'crypto';
import { classifyPermission } from './permission-eval.js';

export const DENY_MESSAGE = 'The user denied this tool use from Matron.';

const PREVIEW_MAX = 500;

// One expiry policy for the whole request lifecycle: the ask-user tool's poll
// deadline AND the bridge registry's TTL both resolve through here, so a card
// can never outlive the poller that would honor it. Out-of-range overrides
// (NaN, non-positive, infinite, > 1 h) fall back to the 5-minute default
// rather than producing an immediate deny or an unbounded wait.
export const DEFAULT_PERMISSION_TIMEOUT_MS = 300000;
export const MAX_PERMISSION_TIMEOUT_MS = 3600000;

export function resolvePermissionTimeoutMs(raw) {
  if (raw === undefined || raw === null || raw === '') return DEFAULT_PERMISSION_TIMEOUT_MS;
  const ms = Number(raw);
  return Number.isFinite(ms) && ms > 0 && ms <= MAX_PERMISSION_TIMEOUT_MS
    ? ms
    : DEFAULT_PERMISSION_TIMEOUT_MS;
}

// Bidirectional control characters (RLO/LRO, embeddings, isolates, marks) can
// make a card display reordered text while Claude receives the original value
// — a prompt-injection display-spoof vector. Strip them from everything we
// render; Claude still gets the raw input via updatedInput.
const BIDI_CONTROLS = /[؜‎‏‪-‮⁦-⁩]/g;

function stripBidi(text) {
  return String(text).replace(BIDI_CONTROLS, '');
}

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
  const name = stripBidi(toolName);
  let preview = stripBidi(previewFor(toolName, input));
  if (preview.length > PREVIEW_MAX) preview = `${preview.slice(0, PREVIEW_MAX)}…`;
  return {
    plain: `🔐 Permission: Claude wants to run ${name}\n${preview}`,
    html: `🔐 <b>Permission:</b> Claude wants to run <code>${escapeHtml(name)}</code>`
      + `<br><pre><code>${escapeHtml(preview)}</code></pre>`,
  };
}

export function permissionButtons(requestId, toolName) {
  return {
    buttons: [
      { id: 'perm-allow', label: 'Allow once', value: `perm:${requestId}:allow` },
      { id: 'perm-always', label: `Always allow ${stripBidi(toolName)} (session)`, value: `perm:${requestId}:always` },
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

// Resolve a session's bypassMode: an explicit --bypass/--auto flag wins;
// otherwise the value persisted for the room; otherwise the box default
// (index.js MATRON_PERMISSION_MODE, bypass unless set to 'auto'). Sessions
// persisted before the feature carry no bypassMode and land on the box
// default — which, being bypass, is also exactly how they ran before.
export function resolveBypassMode(flag, persisted, boxDefaultBypass = true) {
  if (typeof flag === 'boolean') return flag;
  if (typeof persisted === 'boolean') return persisted;
  return boxDefaultBypass === true;
}

// The spawn-arg fragment that replaces the hardwired
// '--dangerously-skip-permissions' in index.js print-mode spawns.
//
// The gated (non-bypass) path makes the BRIDGE the deciding layer for MCP calls.
// `--setting-sources ''` tells the CLI to load NO on-disk settings sources (user,
// project, local) into its own permission resolution. Without it the CLI reads
// the workdir/user settings and resolves MCP allow/deny/ask ITSELF before the
// prompt tool is ever consulted — so the classifier's allow branch is dead and a
// policy deny is swallowed by the CLI before the visible notice can fire (the
// design gap this rework closes). With the disk sources dropped, the CLI's only
// permission rules are the bridge's inline `--settings` (the command-line layer,
// which the bridge controls at the spawn site) — that allow-lists exactly the
// infra MCP tools (mcp__ask-user + mcp__show-file), so the permission_request
// tool itself can never be gated into a deadlock. Every other MCP call is then
// uncovered → auto mode routes it to the permission_request tool → POST
// /permission-request → the classifier, which reads the SAME on-disk sources
// directly (buildPermissionSnapshot), is the single deciding layer. Non-MCP tools
// remain governed by auto mode. Tradeoff to weigh: dropping the disk sources also
// drops any non-MCP deny/ask rails a user set in those files for this print-mode
// session; the classifier is MCP-scoped by design, and the default session mode
// (bypass) already skips all rails.
export function permissionSpawnArgs(bypass) {
  return bypass
    ? ['--dangerously-skip-permissions']
    : [
        '--permission-mode', 'auto',
        '--permission-prompt-tool', 'mcp__ask-user__permission_request',
        '--setting-sources', '',
      ];
}

// Claude Code refuses `--dangerously-skip-permissions` when it runs as root:
// it prints "cannot be used with root/sudo privileges for security reasons"
// and exits 1, unless IS_SANDBOX=1 or CLAUDE_CODE_BUBBLEWRAP is set. This
// mirrors that predicate exactly (uid 0, IS_SANDBOX must be the string "1")
// so a bridge deployed as root downgrades to auto mode instead of
// crash-looping every bypass spawn. Codex has no equivalent check.
export function isRootOutsideSandbox({ getuid = process.getuid, env = process.env } = {}) {
  if (typeof getuid !== 'function') return false;
  if (getuid() !== 0) return false;
  if (env.IS_SANDBOX === '1') return false;
  if (env.CLAUDE_CODE_BUBBLEWRAP) return false;
  return true;
}

export const ROOT_BYPASS_WARNING =
  'The bridge is running as root, and Claude Code refuses --dangerously-skip-permissions under root. '
  + 'This session falls back to auto permission mode with Matron permission cards. '
  + 'Run the bridge as an unprivileged user, or set IS_SANDBOX=1 in its environment to allow bypass as root.';

// Applied to the resolved bypassMode right before the spawn args are built.
// The persisted per-room choice is left untouched: the downgrade is a
// property of the host, not of the session, so moving the bridge off root
// (or setting IS_SANDBOX=1) restores bypass on the next spawn.
export function guardRootBypass(bypass, opts) {
  if (bypass && isRootOutsideSandbox(opts)) return { bypass: false, downgraded: true };
  return { bypass, downgraded: false };
}

// How long an ANSWERED entry survives waiting for its poller to collect the
// verdict. The unanswered TTL expires in lockstep with the tool's poll
// deadline (see resolvePermissionTimeoutMs); a tap can land in the final
// sub-second before that deadline, so the verdict gets a short grace window
// for the ≤500 ms-later poll instead of being reaped with the card.
const ANSWERED_GRACE_MS = 60000;

// Bridge-side pending-permission store. Pass ttlMs = the same resolved
// permission timeout the ask-user tool polls with: an unanswered card then
// expires exactly when the tool fail-closes to deny, so a late tap can never
// record a verdict (answer() === null → informative no-op) after Claude has
// already received the timeout denial.
export function createPermissionRegistry({
  setTimeout: setTimer = globalThis.setTimeout,
  clearTimeout: clearTimer = globalThis.clearTimeout,
  mintId = randomUUID,
  ttlMs = DEFAULT_PERMISSION_TIMEOUT_MS,
} = {}) {
  const entries = new Map();
  return {
    create({ roomId, toolName }) {
      const id = mintId();
      const timer = setTimer(() => { entries.delete(id); }, ttlMs);
      entries.set(id, { roomId, toolName, answered: false, behavior: null, message: null, timer });
      return { id };
    },
    // Records a verdict atomically: room affinity and the closed verdict set
    // are checked BEFORE any state changes, so a refused answer leaves the
    // entry pending — the right room can still answer, and a poller never
    // sees a verdict from a tap the bridge refused to honor.
    answer(id, verdict, expectedRoomId) {
      const entry = entries.get(id);
      if (!entry || entry.answered) return null;
      if (verdict !== 'allow' && verdict !== 'always' && verdict !== 'deny') return null;
      if (expectedRoomId !== undefined && entry.roomId !== expectedRoomId) return null;
      clearTimer(entry.timer);
      entry.timer = setTimer(() => { entries.delete(id); }, ANSWERED_GRACE_MS);
      entry.answered = true;
      entry.behavior = verdict === 'deny' ? 'deny' : 'allow';
      entry.message = verdict === 'deny' ? DENY_MESSAGE : null;
      return { roomId: entry.roomId, toolName: entry.toolName, verdict, behavior: entry.behavior };
    },
    read(id) {
      const entry = entries.get(id);
      if (!entry) return null;
      if (!entry.answered) return { answered: false };
      clearTimer(entry.timer);
      entries.delete(id);
      return { answered: true, behavior: entry.behavior, message: entry.message };
    },
    // Withdraws a request whose card never reached the user (delivery
    // failure): the POST route cancels and responds non-OK so the tool
    // denies immediately instead of polling a card nobody can see.
    cancel(id) {
      const entry = entries.get(id);
      if (!entry) return false;
      clearTimer(entry.timer);
      entries.delete(id);
      return true;
    },
    size() { return entries.size; },
  };
}

// --- Classifier → transport decision (spec: MCP permission classifier, #208) ---
//
// The classifier (lib/permission-eval.js) is the pure decision layer; this maps
// its verdict to what the POST /permission-request route returns to the
// permission_request tool. Three outcomes:
//   allow → respond `{behavior:'allow'}` immediately, no card (same tier as an
//           earlier "Always allow" tap: a silent, session-scoped allow).
//   deny  → respond `{behavior:'deny', message: DENY_MESSAGE}` immediately AND
//           surface a plain room notice, so a policy denial is VISIBLE without a
//           card. (ask-user.js honours a POST-level deny in addition to allow.)
//   card  → everything else — `ask`, `default-gated`, and any snapshot marked
//           uncertain (classifyPermission fails closed: uncertain never widens
//           to allow) — falls through UNCHANGED to today's card mint.
export function decidePermissionOutcome(snapshot, toolName) {
  const verdict = classifyPermission(snapshot, toolName);
  if (verdict === 'allow') {
    return { kind: 'allow', body: { behavior: 'allow' } };
  }
  if (verdict === 'deny') {
    return {
      kind: 'deny',
      body: { behavior: 'deny', message: DENY_MESSAGE },
      // stripBidi the tool name like the card path (renderPermissionCard /
      // permissionButtons): a raw name with bidi control characters could
      // display-spoof the notice text.
      notice: `⛔ blocked \`${stripBidi(toolName)}\` by policy`,
    };
  }
  // 'ask' and 'default-gated' both mint a card. Fail-closed: an uncertain
  // snapshot can only ever land here (classifyPermission never returns 'allow'
  // when uncertain), so it prompts rather than silently allowing.
  return { kind: 'card' };
}

// The full POST /permission-request decision sequence, extracted so the ordering
// the route depends on is unit-testable and can't silently drift. Mirrors the
// handler in index.js exactly: an "Always allow (session)" grant is a silent
// allow that short-circuits BEFORE the classifier; otherwise the classifier
// decides (allow-silent / deny-visible / card). Returns WHAT to do — the handler
// still owns the HTTP write, the deny room notice, and the card mint. The
// grant-allow carries source:'grant' so callers/tests can tell it apart from a
// classifier allow.
export function resolvePermissionRequest({ permAllowedTools, snapshot, toolName }) {
  if (permAllowedTools && permAllowedTools.has(toolName)) {
    return { kind: 'allow', body: { behavior: 'allow' }, source: 'grant' };
  }
  return decidePermissionOutcome(snapshot, toolName);
}

// Map the bridge's POST /permission-request JSON response to the ask-user
// permission_request tool's immediate action. Kept here (not inline in
// ask-user.js) so the branches are unit-testable — ask-user.js registers its MCP
// server on import and can't be imported directly. Three actions:
//   allow → the bridge decided allow (a grant or a classifier allow), no card.
//   deny  → the bridge decided deny (a classifier policy deny), no card. Fail
//           CLOSED: a malformed response or a missing request id also denies.
//   poll  → the bridge minted a card; poll requestId until it is answered.
export function classifyPermissionPostResponse(data) {
  if (!data || typeof data !== 'object') {
    return { action: 'deny', message: 'Matron bridge returned an invalid permission response.' };
  }
  if (data.behavior === 'allow') return { action: 'allow' };
  if (data.behavior === 'deny') return { action: 'deny', message: data.message || DENY_MESSAGE };
  const { requestId } = data;
  if (typeof requestId !== 'string' || requestId === '') {
    return { action: 'deny', message: 'Matron bridge returned an invalid permission request id.' };
  }
  return { action: 'poll', requestId };
}

// --- Session-scoped "Always allow" grant helpers (!permissions command) ---
//
// The grant tier is `session.permAllowedTools` — an in-memory Set of EXACT tool
// names written by the card's "Always allow (session)" tap. It is cleared on
// restart (nothing durable, no journal parking), so these operate on the live
// Set only. Names are exact (`mcp__server__tool`), never wildcards.
export function listSessionGrants(permAllowedTools) {
  if (!permAllowedTools) return [];
  return [...permAllowedTools].sort();
}

// Revoke one grant by exact name. Returns true if a grant was removed, false if
// the name wasn't granted (so the caller can report "not currently granted").
export function revokeSessionGrant(permAllowedTools, toolName) {
  if (!permAllowedTools || typeof toolName !== 'string') return false;
  return permAllowedTools.delete(toolName);
}
