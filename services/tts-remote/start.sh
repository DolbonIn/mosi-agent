#!/bin/sh
# Start the Mac-side adapter on 127.0.0.1:${TTS_PORT:-8794}: the services/tts API, backed by the GPU box engine
# through the SSH tunnel (tunnel.sh). Needs python3 (stdlib only) and ffmpeg. up.sh starts both in screen sessions.
set -eu
HERE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
RUN="${TTS_RUN_DIR:-$HOME/Library/Logs/mosi-tts-remote}"
mkdir -p "$RUN"
echo $$ > "$RUN/adapter.pid"   # exec keeps this pid
export PYTHONUNBUFFERED=1
exec "${TTS_PYTHON:-python3}" -I "$HERE/server.py"
