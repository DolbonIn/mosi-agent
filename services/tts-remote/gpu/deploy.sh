#!/bin/sh
# From the Mac: copy the engine files and voices to the GPU box (~/mosi-tts) and (re)start the engine there.
#   services/tts-remote/gpu/deploy.sh            # copy + start slot B: mosi-tts-b (GPU 5, :8796); refuses if running
#   MOSI_TTS_NAME=mosi-tts MOSI_TTS_GPU=4 MOSI_TTS_PORT=8795 services/tts-remote/gpu/deploy.sh   # slot A (next swap)
#   MOSI_TTS_REPLACE=1 services/tts-remote/gpu/deploy.sh   # replace a running mosi-tts-b (5-12 min with no engine)
# While apps use the engine, never replace the live one: start a second one, verify it, swap, then stop the old one.
# The first run also builds the image (~2 min; the 33 GB vllm/vllm-openai:v0.32.0 base must already be on the box)
# and needs the weights in /mnt/shared/mosi-tts/hf (see ../README.md).
set -eu
HERE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
HOST="${TTS_SSH_HOST:-gpu-host}"
ssh "$HOST" 'mkdir -p ~/mosi-tts/voices'
scp -q "$HERE/Dockerfile" "$HERE/mosi-drama3.yaml" "$HERE/mosi-drama3-c32.yaml" "$HERE/run-engine.sh" "$HOST:mosi-tts/"
scp -q "$HERE/../../tts/voices/"*.wav "$HERE/../../tts/voices/"*.txt "$HOST:mosi-tts/voices/"
ssh "$HOST" "cd ~/mosi-tts && chmod +x run-engine.sh && MOSI_TTS_REPLACE=${MOSI_TTS_REPLACE:-0} MOSI_TTS_NAME=${MOSI_TTS_NAME:-mosi-tts-b} MOSI_TTS_GPU=${MOSI_TTS_GPU:-5} MOSI_TTS_PORT=${MOSI_TTS_PORT:-8796} ./run-engine.sh"
