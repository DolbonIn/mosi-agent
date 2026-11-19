#!/bin/sh
# Start the local TTS server on 127.0.0.1:${TTS_PORT:-8790}. Needs ffmpeg and ~28 GB of free unified memory.
set -eu
HERE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
PY="${TTS_PYTHON:-$HERE/.venv/bin/python}"
export HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1 TOKENIZERS_PARALLELISM=false PYTHONUNBUFFERED=1
exec "$PY" -I "$HERE/server.py"
