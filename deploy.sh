#!/bin/bash
# deploy.sh — ship the latest master to the live bridge, safely.
#
# Pull → sync deps → PREFLIGHT (verify the new code can actually boot) →
# restart. The preflight runs while the OLD process is still serving, so a
# broken deploy leaves the running bridge untouched instead of crash-looping:
# launchd's KeepAlive would otherwise relaunch a non-booting build forever
# (this is the exact failure mode a bare restart hit — pulled code that added
# `sharp` as a top-level import, with node_modules not yet synced).
#
# This is the deliberate, infrequent "ship latest" path. `restart.sh` stays as
# the dumb "just bounce the current code" bounce; it never touches deps.
#
# Usage:
#   ./deploy.sh            pull, install, preflight, restart, record old PID
#   ./deploy.sh --dry-run  pull, install, preflight — report readiness, NO restart

set -euo pipefail
cd "$(dirname "$0")"

# Label of the installed LaunchAgent, read from the plist rather than
# hardcoded. It was hardcoded to "chat.matron.matron-bridge" — a name that
# followed the repo rename but that no installed service ever had. Every step
# up to the restart succeeded, then launchctl reported "Could not find service"
# and the deploy aborted with the OLD code still serving: a pull that looked
# like a ship.
SERVICE_PLIST="$HOME/Library/LaunchAgents/chat.matron.claude-matrix-bridge.plist"
SERVICE="$(/usr/libexec/PlistBuddy -c 'Print :Label' "$SERVICE_PLIST" 2>/dev/null \
  || echo 'chat.matron.claude-matrix-bridge')"
TARGET="gui/$(id -u)/$SERVICE"
DRY_RUN=0
[ "${1:-}" = "--dry-run" ] && DRY_RUN=1

step() { printf '\n\033[1m==> %s\033[0m\n' "$1"; }
fail() { printf '\033[31mFAIL: %s\033[0m\n' "$1" >&2; exit 1; }

# 1. Pull latest master. --ff-only: never rewrite or diverge the live tree.
step "git pull --ff-only origin master"
git pull --ff-only origin master

# 2. Sync dependencies. Idempotent — a ~1s no-op when already in sync, and the
#    one step a bare restart can't do. This is where sharp/native deps land.
step "npm install"
npm install --no-audit --no-fund

# 3. PREFLIGHT — prove the new code boots BEFORE we kill the working process.
step "preflight (old process still serving)"

echo "  - declared deps all installed?"
if ! npm ls --omit=dev >/tmp/matron-deploy-npmls.txt 2>&1; then
  # npm ls also exits non-zero for benign 'extraneous' packages; only a
  # genuinely missing/unmet/invalid dep is a boot blocker.
  if grep -qiE 'missing|invalid|unmet' /tmp/matron-deploy-npmls.txt; then
    grep -iE 'missing|invalid|unmet' /tmp/matron-deploy-npmls.txt >&2
    fail "a declared dependency is missing/invalid — 'npm install' did not resolve it"
  fi
fi

echo "  - syntax of every entrypoint (npm run check)?"
npm run check >/dev/null || fail "syntax check failed — see 'npm run check'"

echo "  - native bindings actually load, import chain resolves?"
# The definitive test for the sharp class of failure: node --check parses but
# never resolves imports, so only an actual import exercises the module graph
# and the native .node binding. index.js pulls sharp via lib/inline-image.js.
node --input-type=module \
  -e "await import('sharp'); await import('./lib/inline-image.js')" \
  || fail "the new code cannot import its dependencies — refusing to restart a broken build"

echo "  - the service we are about to restart exists?"
launchctl print "$TARGET" >/dev/null 2>&1 \
  || fail "no such service: $TARGET — nothing would be restarted, and the old code would keep serving"

echo "  preflight OK — the new code imports and boots"

if [ "$DRY_RUN" = "1" ]; then
  step "--dry-run: readiness verified, bridge NOT restarted"
  exit 0
fi

# 4. Restart via launchd. kickstart -k kills the running instance; KeepAlive
#    relaunches it on the freshly-synced code. Record the old PID so the
#    restart can be verified afterwards (this kickstart kills the process
#    hosting whatever invoked us, so we can't reliably check the new PID here).
OLD_PID=$(launchctl print "$TARGET" 2>/dev/null | awk -F'= ' '/ pid = /{print $2; exit}' || true)
echo "${OLD_PID:-none}" > /tmp/matron-deploy-oldpid
step "launchctl kickstart -k $TARGET  (old PID: ${OLD_PID:-none})"
launchctl kickstart -k "$TARGET"

echo "Restart requested. Old PID was ${OLD_PID:-none} (saved to /tmp/matron-deploy-oldpid)."
echo "Verify: launchctl print $TARGET | grep 'pid =' — the PID should differ and stay up."
