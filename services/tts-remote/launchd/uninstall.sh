#!/bin/sh
# Remove the launchd agent installed by install.sh: unload it, delete its plist and the runtime copy.
# The tunnel and the adapter are left running (the agent abandons them); stop those with ../down.sh.
#   services/tts-remote/launchd/uninstall.sh       # TTS_LAUNCHD_LABEL / TTS_INSTALL_DIR as given to install.sh
set -u
LABEL="${TTS_LAUNCHD_LABEL:-com.mosi.tts-remote}"
DEST="${TTS_INSTALL_DIR:-$HOME/Library/Application Support/mosi-tts-remote}"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null && echo "unloaded $LABEL" || echo "$LABEL was not loaded"
rm -f "$PLIST"
# only the copy install.sh made (it always holds watchdog.sh); never a path that does not look like one
if [ -f "$DEST/watchdog.sh" ] && [ -f "$DEST/server.py" ]; then
  rm -rf "$DEST" && echo "removed $DEST"
fi
echo "tunnel and adapter left running; stop them with down.sh"
