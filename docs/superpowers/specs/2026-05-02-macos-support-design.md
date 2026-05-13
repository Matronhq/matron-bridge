# macOS support for claude-matrix-bridge

## Goal

Make the bridge installable and runnable on macOS with the same scope as Linux: manual run, background service via `launchd`, and voice-note transcription via whisper.cpp.

## Non-goals

- CI matrix testing on macOS. Setup is manually verified on a real Mac.
- Any change to the bridge runtime code (`index.js`, `viewer/`, `lib/`, `hooks/matron-tee`). Audit confirmed it is already cross-platform: uses `os.tmpdir()`, and the `/tmp/matron-cmd-*` regex in `index.js:639` works on macOS where `/tmp` is a symlink to `/private/tmp`.
- Windows support.
- Source-build fallback for whisper.cpp (brew handles bottle-vs-source transparently when no bottle is available for the user's macOS version).

## Requirements

A macOS user with Homebrew installed should be able to:

1. Clone the repo and run `setup/install.sh` to install Node deps and seed `.env`.
2. Edit `.env` and run `setup/service.sh` to install a launchd service that starts at login (default) or boot (`SCOPE=system`, with sudo).
3. Optionally run `setup/install-whisper.sh` to enable voice-note transcription.
4. Re-run `setup/service.sh` after editing `.env` to apply environment changes.

A Linux user's existing flow must keep working unchanged.

## Architecture

### Script layout

OS-specific scripts live side by side; thin dispatchers detect the OS via `uname -s` and `exec` the appropriate variant. Existing entry-point names are preserved as the dispatchers, so the README and any external documentation referring to `setup/install.sh` and `setup/install-whisper.sh` keep working.

```
setup/
  install.sh                # dispatcher
  install-linux.sh          # current install.sh body, unchanged
  install-macos.sh          # new

  service.sh                # dispatcher (new entry point, replaces systemd.sh)
  service-linux.sh          # current systemd.sh body, unchanged
  service-macos.sh          # new
  systemd.sh                # deprecation shim: exec service.sh

  install-whisper.sh        # dispatcher
  install-whisper-linux.sh  # current install-whisper.sh body, unchanged
  install-whisper-macos.sh  # new
```

Each dispatcher is ~10 lines: detect OS, refuse unknown, exec the matching script with the same environment and arguments.

### macOS service via launchd

`setup/service-macos.sh` writes one or two plists depending on the `SCOPE` environment variable (default `user`):

| `SCOPE` | Plist directory | Owner | Bootstrap target |
|---|---|---|---|
| `user` (default) | `~/Library/LaunchAgents/` | current user | `gui/$UID` |
| `system` | `/Library/LaunchDaemons/` | root (requires `sudo`) | `system` |

Two plists per scope, mirroring the systemd setup:

- `com.yearbook.claude-matrix-bridge.plist` — runs `node index.js`
- `com.yearbook.claude-matrix-file-viewer.plist` — runs `node viewer/server.js`

Plist contents (per service):

- `ProgramArguments` → `[<NODE_BIN>, <REPO_DIR>/index.js]` (or `viewer/server.js`)
- `WorkingDirectory` → `<REPO_DIR>`
- `EnvironmentVariables` → `PATH` set to `~/.claude/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin` (covers Apple Silicon and Intel brew prefixes), plus every non-empty `KEY=VALUE` line read from `.env` and inlined at install time
- `RunAtLoad` → `true`
- `KeepAlive` → `{ "SuccessfulExit": false }` (restart on crash, equivalent to systemd `Restart=always`)
- `StandardOutPath` / `StandardErrorPath`:
  - `user` scope: `~/Library/Logs/claude-matrix-bridge.log` and `claude-matrix-file-viewer.log`
  - `system` scope: `/var/log/claude-matrix-bridge.log` and `/var/log/claude-matrix-file-viewer.log`

launchd has no `EnvironmentFile` equivalent. The script reads `.env` at install time and inlines the values into each plist's `EnvironmentVariables` dict. Re-running `setup/service.sh` is required after editing `.env`. This is documented in the README.

The script is idempotent: it always calls `launchctl bootout <target>/<label>` first (ignoring the "not loaded" error), writes the plist, then `launchctl bootstrap <target> <plist>`. This way re-running after a `.env` edit cleanly reloads the service with the new environment.

- `user`: target is `gui/$UID`
- `system`: target is `system`. Plist is written as root (the script invokes itself with `sudo` for this scope) and chmod'd to 644.

It then prints lifecycle commands the user will need:

- Start/restart: `launchctl kickstart -k gui/$UID/com.yearbook.claude-matrix-bridge`
- Stop: `launchctl kill TERM gui/$UID/com.yearbook.claude-matrix-bridge`
- Logs: `tail -f ~/Library/Logs/claude-matrix-bridge.log`
- Uninstall: `launchctl bootout gui/$UID/com.yearbook.claude-matrix-bridge && rm <plist>`

(`gui/$UID/` becomes `system/` for `SCOPE=system`.)

### macOS whisper.cpp install

`setup/install-whisper-macos.sh` flow:

1. Verify `brew` is on `PATH`. Bail with a clear message pointing to <https://brew.sh> if not.
2. `brew install whisper-cpp ffmpeg`. (`ffmpeg` is required by `lib/transcribe.js` regardless.)
3. Locate the brew binary via `brew --prefix whisper-cpp` and verify `<prefix>/bin/whisper-cli --help` runs.
4. Create `~/.local/share/whisper-cpp/build/bin/` and symlink the brew `whisper-cli` into it. This keeps `lib/transcribe.js`'s derived binary path (`<modelDir>/../build/bin/whisper-cli`) unchanged, avoiding a code change.
5. Create `~/.local/share/whisper-cpp/models/`. If the `small` model isn't already there, fetch the `download-ggml-model.sh` script from the whisper.cpp repo and run it to download `ggml-small.bin`. (We can't rely on a checked-out clone like the Linux script does, since brew gave us only the binary — we curl the script directly.)

`INSTALL_DIR` defaults to `~/.local/share/whisper-cpp` on both platforms, keeping `WHISPER_MODEL_PATH` in `.env` portable.

Apple Silicon Metal acceleration is included in the brew bottle automatically — Metal is a runtime API, the pre-built binary calls it on Apple Silicon at runtime.

If `brew install whisper-cpp` fails (formula removed, network failure, etc.), the script prints the error and exits non-zero. No source-build fallback.

### Other portability fixes

**`restart.sh`** uses `readlink /proc/$pid/cwd`, which doesn't exist on macOS. Replace the cwd-match block with `lsof`, which exists on both platforms:

```bash
pgrep -f "node index.js" | while read pid; do
  PROC_CWD=$(lsof -a -p "$pid" -d cwd -Fn 2>/dev/null | awk '/^n/{print substr($0,2); exit}')
  if [ "$PROC_CWD" = "$(pwd)" ]; then
    echo "Killing bridge PID $pid (cwd match)"
    kill $pid 2>/dev/null || true
  fi
done
```

No platform branch needed.

**`install-linux.sh`** keeps GNU `sed -i "s/.../.../" file`. **`install-macos.sh`** uses BSD `sed -i '' "s/.../.../" file`. Each script uses its native form rather than introducing a portable Perl one-liner.

### README updates

- **Requirements** section: split into "Linux (Ubuntu/Debian)" and "macOS" subsections. macOS adds: Homebrew, Xcode Command Line Tools (provides `git`, `clang`).
- **Setup** section: gain a "macOS" subsection covering `setup/install.sh`, edit `.env`, then `setup/service.sh` (default `SCOPE=user`, alternative `SCOPE=system sudo setup/service.sh`).
- New **macOS service management** subsection listing the launchctl commands the install script prints (start, stop, logs, uninstall).
- Explicit note: re-run `setup/service.sh` after editing `.env` (no `EnvironmentFile` equivalent on launchd).
- Voice-note section: link to `setup/install-whisper.sh`, which dispatches to the right script.

## Testing

Manual verification on a real Mac (both Apple Silicon and Intel if available):

1. Fresh clone, run `setup/install.sh`, confirm `.env` is created and `npm install` succeeds.
2. Fill in `.env`, run `setup/service.sh` with default `SCOPE`. Confirm both LaunchAgents load and start.
3. Send a Matrix message, confirm the bridge handles it end to end.
4. Edit `.env` (e.g., change `DEBUG=1`), re-run `setup/service.sh`, confirm the new value takes effect.
5. Run `setup/install-whisper.sh`, send a voice note in Matrix, confirm transcription works.
6. Run `SCOPE=system sudo setup/service.sh` on a separate test Mac, reboot, confirm services start at boot.

Linux regression check: on the existing dev server, run `setup/install.sh` and `setup/service.sh` (now via the dispatcher), confirm services restart cleanly and behavior is unchanged.

## Files touched

**New:**
- `setup/install-linux.sh` (extracted from current `install.sh`)
- `setup/install-macos.sh`
- `setup/service-linux.sh` (extracted from current `systemd.sh`)
- `setup/service-macos.sh`
- `setup/install-whisper-linux.sh` (extracted from current `install-whisper.sh`)
- `setup/install-whisper-macos.sh`

**Modified:**
- `setup/install.sh` → dispatcher
- `setup/install-whisper.sh` → dispatcher
- `setup/systemd.sh` → deprecation shim that execs `setup/service.sh`
- `restart.sh` → swap `/proc/$pid/cwd` for `lsof`
- `README.md` → macOS sections

**New entry point:**
- `setup/service.sh` → dispatcher (new public entry point)
