// Credential scoping for bridge-spawned child processes.
//
// Two kinds of bridge secret reach children through `...process.env` today:
//
//   - HMAC_SECRET signs the viewer's file / secret / sensitive-data links. Only
//     the bridge process (index.js, lib/viewer-tokens.js) and the viewer (which
//     loads the same .env itself) use it. No child needs it: the show-file MCP
//     server carries its own per-session SHOW_FILE_TOKEN. Yet every Claude and
//     Codex session inherited it, and anything those sessions start inherits it
//     in turn; a dev server run inside a session can persist its environment to
//     disk (e.g. a bundler's on-disk cache). Anyone holding it can mint viewer
//     links for any path the viewer serves. Stripped from EVERY child.
//
//   - JOURNAL_TOKEN / JOURNAL_TOKEN_FILE is the bridge's agent credential for
//     the journal. It reads every conversation the user has (search, transcript
//     reads, roster), not just this box's. Agent SESSIONS still receive it,
//     because BRIDGE_CLAUDE.md ("Searching the journal") and BRIDGE_CODEX.md
//     ("Journal history", the /items HTTP fallback) tell them to authenticate
//     with it. Children that run a fixed, journal-free job (the `claude -p
//     /usage` one-shot, the codex app-server account reader, ffmpeg/ffprobe,
//     whisper-cli, the sleep command, `ps`) have no use for it and must not
//     carry it.
//
// Non-credential journal settings (JOURNAL_WS_URL, JOURNAL_CONTROL_CONVO_ID,
// JOURNAL_CURSOR_FILE) are left alone.
//
// Both helpers fail SAFE, never open:
//   - they own the copy, so they never mutate the caller's object; in
//     particular they can be handed `process.env` directly without clobbering
//     the bridge's own credentials;
//   - a missing argument defaults to a sanitized copy of `process.env`, never
//     an inherited full environment (Node treats `env: undefined` as "inherit
//     everything", so a helper that passed undefined through would silently
//     restore the secrets);
//   - an explicitly invalid (non-object, non-nullish) argument throws.

export const BRIDGE_ONLY_SECRET_KEYS = ['HMAC_SECRET'];

export const JOURNAL_CHILD_STRIPPED_KEYS = ['JOURNAL_TOKEN', 'JOURNAL_TOKEN_FILE'];

// A COPY of `env` without the bridge-only secrets. For agent session spawns,
// which keep the journal token their prompts rely on.
export function stripBridgeOnlySecrets(env = process.env) {
  if (env !== null && typeof env !== 'object') {
    throw new TypeError('stripBridgeOnlySecrets: env must be an object');
  }
  const out = { ...env };
  for (const key of BRIDGE_ONLY_SECRET_KEYS) delete out[key];
  return out;
}

// A COPY of `env` without the journal credential AND the bridge-only secrets.
// For journal-free child spawns.
export function stripJournalCreds(env = process.env) {
  if (env !== null && typeof env !== 'object') {
    throw new TypeError('stripJournalCreds: env must be an object');
  }
  const out = stripBridgeOnlySecrets(env ?? {});
  for (const key of JOURNAL_CHILD_STRIPPED_KEYS) delete out[key];
  return out;
}
