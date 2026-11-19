#!/bin/sh
# Start the local STT server on 127.0.0.1:${STT_PORT:-8782}. Needs ~2 GB of free unified memory.
set -eu
HERE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
PY="${STT_PYTHON:-$HERE/.venv/bin/python}"
export HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1 TOKENIZERS_PARALLELISM=false PYTHONUNBUFFERED=1
exec "$PY" -I "$HERE/server.py"
