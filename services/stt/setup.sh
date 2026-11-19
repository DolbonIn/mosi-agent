#!/bin/sh
# One-time setup of the local STT environment (Apple Silicon). Whisper large-v3-turbo (MLX, ~1.6 GB) is
# downloaded into the Hugging Face cache on first run; later runs are offline.
set -eu
HERE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
uv venv --python 3.12 "$HERE/.venv"
# 0.4.3 verified on an M3 Max (mlx 0.32.4). Don't swap in mlx-audio's whisper loader: it fails on this snapshot.
uv pip install --python "$HERE/.venv" "mlx-whisper==0.4.3"
HF_HUB_OFFLINE=0 "$HERE/.venv/bin/python" -c "from huggingface_hub import snapshot_download as s; s('${STT_MODEL:-mlx-community/whisper-large-v3-turbo}')"
echo "ok: start with services/stt/start.sh"
