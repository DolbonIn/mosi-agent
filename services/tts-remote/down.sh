#!/bin/sh
# Stop the adapter and the tunnel started by up.sh (by their pid files only; nothing else is touched).
set -u
RUN="${TTS_RUN_DIR:-$HOME/Library/Logs/mosi-tts-remote}"
for name in adapter tunnel; do
  f="$RUN/$name.pid"
  if [ -f "$f" ] && pid=$(cat "$f") && kill -0 "$pid" 2>/dev/null; then
    kill "$pid" && echo "stopped $name (pid $pid)"
  else
    echo "$name not running"
  fi
  rm -f "$f"
done
