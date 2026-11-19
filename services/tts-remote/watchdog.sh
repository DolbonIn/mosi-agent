#!/bin/sh
# Keeps the tunnel and the adapter alive. Meant to run under launchd (launchd/install.sh: at login, and again if it
# dies), which is NOT installed: that needs the Mac owner's OK. It can also be run once by hand, in the foreground.
# Every 15 s, whichever of the two has no live process (pid file + command line check) is started in a detached
# screen session, exactly as up.sh does. A live one is never restarted or stopped.
set -u
HERE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
RUN="${TTS_RUN_DIR:-$HOME/Library/Logs/mosi-tts-remote}"
PREFIX="${TTS_SCREEN_PREFIX:-mosi-tts}"
mkdir -p "$RUN"
alive() {  # $1 = name (pid file), $2 = text its command line must contain (guards against a reused pid)
  [ -f "$RUN/$1.pid" ] || return 1
  pid=$(cat "$RUN/$1.pid" 2>/dev/null) || return 1
  ps -p "$pid" -o command= 2>/dev/null | grep -q "$2"
}
say() { echo "[mosi/tts-watchdog] $(date '+%F %T') $*"; }
say "watching $RUN (screen prefix $PREFIX)"
while :; do
  if ! alive tunnel tunnel.sh; then
    say "tunnel not running; starting"
    screen -dmS "$PREFIX-tunnel" sh -c "'$HERE/tunnel.sh' >> '$RUN/tunnel.log' 2>&1"
  fi
  if ! alive adapter server.py; then
    say "adapter not running; starting"
    screen -dmS "$PREFIX-remote" sh -c "'$HERE/start.sh' >> '$RUN/adapter.log' 2>&1"
  fi
  sleep 15
done
