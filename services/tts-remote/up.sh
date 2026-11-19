#!/bin/sh
# Start the tunnel and the adapter in detached screen sessions (mosi-tts-tunnel, mosi-tts-remote).
# Logs and pid files: ${TTS_RUN_DIR:-~/Library/Logs/mosi-tts-remote}. Stop with down.sh.
set -eu
HERE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
RUN="${TTS_RUN_DIR:-$HOME/Library/Logs/mosi-tts-remote}"
mkdir -p "$RUN"
alive() { [ -f "$RUN/$1.pid" ] && kill -0 "$(cat "$RUN/$1.pid")" 2>/dev/null; }
if alive tunnel; then echo "tunnel already running (pid $(cat "$RUN/tunnel.pid"))"; else
  screen -dmS mosi-tts-tunnel sh -c "'$HERE/tunnel.sh' >> '$RUN/tunnel.log' 2>&1"; echo "tunnel started"; fi
if alive adapter; then echo "adapter already running (pid $(cat "$RUN/adapter.pid"))"; else
  screen -dmS mosi-tts-remote sh -c "'$HERE/start.sh' >> '$RUN/adapter.log' 2>&1"; echo "adapter started"; fi
sleep 4
curl -s -m 3 "http://127.0.0.1:${TTS_PORT:-8794}/health" || echo "adapter not answering yet: see $RUN/adapter.log"
echo
