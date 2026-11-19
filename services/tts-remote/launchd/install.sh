#!/bin/sh
# Install the launchd agent that keeps the tunnel and the adapter running (../watchdog.sh), at login too.
#
#   NOT installed by default. This is a persistent change to this Mac (a shared machine): run it only with the
#   owner's OK. Undo with uninstall.sh.
#
#   services/tts-remote/launchd/install.sh           # label com.mosi.tts-remote
#   services/tts-remote/launchd/install.sh --print   # only print the plist it would write; changes nothing
#
# macOS does not let launchd agents read ~/Documents (TCC: "Operation not permitted"), so this copies the runtime
# (server.py, start.sh, tunnel.sh, watchdog.sh and the voices) to $TTS_INSTALL_DIR
# (default ~/Library/Application Support/mosi-tts-remote) and the agent runs that copy. Run it again after changing
# any of those files. The watchdog only starts what has no live process (pid file + command line), so installing
# never restarts or stops a running tunnel or adapter.
#
# Extra environment for the watchdog and what it starts (TTS_RUN_DIR, TTS_PORT, TTS_ENGINE, TTS_ENGINE_PORT,
# TTS_SCREEN_PREFIX, TTS_SSH_HOST, MOSI_TTS_PORT) is copied into the agent when set; TTS_LAUNCHD_LABEL picks another
# label (for a second instance on other ports).
set -eu
HERE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
SRC=$(CDPATH= cd -- "$HERE/.." && pwd)
LABEL="${TTS_LAUNCHD_LABEL:-com.mosi.tts-remote}"
DEST="${TTS_INSTALL_DIR:-$HOME/Library/Application Support/mosi-tts-remote}"
RUN="${TTS_RUN_DIR:-$HOME/Library/Logs/mosi-tts-remote}"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
DOMAIN="gui/$(id -u)"

ENVS=""
for k in TTS_RUN_DIR TTS_PORT TTS_ENGINE TTS_ENGINE_PORT TTS_SCREEN_PREFIX TTS_SSH_HOST MOSI_TTS_PORT; do
  eval "v=\${$k:-}"
  [ -n "$v" ] && ENVS="$ENVS    <key>$k</key><string>$v</string>
"
done
export ENVS LABEL DEST RUN
# fill the template (awk reads the values from the environment, so paths with spaces or slashes are safe)
render() {
  awk '
    /@ENV@/ { printf "%s", ENVIRON["ENVS"]; next }
    { gsub(/@LABEL@/, ENVIRON["LABEL"]); gsub(/@DEST@/, ENVIRON["DEST"]); gsub(/@RUN@/, ENVIRON["RUN"]);
      gsub(/@HOME@/, ENVIRON["HOME"]); print }
  ' "$HERE/com.mosi.tts-remote.plist"
}
if [ "${1:-}" = --print ]; then render; exit 0; fi

mkdir -p "$RUN" "$HOME/Library/LaunchAgents" "$DEST/voices"
cp "$SRC/server.py" "$SRC/start.sh" "$SRC/tunnel.sh" "$SRC/watchdog.sh" "$DEST/"
cp "$SRC/../tts/voices/"*.wav "$SRC/../tts/voices/"*.txt "$DEST/voices/"
chmod +x "$DEST/"*.sh

render > "$PLIST.tmp"
plutil -lint "$PLIST.tmp" >/dev/null
mv "$PLIST.tmp" "$PLIST"

launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
launchctl bootstrap "$DOMAIN" "$PLIST"
echo "installed $LABEL: runs $DEST/watchdog.sh (plist $PLIST, log $RUN/watchdog.log)"
echo "undo: $HERE/uninstall.sh"
