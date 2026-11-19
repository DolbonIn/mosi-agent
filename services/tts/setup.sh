#!/bin/sh
# One-time setup of the local Drama-3 TTS environment (Apple Silicon, ~22 GB model download on first run).
set -eu
HERE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
uv venv --python 3.12 "$HERE/.venv"
# mlx-audio main gained Drama-3 after 0.5.9; pinned to the commit verified on an M3 Max
uv pip install --python "$HERE/.venv" \
  "mlx-audio @ git+https://github.com/Blaizzy/mlx-audio@1865f49cc9a40de9b5e4fcf55952b9812d751f1d" soundfile numpy
HF_HUB_OFFLINE=0 "$HERE/.venv/bin/python" -c "from huggingface_hub import snapshot_download as s; s('mlx-community/fish-audio-drama-3-4bit')"
echo "ok: start with services/tts/start.sh"
