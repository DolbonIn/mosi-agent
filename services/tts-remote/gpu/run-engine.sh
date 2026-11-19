#!/bin/sh
# Start (or restart) one 모시 Drama-3 engine on the GPU box as a docker container (default name `mosi-tts-b`).
# Run it ON the GPU box from ~/mosi-tts (files: Dockerfile, mosi-drama3.yaml, voices/). See ../README.md.
#
# Two slots for blue/green swaps; the live one since 2026-11-12 is B:
#   ./run-engine.sh                                                   # B: mosi-tts-b on GPU 5, 127.0.0.1:8796
#   MOSI_TTS_NAME=mosi-tts MOSI_TTS_GPU=4 MOSI_TTS_PORT=8795 ./run-engine.sh     # A: the other slot (next swap)
#
# It replaces only the container called $MOSI_TTS_NAME, and refuses GPUs 0-3 (other people's jobs) and any GPU that
# is already in use. The engine listens on 127.0.0.1:$MOSI_TTS_PORT of the GPU box only (published on loopback).
set -eu
HERE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
GPU="${MOSI_TTS_GPU:-5}"
PORT="${MOSI_TTS_PORT:-8796}"
IMAGE="${MOSI_TTS_IMAGE:-mosi-tts:vllm-omni-0.32.0}"
DATA="${MOSI_TTS_DATA:-/mnt/shared/mosi-tts}"   # HF cache (41.5 GB of weights) on NFS, not on /
NAME="${MOSI_TTS_NAME:-mosi-tts-b}"
DEPLOY="${MOSI_TTS_DEPLOY:-mosi-drama3.yaml}"   # mosi-drama3-c32.yaml: the 32-stream benchmark variant
[ -f "$HERE/$DEPLOY" ] || { echo "no $HERE/$DEPLOY" >&2; exit 1; }

case "$GPU" in
  0|1|2|3) echo "refusing GPU $GPU: GPUs 0-3 belong to other people's jobs" >&2; exit 1 ;;
  4|5|6|7) ;;
  *) echo "MOSI_TTS_GPU must be one GPU index 4-7, got '$GPU'" >&2; exit 1 ;;
esac

# Only start on a GPU nobody else is using. Our own container of this name is replaced; to swap engines without a
# gap, start a second one under another name/GPU/port instead (see ../README.md, "엔진 교체").
if docker ps -q --filter "name=^/$NAME\$" | grep -q . && [ "${MOSI_TTS_REPLACE:-0}" != 1 ]; then
  echo "$NAME is running; replacing it silences its port for 5-12 min. Start a second engine under another" >&2
  echo "MOSI_TTS_NAME/GPU/PORT instead, or set MOSI_TTS_REPLACE=1 if nothing uses this one." >&2
  exit 1
fi
docker rm -f "$NAME" >/dev/null 2>&1 || true
sleep 2
used=$(nvidia-smi --query-gpu=memory.used --format=csv,noheader,nounits -i "$GPU" | tr -d ' ')
procs=$(nvidia-smi --query-compute-apps=pid --format=csv,noheader -i "$GPU" | grep -c . || true)
if [ "$procs" -gt 0 ] || [ "$used" -gt 2048 ]; then
  echo "GPU $GPU is busy ($procs processes, ${used} MiB used); not starting" >&2
  exit 1
fi

if ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
  docker build -t "$IMAGE" "$HERE"
fi

mkdir -p "$HERE/cache"
docker run -d --name "$NAME" --restart unless-stopped \
  --gpus "\"device=$GPU\"" --shm-size 16g \
  --user "$(id -u):$(id -g)" -e HOME=/cache \
  -p "127.0.0.1:$PORT:8000" \
  -e HF_HOME=/hf -e HF_HUB_OFFLINE=1 -e TRANSFORMERS_OFFLINE=1 \
  -e VLLM_NO_USAGE_STATS=1 -e DO_NOT_TRACK=1 -e VLLM_LOGGING_LEVEL=INFO \
  -v "$DATA/hf:/hf:ro" \
  -v "$HERE/voices:/voices:ro" \
  -v "$HERE/$DEPLOY:/deploy.yaml:ro" \
  -v "$HERE/cache:/cache" \
  --log-opt max-size=50m --log-opt max-file=3 \
  "$IMAGE" \
  vllm serve fishaudio/drama-3 --omni --host 0.0.0.0 --port 8000 \
    --deploy-config /deploy.yaml --allowed-local-media-path /voices \
    --disable-uvicorn-access-log --stage-init-timeout 1200 --init-timeout 1800

echo "started $NAME on GPU $GPU, http://127.0.0.1:$PORT (ready in ~5-10 min: weights, torch.compile, CUDA graphs; docker logs -f $NAME)"
