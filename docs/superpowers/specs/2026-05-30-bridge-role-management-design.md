---
status: draft
revision: 1
slug: bridge-role-management
approach: B (sidecar JSON file for persistence, env var for allowlist)
rejected_alternatives:
  - "A: Write roles directly to .env — risky automated edits to a file with comments, formatting, and other variables"
  - "C: Env-var only, no runtime commands — requires restart to change roles, no !role command"
  - "D: Runtime-only (in-memory) — roles lost on restart, annoying for orgs"
unresolved_questions: []
---

# Bridge Role Management

**Target codebase:** `/opt/matron/bridge/` (Node.js Matrix bridge, `index.js`)

## Problem

The bridge has a flat `ALLOWED_USER_IDS` allowlist — everyone gets the same access. The current `createSessionRoom` grants PL50 to all invited users, which lets them invite third parties and redact bot messages. There's no way to differentiate between an admin who should manage the bridge and a team member who should only chat.

As the bridge moves toward open source and multi-user deployments, a simple role system is needed so the first user (or deployer) can control what others can do.

## Solution

Add a role system with two levels: `admin` and `member`. Roles are stored in a sidecar JSON file (`~/.claude-matrix-roles.json`) and managed at runtime via `!role` commands. The first user in `ALLOWED_USER_IDS` auto-gets admin. Others default to member.

### Roles

| Role | Matrix PL | Can start sessions | Can use !role | Can rename rooms | Can use bridge commands |
|---|---|---|---|---|---|
| `admin` | 50 | yes | yes | yes | all |
| `member` | 0 | yes | no | no | all except !role |

Both roles can chat with Claude and use session commands (!start, !stop, !esc, etc.). The difference is room management (PL50 lets admins rename/topic rooms) and the ability to promote/demote other users.

### Commands

- `!role` — show your own role
- `!role list` — show all users and their roles (admin only)
- `!role @user:server admin` — promote user to admin (admin only)
- `!role @user:server member` — demote user to member (admin only)
- `!who` — alias for `!role list`

### Persistence

On startup:
1. Read `ALLOWED_USER_IDS` from `.env` — this remains the source of truth for WHO is allowed
2. Read `~/.claude-matrix-roles.json` — overlay role assignments
3. First user in `ALLOWED_USER_IDS` with no explicit role gets `admin`

On `!role @user admin/member`:
1. Update in-memory role map
2. Write `~/.claude-matrix-roles.json`
3. Reply with confirmation

File format:
```json
{
  "@alice:server": "admin",
  "@bob:server": "member"
}
```

### Room creation changes

`createSessionRoom` reads the user's role and sets Matrix power levels accordingly:

```javascript
const userPL = getUserRole(inviteUserId) === 'admin' ? 50 : 0;
```

Power level overrides (same as current Codex-reviewed fix):
- `invite: 100` — only bot can invite
- `kick: 100` — only bot can kick
- `ban: 100` — only bot can ban
- `redact: 100` — only bot can redact
- `state_default: 100` — only bot can change room state
- `events['m.room.name']: 50` — admins can rename
- `events['m.room.topic']: 50` — admins can set topic

### Auth gate on !role

`handleCommand` for `!role` checks `getUserRole(sender) === 'admin'` before allowing set operations. Self-query (`!role` with no args) works for everyone.

### Future considerations (out of scope)

- **Observer role** — read-only, can't send messages to Claude. Would need message-level filtering.
- **Per-room roles** — different roles in different session rooms. Current model is global.
- **Control room** — dedicated admin room for bridge management. Not needed while commands work from any room.
- **Audit log** — log role changes. Nice to have, not MVP.

## Scope

### In scope

- `admin` and `member` roles
- `!role` and `!who` commands
- `~/.claude-matrix-roles.json` persistence
- First-user auto-admin
- Role-aware PL in createSessionRoom
- Add roles to !help text

### Out of scope

- Observer/read-only role
- Per-room roles
- Control room
- Role changes for users not in ALLOWED_USER_IDS (allowlist is separate from roles)
- Migration of existing rooms' power levels (only affects new rooms)

## Architecture

```
.env (ALLOWED_USER_IDS)     ~/.claude-matrix-roles.json
         |                              |
         v                              v
    isAllowed(userId)          getUserRole(userId)
         |                              |
         +------> role-aware gate ------+
                       |
              createSessionRoom(userId)
                  PL = role → 50 or 0
```

All changes in `index.js`. No new files except the auto-created JSON sidecar.
