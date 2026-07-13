#!/usr/bin/env bash
# Run "$@" under a private Xvfb display, guaranteeing the Xvfb dies with us.
#
# Replaces xvfb-run for the browser MCP stack. xvfb-run is a /bin/sh (dash)
# script whose ONLY cleanup is `trap clean_up EXIT` — and dash does not run
# EXIT traps when killed by a signal while waiting on a foreground child,
# which is exactly how claude tears down MCP servers (SIGTERM). Every
# reaped/crashed browser session therefore stranded one Xvfb (39 orphans
# found on dev-6 when this was written), and the strays then made xvfb-run's
# --auto-servernum display probing retry-storm on "server already running".
#
# Two independent lifetime guarantees:
#   1. Explicit TERM/INT/HUP traps + an EXIT trap. Unlike xvfb-run, the
#      wrapped command runs in the BACKGROUND and we `wait` on it — wait is
#      interruptible by trapped signals, so the traps actually fire.
#   2. PR_SET_PDEATHSIG (via setpriv) on both Xvfb and the command: the
#      kernel SIGTERMs them if this wrapper dies for ANY reason — including
#      SIGKILL, where no userspace trap can run. setpriv is util-linux
#      (present on any Debian/Ubuntu host); degrade gracefully without it.
#
# Xvfb picks its own free display via -displayfd (race-free, no lock-file
# probing), so strays from the xvfb-run era can't collide with us.
#
# XVFB_WRAP_XVFB_BIN overrides the Xvfb binary (test seam).
set -u

XVFB_BIN="${XVFB_WRAP_XVFB_BIN:-Xvfb}"

PDEATH=()
if command -v setpriv >/dev/null 2>&1; then
  PDEATH=(setpriv --pdeathsig SIGTERM)
fi

XVFB_PID=""
CMD_PID=""

cleanup() {
  if [ -n "$CMD_PID" ]; then
    # The command runs as its own process-group leader (setsid below), so a
    # group kill reaches its descendants too — npx's real MCP child is what
    # claude actually talks to, and it must not outlive us waiting on a
    # stdin EOF that may never come.
    kill -TERM -- "-$CMD_PID" 2>/dev/null || kill -TERM "$CMD_PID" 2>/dev/null
  fi
  [ -n "$XVFB_PID" ] && kill -TERM "$XVFB_PID" 2>/dev/null
  return 0
}
trap cleanup EXIT
trap 'exit 143' TERM
trap 'exit 130' INT
trap 'exit 129' HUP

FIFO=$(mktemp -u "${TMPDIR:-/tmp}/xvfb-wrap.XXXXXX")
if ! mkfifo "$FIFO"; then
  echo "xvfb-wrap: cannot create fifo $FIFO" >&2
  exit 1
fi

# Xvfb writes its chosen display number to fd 3 once it's ready to accept
# connections — no polling, no lock-file races. Stderr is left attached so
# a startup failure is visible in claude's MCP logs (xvfb-run's default of
# /dev/null is what made the original leak so hard to see).
"${PDEATH[@]}" "$XVFB_BIN" -displayfd 3 -screen 0 1920x1080x24 -nolisten tcp 3>"$FIFO" &
XVFB_PID=$!

DISPLAY_NUM=""
read -r -t 15 DISPLAY_NUM <"$FIFO" || true
rm -f "$FIFO"
if [ -z "$DISPLAY_NUM" ]; then
  echo "xvfb-wrap: Xvfb failed to start (no display number within 15s)" >&2
  exit 1
fi
export DISPLAY=":$DISPLAY_NUM"

# <&0 keeps the wrapper's stdin attached: bash redirects a backgrounded
# command's stdin to /dev/null unless explicitly redirected, and the MCP
# protocol runs over this pipe. setsid makes the command a process-group
# leader so cleanup can group-kill its whole descendant tree (it execs in
# place — a background job here is never already a group leader — so
# CMD_PID is the command itself and pdeathsig lands on it too).
setsid "${PDEATH[@]}" "$@" <&0 &
CMD_PID=$!
wait "$CMD_PID"
rc=$?
CMD_PID=""
exit "$rc"
