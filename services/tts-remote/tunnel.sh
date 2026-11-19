#!/bin/sh
# SSH tunnel to the GPU box's TTS engine, reconnecting forever (autossh-style, plain ssh).
#   127.0.0.1:${TTS_ENGINE_PORT:-8795} (Mac)  ->  127.0.0.1:${MOSI_TTS_PORT:-8796} (GPU box, docker container mosi-tts-b)
# The Mac side stays 8795 whichever engine slot is live (A: mosi-tts :8795, B: mosi-tts-b :8796; see README "엔진 교체").
# Needs the `gpu-host` host alias with key auth in ~/.ssh/config. Override with TTS_SSH_HOST.
set -u
HOST="${TTS_SSH_HOST:-gpu-host}"
LOCAL="${TTS_ENGINE_PORT:-8795}"
REMOTE="${MOSI_TTS_PORT:-8796}"
RUN="${TTS_RUN_DIR:-$HOME/Library/Logs/mosi-tts-remote}"
mkdir -p "$RUN"
echo $$ > "$RUN/tunnel.pid"
child=""
trap '[ -n "$child" ] && kill "$child" 2>/dev/null; rm -f "$RUN/tunnel.pid"; exit 0' INT TERM HUP
delay=1
while :; do
  started=$(date +%s)
  echo "[mosi/tts-tunnel] $(date '+%H:%M:%S') connecting 127.0.0.1:$LOCAL -> $HOST:127.0.0.1:$REMOTE" >&2
  # keepalives notice a dead link within ~45 s; ExitOnForwardFailure makes a taken port an error, not a silent no-op
  ssh -N -o BatchMode=yes -o ExitOnForwardFailure=yes -o ServerAliveInterval=15 -o ServerAliveCountMax=3 \
      -o ConnectTimeout=10 -o TCPKeepAlive=yes \
      -L "127.0.0.1:$LOCAL:127.0.0.1:$REMOTE" "$HOST" &
  child=$!
  wait "$child"
  code=$?
  child=""
  # a link that held for a while reconnects at once; repeated failures back off up to 30 s
  if [ $(( $(date +%s) - started )) -gt 60 ]; then delay=1; else delay=$(( delay * 2 > 30 ? 30 : delay * 2 )); fi
  echo "[mosi/tts-tunnel] $(date '+%H:%M:%S') ssh exited ($code); reconnecting in ${delay}s" >&2
  sleep "$delay"
done
