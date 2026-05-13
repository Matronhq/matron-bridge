# macOS Support Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make claude-matrix-bridge installable and runnable on macOS with parity to the existing Linux setup, including launchd service management and whisper.cpp voice-note transcription.

**Architecture:** Rename existing setup scripts with a `-linux` suffix and replace the original entry points with thin dispatchers that detect the OS via `uname -s` and exec the right variant. Add `-macos` siblings: `install-macos.sh` (BSD-sed-safe), `service-macos.sh` (launchd plist generator with LaunchAgent default and LaunchDaemon via `SCOPE=system`), `install-whisper-macos.sh` (brew-based with no source-build fallback). Fix one `/proc`-using line in `restart.sh` to use `lsof` instead, which works on both platforms.

**Tech Stack:** Bash (POSIX where practical, Bash 3.2+ for macOS compatibility), launchd, Homebrew, Node.js (already cross-platform).

**Spec:** [docs/superpowers/specs/2026-05-02-macos-support-design.md](../specs/2026-05-02-macos-support-design.md)

---

## File Structure

**New files (all under `setup/`):**
- `install-linux.sh` — extracted from current `install.sh` body, unchanged behavior
- `install-macos.sh` — new, BSD-sed-safe equivalent
- `service-linux.sh` — extracted from current `systemd.sh` body, unchanged behavior
- `service-macos.sh` — new, launchd plist generator
- `install-whisper-linux.sh` — extracted from current `install-whisper.sh` body, unchanged behavior
- `install-whisper-macos.sh` — new, brew-based whisper.cpp install

**Modified files:**
- `setup/install.sh` — replaced with OS-detecting dispatcher
- `setup/install-whisper.sh` — replaced with OS-detecting dispatcher
- `setup/systemd.sh` — replaced with deprecation shim that execs `setup/service.sh`
- `restart.sh` — replace `/proc/$pid/cwd` lookup with `lsof`
- `README.md` — add macOS subsections to Requirements and Setup, plus a service-management subsection

**New entry-point file:**
- `setup/service.sh` — dispatcher (new public entry point, replaces `setup/systemd.sh` semantically)

**Convention notes for the implementer:**
- All shell scripts start with `#!/usr/bin/env bash` and `set -euo pipefail`.
- Match macOS Bash 3.2 — no `${var,,}`, no `mapfile`, no associative arrays.
- Every new script must be `chmod +x` after creation.
- The two dispatchers and the deprecation shim must `exec` (not `bash`) to preserve exit codes and signals.

---

## Task 1: Refactor — split existing scripts into Linux variants behind dispatchers

This task is a pure rename + dispatcher refactor. **No behavior change on Linux.** Run `setup/install.sh` and `setup/systemd.sh` on the dev box before and after — they must do the same thing.

**Files:**
- Create: `setup/install-linux.sh`, `setup/service-linux.sh`, `setup/install-whisper-linux.sh`, `setup/service.sh`
- Modify: `setup/install.sh`, `setup/install-whisper.sh`, `setup/systemd.sh`

- [ ] **Step 1.1: Move install.sh body into install-linux.sh**

```bash
git mv setup/install.sh setup/install-linux.sh
chmod +x setup/install-linux.sh
```

The contents stay identical — it remains the same script that runs `npm install`, copies `.env.example` to `.env`, and seeds an HMAC secret with `sed -i`.

- [ ] **Step 1.2: Move systemd.sh body into service-linux.sh**

```bash
git mv setup/systemd.sh setup/service-linux.sh
chmod +x setup/service-linux.sh
```

Contents stay identical (still writes `/etc/systemd/system/*.service` files and runs `systemctl daemon-reload`/`enable`/`restart`).

- [ ] **Step 1.3: Move install-whisper.sh body into install-whisper-linux.sh**

```bash
git mv setup/install-whisper.sh setup/install-whisper-linux.sh
chmod +x setup/install-whisper-linux.sh
```

Contents stay identical.

- [ ] **Step 1.4: Create the install.sh dispatcher**

Create `setup/install.sh` with:

```bash
#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
OS="$(uname -s)"

case "$OS" in
  Linux)  exec bash "$SCRIPT_DIR/install-linux.sh" "$@" ;;
  Darwin) exec bash "$SCRIPT_DIR/install-macos.sh" "$@" ;;
  *)
    echo "ERROR: unsupported OS: $OS" >&2
    echo "Supported: Linux, Darwin (macOS)" >&2
    exit 1
    ;;
esac
```

```bash
chmod +x setup/install.sh
```

- [ ] **Step 1.5: Create the install-whisper.sh dispatcher**

Create `setup/install-whisper.sh` with the same shape, dispatching to `install-whisper-linux.sh` / `install-whisper-macos.sh`.

```bash
#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
OS="$(uname -s)"

case "$OS" in
  Linux)  exec bash "$SCRIPT_DIR/install-whisper-linux.sh" "$@" ;;
  Darwin) exec bash "$SCRIPT_DIR/install-whisper-macos.sh" "$@" ;;
  *)
    echo "ERROR: unsupported OS: $OS" >&2
    echo "Supported: Linux, Darwin (macOS)" >&2
    exit 1
    ;;
esac
```

```bash
chmod +x setup/install-whisper.sh
```

- [ ] **Step 1.6: Create the service.sh dispatcher (new entry point)**

Create `setup/service.sh`:

```bash
#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
OS="$(uname -s)"

case "$OS" in
  Linux)  exec bash "$SCRIPT_DIR/service-linux.sh" "$@" ;;
  Darwin) exec bash "$SCRIPT_DIR/service-macos.sh" "$@" ;;
  *)
    echo "ERROR: unsupported OS: $OS" >&2
    echo "Supported: Linux, Darwin (macOS)" >&2
    exit 1
    ;;
esac
```

```bash
chmod +x setup/service.sh
```

- [ ] **Step 1.7: Create the systemd.sh deprecation shim**

Create `setup/systemd.sh` (replacing the file we git-mv'd in step 1.2):

```bash
#!/usr/bin/env bash
# Deprecated entry point. Use setup/service.sh.
echo "WARNING: setup/systemd.sh is deprecated; use setup/service.sh" >&2
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
exec bash "$SCRIPT_DIR/service.sh" "$@"
```

```bash
chmod +x setup/systemd.sh
```

- [ ] **Step 1.8: Smoke-test the dispatchers on Linux**

The OS-detection branch must pick Linux. Run:

```bash
bash -x setup/install.sh 2>&1 | head -3
```

Expected: the `set -x` trace shows `exec bash .../install-linux.sh` (and then npm install runs as before — you can Ctrl-C as soon as you see the exec line if you don't want a full reinstall).

```bash
bash -x setup/install-whisper.sh 2>&1 | head -3
```

Expected: trace shows `exec bash .../install-whisper-linux.sh`. (Again, Ctrl-C immediately if you don't want a full whisper rebuild.)

```bash
bash -x setup/service.sh 2>&1 | head -3
```

Expected: trace shows `exec bash .../service-linux.sh`. **Do not let this complete on the dev box** unless you want to redeploy systemd units — Ctrl-C immediately.

```bash
bash setup/systemd.sh </dev/null 2>&1 | head -2
```

Expected: prints the deprecation warning then would proceed to dispatch (Ctrl-C as above).

If `service.sh` would dispatch but the trace ever shows the macOS branch on a Linux box, the `case` is wrong — fix before continuing.

- [ ] **Step 1.9: Commit the refactor**

```bash
git add setup/
git commit -m "refactor(setup): split install/service/whisper scripts behind OS dispatchers

Move existing Linux-specific bodies under -linux.sh suffix and add thin
dispatchers at the original entry-point names. setup/service.sh is the
new entry point; setup/systemd.sh stays as a deprecation shim."
```

---

## Task 2: Implement install-macos.sh

Mirror `install-linux.sh` structurally but use BSD-sed (`sed -i ''`). Same end state: npm deps installed, `.env` seeded from `.env.example`, HMAC secret filled in.

**Files:**
- Create: `setup/install-macos.sh`

- [ ] **Step 2.1: Create install-macos.sh**

```bash
#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(dirname "$SCRIPT_DIR")"
SERVICE_USER="${SERVICE_USER:-$(whoami)}"

echo "=== Claude Matrix Bridge - Install (macOS) ==="
echo "Repo: $REPO_DIR"
echo "User: $SERVICE_USER"
echo

if ! command -v node >/dev/null 2>&1; then
  echo "ERROR: node not found on PATH. Install Node.js 20+ (e.g. 'brew install node@20')." >&2
  exit 1
fi

echo "Installing npm dependencies..."
cd "$REPO_DIR"
npm install

if [ ! -f "$REPO_DIR/.env" ]; then
  echo "Creating .env from .env.example..."
  cp "$REPO_DIR/.env.example" "$REPO_DIR/.env"
  HMAC=$(openssl rand -hex 32)
  # BSD sed requires an explicit empty backup-suffix argument after -i.
  sed -i '' "s/^HMAC_SECRET=$/HMAC_SECRET=$HMAC/" "$REPO_DIR/.env"
  echo "⚠️  Edit .env to set MATRIX_ACCESS_TOKEN, ALLOWED_USER_IDS, etc."
else
  echo ".env already exists, skipping."
fi

echo
echo "Done. Next steps:"
echo "  1. Edit .env with your settings (MATRIX_ACCESS_TOKEN, ALLOWED_USER_IDS)"
echo "  2. Run: setup/service.sh                       # user-scoped LaunchAgent"
echo "     or: SCOPE=system sudo setup/service.sh      # system-wide LaunchDaemon"
```

```bash
chmod +x setup/install-macos.sh
```

- [ ] **Step 2.2: Lint with shellcheck (if available locally)**

```bash
command -v shellcheck >/dev/null 2>&1 && shellcheck setup/install-macos.sh || echo "shellcheck not installed, skipping"
```

Expected: no errors. Warnings about `SERVICE_USER` being unused are OK to leave (it's set for symmetry with the Linux script and for users who want to override).

- [ ] **Step 2.3: Commit**

```bash
git add setup/install-macos.sh
git commit -m "feat(setup): add macOS install script

BSD-sed-safe variant of install-linux.sh. Same behavior: installs npm
deps and seeds .env from .env.example with a generated HMAC secret."
```

---

## Task 3: Implement service-macos.sh (launchd)

Generates two plists (bridge + viewer), bootstraps them with `launchctl`, and prints lifecycle commands. Idempotent — always `bootout` first, then re-bootstrap, so re-running after editing `.env` cleanly reloads.

**Files:**
- Create: `setup/service-macos.sh`

- [ ] **Step 3.1: Create service-macos.sh**

```bash
#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(dirname "$SCRIPT_DIR")"
SCOPE="${SCOPE:-user}"
NODE_BIN="${NODE_BIN:-$(command -v node)}"

if [ -z "$NODE_BIN" ] || [ ! -x "$NODE_BIN" ]; then
  echo "ERROR: node not found. Install Node.js 20+ (e.g. 'brew install node@20')." >&2
  exit 1
fi

if [ ! -f "$REPO_DIR/.env" ]; then
  echo "ERROR: $REPO_DIR/.env not found. Run setup/install.sh first." >&2
  exit 1
fi

case "$SCOPE" in
  user)
    PLIST_DIR="$HOME/Library/LaunchAgents"
    LOG_DIR="$HOME/Library/Logs"
    TARGET="gui/$(id -u)"
    ;;
  system)
    if [ "$(id -u)" -ne 0 ]; then
      echo "ERROR: SCOPE=system requires sudo." >&2
      echo "Re-run as: SCOPE=system sudo $0" >&2
      exit 1
    fi
    PLIST_DIR="/Library/LaunchDaemons"
    LOG_DIR="/var/log"
    TARGET="system"
    ;;
  *)
    echo "ERROR: SCOPE must be 'user' or 'system' (got: $SCOPE)" >&2
    exit 1
    ;;
esac

mkdir -p "$PLIST_DIR" "$LOG_DIR"

BRIDGE_LABEL="com.yearbook.claude-matrix-bridge"
VIEWER_LABEL="com.yearbook.claude-matrix-file-viewer"
BRIDGE_PLIST="$PLIST_DIR/$BRIDGE_LABEL.plist"
VIEWER_PLIST="$PLIST_DIR/$VIEWER_LABEL.plist"

echo "=== Installing launchd services ($SCOPE scope) ==="
echo "Repo: $REPO_DIR"
echo "Node: $NODE_BIN"
echo "Plist dir: $PLIST_DIR"
echo

# XML-escape a string for inclusion in plist string values.
xml_escape() {
  local s="$1"
  s="${s//&/&amp;}"
  s="${s//</&lt;}"
  s="${s//>/&gt;}"
  s="${s//\"/&quot;}"
  printf '%s' "$s"
}

# Read .env and emit plist <key>/<string> pairs for every non-empty,
# non-comment KEY=VALUE line. Strips surrounding quotes from VALUE.
emit_env_keys() {
  local line key val
  while IFS= read -r line || [ -n "$line" ]; do
    # Skip blanks and comments.
    case "$line" in
      ''|'#'*) continue ;;
    esac
    # Must contain '='.
    case "$line" in
      *=*) ;;
      *) continue ;;
    esac
    key="${line%%=*}"
    val="${line#*=}"
    # Trim leading whitespace from key.
    key="${key#"${key%%[![:space:]]*}"}"
    # Skip if key isn't a sane env-var name.
    case "$key" in
      [A-Za-z_]*) ;;
      *) continue ;;
    esac
    # Strip matching surrounding quotes from value.
    case "$val" in
      \"*\") val="${val#\"}"; val="${val%\"}" ;;
      \'*\') val="${val#\'}"; val="${val%\'}" ;;
    esac
    [ -z "$val" ] && continue
    printf '    <key>%s</key>\n    <string>%s</string>\n' \
      "$(xml_escape "$key")" "$(xml_escape "$val")"
  done < "$REPO_DIR/.env"
}

write_plist() {
  local out="$1" label="$2" script="$3" stdout_log="$4"
  cat > "$out" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$(xml_escape "$label")</string>
  <key>ProgramArguments</key>
  <array>
    <string>$(xml_escape "$NODE_BIN")</string>
    <string>$(xml_escape "$REPO_DIR/$script")</string>
  </array>
  <key>WorkingDirectory</key>
  <string>$(xml_escape "$REPO_DIR")</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>StandardOutPath</key>
  <string>$(xml_escape "$stdout_log")</string>
  <key>StandardErrorPath</key>
  <string>$(xml_escape "$stdout_log")</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>$HOME/.claude/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
$(emit_env_keys)
  </dict>
</dict>
</plist>
EOF
  chmod 644 "$out"
  if ! plutil -lint "$out" >/dev/null; then
    echo "ERROR: generated plist failed plutil -lint: $out" >&2
    plutil -lint "$out" >&2 || true
    exit 1
  fi
}

reload_service() {
  local label="$1" plist="$2"
  # bootout is allowed to fail (service may not be loaded yet).
  launchctl bootout "$TARGET/$label" 2>/dev/null || true
  launchctl bootstrap "$TARGET" "$plist"
  launchctl enable "$TARGET/$label" || true
  launchctl kickstart "$TARGET/$label"
}

write_plist "$BRIDGE_PLIST" "$BRIDGE_LABEL" "index.js" "$LOG_DIR/claude-matrix-bridge.log"
write_plist "$VIEWER_PLIST" "$VIEWER_LABEL" "viewer/server.js" "$LOG_DIR/claude-matrix-file-viewer.log"

reload_service "$BRIDGE_LABEL" "$BRIDGE_PLIST"
reload_service "$VIEWER_LABEL" "$VIEWER_PLIST"

echo
echo "✅ Services installed and started ($SCOPE scope):"
echo "    Bridge plist:  $BRIDGE_PLIST"
echo "    Viewer plist:  $VIEWER_PLIST"
echo "    Bridge log:    $LOG_DIR/claude-matrix-bridge.log"
echo "    Viewer log:    $LOG_DIR/claude-matrix-file-viewer.log"
echo
echo "Lifecycle:"
echo "    Restart:   launchctl kickstart -k $TARGET/$BRIDGE_LABEL"
echo "    Stop:      launchctl kill TERM $TARGET/$BRIDGE_LABEL"
echo "    Status:    launchctl print $TARGET/$BRIDGE_LABEL | head -20"
echo "    Logs:      tail -f $LOG_DIR/claude-matrix-bridge.log"
echo "    Uninstall: launchctl bootout $TARGET/$BRIDGE_LABEL && rm $BRIDGE_PLIST"
echo
echo "Re-run setup/service.sh after editing .env to apply env changes."
```

```bash
chmod +x setup/service-macos.sh
```

- [ ] **Step 3.2: Lint with shellcheck**

```bash
command -v shellcheck >/dev/null 2>&1 && shellcheck setup/service-macos.sh || echo "shellcheck not installed, skipping"
```

Expected: no errors.

- [ ] **Step 3.3: Generate-only smoke test on Linux**

The script can't run end to end on Linux (no `launchctl`, no `plutil`), but we can verify the plist generation logic by stubbing those commands and pointing it at a temp dir. Run:

```bash
TMPDIR=$(mktemp -d)
HOME_OVERRIDE=$(mktemp -d)
mkdir -p "$HOME_OVERRIDE/Library/LaunchAgents" "$HOME_OVERRIDE/Library/Logs"

# Stub launchctl + plutil so the script doesn't bail on a non-Mac.
STUB_DIR=$(mktemp -d)
cat > "$STUB_DIR/launchctl" <<'EOF'
#!/usr/bin/env bash
echo "stub launchctl: $*"
EOF
cat > "$STUB_DIR/plutil" <<'EOF'
#!/usr/bin/env bash
# Skip lint, just succeed.
exit 0
EOF
chmod +x "$STUB_DIR/launchctl" "$STUB_DIR/plutil"

PATH="$STUB_DIR:$PATH" HOME="$HOME_OVERRIDE" SCOPE=user bash setup/service-macos.sh

ls "$HOME_OVERRIDE/Library/LaunchAgents/"
```

Expected: two `.plist` files created. Inspect one:

```bash
cat "$HOME_OVERRIDE/Library/LaunchAgents/com.yearbook.claude-matrix-bridge.plist"
```

Expected: a well-formed XML plist containing the right `ProgramArguments`, `WorkingDirectory`, `KeepAlive`, log paths, and an `EnvironmentVariables` dict that includes `PATH` plus every set key from `.env`.

If you have a Mac on hand: copy the file there and run `plutil -lint <path>` to confirm it parses cleanly.

Clean up: `rm -rf "$STUB_DIR" "$HOME_OVERRIDE"`.

- [ ] **Step 3.4: Commit**

```bash
git add setup/service-macos.sh
git commit -m "feat(setup): add macOS launchd service installer

Generates LaunchAgent (default) or LaunchDaemon (SCOPE=system) plists for
the bridge and viewer, inlines values from .env into EnvironmentVariables
(no EnvironmentFile equivalent on launchd), and bootstraps with launchctl.
Idempotent: bootout-then-bootstrap on every run, so re-running after a
.env edit reloads cleanly."
```

---

## Task 4: Implement install-whisper-macos.sh

Brew-based install. No source-build fallback (per spec — YAGNI). Creates a symlink at the same path the Linux script's source build would produce, so `lib/transcribe.js` doesn't need a code change.

**Files:**
- Create: `setup/install-whisper-macos.sh`

- [ ] **Step 4.1: Create install-whisper-macos.sh**

```bash
#!/usr/bin/env bash
set -euo pipefail

WHISPER_MODEL="${WHISPER_MODEL:-small}"
INSTALL_DIR="${WHISPER_INSTALL_DIR:-$HOME/.local/share/whisper-cpp}"
MODEL_FILE="ggml-${WHISPER_MODEL}.bin"

echo "=== Whisper.cpp Install (macOS) ==="
echo "Model: $WHISPER_MODEL"
echo "Install dir: $INSTALL_DIR"
echo

if ! command -v brew >/dev/null 2>&1; then
  echo "ERROR: Homebrew not found. Install from https://brew.sh, then re-run." >&2
  exit 1
fi

echo "Installing whisper-cpp and ffmpeg via Homebrew..."
brew install whisper-cpp ffmpeg

# Locate the brew-installed whisper-cli binary.
WHISPER_PREFIX="$(brew --prefix whisper-cpp)"
BREW_BIN="$WHISPER_PREFIX/bin/whisper-cli"
if [ ! -x "$BREW_BIN" ]; then
  echo "ERROR: whisper-cli not found at $BREW_BIN after brew install." >&2
  echo "Brew formula may have changed binary name. Check 'brew list whisper-cpp'." >&2
  exit 1
fi
"$BREW_BIN" --help >/dev/null 2>&1 || {
  echo "ERROR: $BREW_BIN exists but --help failed." >&2
  exit 1
}

# Mirror the Linux source-build layout so lib/transcribe.js's derived path
# (modelDir/../build/bin/whisper-cli) finds the binary without code changes.
TARGET_BIN_DIR="$INSTALL_DIR/build/bin"
mkdir -p "$TARGET_BIN_DIR" "$INSTALL_DIR/models"
ln -sf "$BREW_BIN" "$TARGET_BIN_DIR/whisper-cli"
echo "Symlinked $BREW_BIN -> $TARGET_BIN_DIR/whisper-cli"

# Download the model if not already present.
if [ ! -f "$INSTALL_DIR/models/$MODEL_FILE" ]; then
  echo "Downloading $MODEL_FILE model..."
  DOWNLOAD_SCRIPT="$INSTALL_DIR/models/download-ggml-model.sh"
  if [ ! -f "$DOWNLOAD_SCRIPT" ]; then
    curl -fsSL -o "$DOWNLOAD_SCRIPT" \
      https://raw.githubusercontent.com/ggerganov/whisper.cpp/master/models/download-ggml-model.sh
    chmod +x "$DOWNLOAD_SCRIPT"
  fi
  ( cd "$INSTALL_DIR/models" && bash "$DOWNLOAD_SCRIPT" "$WHISPER_MODEL" )
else
  echo "Model $MODEL_FILE already exists."
fi

echo
echo "=== Whisper.cpp install complete ==="
echo "Binary (symlink): $TARGET_BIN_DIR/whisper-cli -> $BREW_BIN"
echo "Model:            $INSTALL_DIR/models/$MODEL_FILE"
echo
echo "Set in .env:"
echo "  WHISPER_MODEL_PATH=$INSTALL_DIR/models/$MODEL_FILE"
```

```bash
chmod +x setup/install-whisper-macos.sh
```

- [ ] **Step 4.2: Lint with shellcheck**

```bash
command -v shellcheck >/dev/null 2>&1 && shellcheck setup/install-whisper-macos.sh || echo "shellcheck not installed, skipping"
```

Expected: no errors.

- [ ] **Step 4.3: Commit**

```bash
git add setup/install-whisper-macos.sh
git commit -m "feat(setup): add macOS whisper.cpp install script

Uses 'brew install whisper-cpp ffmpeg' instead of building from source.
Symlinks the brew binary into ~/.local/share/whisper-cpp/build/bin/whisper-cli
so lib/transcribe.js works without code changes. Apple Silicon Metal
acceleration is included in the brew bottle automatically."
```

---

## Task 5: Fix `restart.sh` portability

Replace the `/proc/$pid/cwd` lookup (Linux-only) with `lsof`, which exists on both platforms. No platform branch needed.

**Files:**
- Modify: `restart.sh:21-28`

- [ ] **Step 5.1: Update the cwd-match block**

Find this block in `restart.sh`:

```bash
# Also kill any 'node index.js' started from this directory
pgrep -f "node index.js" | while read pid; do
  PROC_CWD=$(readlink /proc/$pid/cwd 2>/dev/null)
  if [ "$PROC_CWD" = "$(pwd)" ]; then
    echo "Killing bridge PID $pid (cwd match)"
    kill $pid 2>/dev/null || true
  fi
done
```

Replace with:

```bash
# Also kill any 'node index.js' started from this directory.
# lsof works on both Linux and macOS; /proc/$pid/cwd is Linux-only.
pgrep -f "node index.js" | while read pid; do
  PROC_CWD=$(lsof -a -p "$pid" -d cwd -Fn 2>/dev/null | awk '/^n/{print substr($0,2); exit}')
  if [ "$PROC_CWD" = "$(pwd)" ]; then
    echo "Killing bridge PID $pid (cwd match)"
    kill $pid 2>/dev/null || true
  fi
done
```

`lsof -Fn` outputs each name on its own line prefixed with `n`; `awk '/^n/{print substr($0,2); exit}'` strips the prefix and takes the first match.

- [ ] **Step 5.2: Verify on Linux**

Find a running node process to test against (use the bridge itself or any node process in a known directory):

```bash
# Get a PID of any node process and its expected cwd via /proc.
TEST_PID=$(pgrep -f "node" | head -1)
echo "Testing with PID $TEST_PID"
echo "Expected (from /proc): $(readlink /proc/$TEST_PID/cwd)"
echo "Got (from lsof):       $(lsof -a -p "$TEST_PID" -d cwd -Fn 2>/dev/null | awk '/^n/{print substr($0,2); exit}')"
```

Expected: both lines print the same path. If they differ, the awk pattern is wrong — fix before continuing.

- [ ] **Step 5.3: Run restart.sh end-to-end on the dev box**

If the bridge is currently running via systemd, skip this step (restart.sh is for non-systemd setups). Otherwise:

```bash
bash restart.sh
```

Expected: same output as before — kills any stale processes, frees port 9802, restarts the bridge.

- [ ] **Step 5.4: Commit**

```bash
git add restart.sh
git commit -m "fix(restart): use lsof instead of /proc for cwd lookup

/proc/\$pid/cwd is Linux-only. lsof -a -p PID -d cwd works on both Linux
and macOS, so no platform branch is needed."
```

---

## Task 6: README — document macOS install + service management

**Files:**
- Modify: `README.md`

- [ ] **Step 6.1: Update Requirements section**

Replace the current `## Requirements` block with:

```markdown
## Requirements

- Node.js 20+
- Claude Code CLI installed and authenticated
- A Matrix homeserver (e.g. Tuwunel) with a bot account

**Linux (Ubuntu/Debian):** `apt-get install nodejs npm` (or use nvm). For voice notes: `setup/install-whisper.sh` will install the rest.

**macOS:** [Homebrew](https://brew.sh), Xcode Command Line Tools (`xcode-select --install`), and `brew install node@20`. For voice notes: `setup/install-whisper.sh` will run `brew install whisper-cpp ffmpeg` automatically.
```

- [ ] **Step 6.2: Update Setup section**

Replace the current `## Setup` block with:

```markdown
## Setup

```bash
npm install
cp .env.example .env
# Edit .env — add your MATRIX_ACCESS_TOKEN and ALLOWED_USER_IDS
npm start
```

To run as a managed service, use the OS-detecting installer:

```bash
setup/install.sh                # installs npm deps, seeds .env
# edit .env

# Linux (systemd):
sudo setup/service.sh

# macOS (LaunchAgent — runs while you're logged in):
setup/service.sh
# or, system-wide LaunchDaemon (runs at boot, requires sudo):
SCOPE=system sudo setup/service.sh
```

After editing `.env`, re-run `setup/service.sh` (on macOS, launchd has no
`EnvironmentFile` equivalent — values are inlined into the plist at install
time).
```

- [ ] **Step 6.3: Add a service-management subsection**

Insert just after the Setup section:

```markdown
## Managing the service

**Linux (systemd):**

| Action | Command |
|---|---|
| Status | `systemctl status claude-matrix-bridge` |
| Restart | `sudo systemctl restart claude-matrix-bridge` |
| Logs | `journalctl -u claude-matrix-bridge -f` |
| Stop | `sudo systemctl stop claude-matrix-bridge` |

**macOS (launchd, user scope):**

| Action | Command |
|---|---|
| Status | `launchctl print gui/$UID/com.yearbook.claude-matrix-bridge \| head -20` |
| Restart | `launchctl kickstart -k gui/$UID/com.yearbook.claude-matrix-bridge` |
| Logs | `tail -f ~/Library/Logs/claude-matrix-bridge.log` |
| Stop | `launchctl kill TERM gui/$UID/com.yearbook.claude-matrix-bridge` |
| Uninstall | `launchctl bootout gui/$UID/com.yearbook.claude-matrix-bridge && rm ~/Library/LaunchAgents/com.yearbook.claude-matrix-bridge.plist` |

For `SCOPE=system` setups, replace `gui/$UID` with `system` and `~/Library/LaunchAgents` with `/Library/LaunchDaemons`.
```

- [ ] **Step 6.4: Update File structure section**

Replace the `setup/` block in the file-structure tree with:

```
├── setup/
│   ├── install.sh                # OS-dispatching installer
│   ├── install-linux.sh          # Linux body
│   ├── install-macos.sh          # macOS body
│   ├── service.sh                # OS-dispatching service installer
│   ├── service-linux.sh          # systemd unit installer
│   ├── service-macos.sh          # launchd plist installer
│   ├── install-whisper.sh        # OS-dispatching whisper.cpp installer
│   ├── install-whisper-linux.sh  # cmake source build (apt deps)
│   ├── install-whisper-macos.sh  # brew install + symlink
│   └── systemd.sh                # deprecated shim → service.sh
```

- [ ] **Step 6.5: Verify rendering**

```bash
# Just spot-check the file looks right (no broken markdown).
grep -n "^##" README.md
```

Expected: Requirements, Setup, Managing the service, Config, Commands, How it works, File structure (in that order).

- [ ] **Step 6.6: Commit**

```bash
git add README.md
git commit -m "docs(readme): document macOS install and launchd service management

Adds Requirements/Setup subsections for macOS, a service-management
table for both systemd and launchd, and updates the file-structure
tree to reflect the dispatcher layout."
```

---

## Task 7: End-to-end verification on a real Mac

This task is manual and requires a Mac. Defer until you have access to one. The goal is to catch anything the cross-compile-style verification on Linux missed.

- [ ] **Step 7.1: Fresh clone + install**

On a Mac with Homebrew and Node.js 20+ installed:

```bash
git clone <repo> claude-matrix-bridge
cd claude-matrix-bridge
setup/install.sh
```

Expected: dispatcher picks `install-macos.sh`, npm install completes, `.env` is created with a populated `HMAC_SECRET`.

- [ ] **Step 7.2: Configure .env, install service (user scope)**

Edit `.env` to set `MATRIX_HOMESERVER_URL`, `MATRIX_ACCESS_TOKEN`, `ALLOWED_USER_IDS`, `VIEWER_BASE_URL`. Then:

```bash
setup/service.sh
```

Expected: two plists created in `~/Library/LaunchAgents/`, both pass `plutil -lint`, both load and bootstrap successfully. The script prints the lifecycle commands. Verify both services are running:

```bash
launchctl print gui/$UID/com.yearbook.claude-matrix-bridge | head -20
launchctl print gui/$UID/com.yearbook.claude-matrix-file-viewer | head -20
```

Expected: `state = running` for both.

- [ ] **Step 7.3: Send a Matrix message end-to-end**

From your Matrix client, send `!status` to the bridge bot. Expected: bridge replies with session info. Send `!start` then a normal message, confirm Claude Code responds.

- [ ] **Step 7.4: .env reload sanity check**

```bash
# Toggle DEBUG in .env
sed -i '' 's/^DEBUG=0/DEBUG=1/' .env
setup/service.sh
tail -f ~/Library/Logs/claude-matrix-bridge.log
```

Expected: re-running the service script tears down and re-bootstraps both services with the new env. Logs now show DEBUG output.

- [ ] **Step 7.5: Voice-note transcription**

```bash
setup/install-whisper.sh
# Add WHISPER_MODEL_PATH to .env per the script's output
setup/service.sh
```

Send a voice note in Matrix. Expected: bridge transcribes it using the brew-installed whisper-cli (via the symlink) and treats the transcript as the user message.

- [ ] **Step 7.6: System-wide service test (optional, separate Mac or VM)**

```bash
SCOPE=system sudo setup/service.sh
```

Expected: plists created in `/Library/LaunchDaemons/`, services bootstrap under `system/` target. Reboot the Mac, confirm services start automatically.

- [ ] **Step 7.7: restart.sh smoke test**

```bash
# Stop the launchd service first so it doesn't fight us.
launchctl bootout gui/$UID/com.yearbook.claude-matrix-bridge
bash restart.sh
```

Expected: starts a non-launchd bridge, log to `/tmp/claude-matrix-bridge.log`. Re-running it kills the previous PID using the lsof-based cwd match and starts a fresh one.

- [ ] **Step 7.8: Linux regression**

Back on the Ubuntu dev box:

```bash
sudo setup/service.sh
systemctl status claude-matrix-bridge claude-matrix-file-viewer
```

Expected: dispatcher routes to `service-linux.sh`, systemd units are written and started exactly as before. `setup/systemd.sh` still works (with deprecation warning).

- [ ] **Step 7.9: Final commit (only if any small fixes were needed during verification)**

If verification surfaced bugs, fix them and commit. Otherwise this task is read-only.

---

## Self-review notes

- **Spec coverage:** every section of the spec maps to a task: §"Script reorganization" → Task 1; §"macOS service via launchd" → Task 3; §"macOS whisper.cpp install" → Task 4; §"Other portability fixes" → Task 5; §"README updates" → Task 6; §"Testing" → Task 7.
- **Type/name consistency:** plist labels, log paths, target strings (`gui/$UID` vs `system`), and the `~/.local/share/whisper-cpp/build/bin/whisper-cli` symlink path are used consistently across tasks 3, 4, 6, 7.
- **No placeholders:** every code block contains the actual content; no "TBD" or "implement later".
- **YAGNI confirmed:** no source-build fallback for whisper, no CI matrix, no code changes to `index.js` or `viewer/` (audit confirmed they are already cross-platform).
