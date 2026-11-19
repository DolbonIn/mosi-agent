#!/bin/sh
# services/meet 시작: 127.0.0.1:${MEET_PORT:-8781}. Google Chrome이 필요하고, Playwright는 저장소 루트에 설치된 것을 쓴다.
# 환경 변수: MEET_PORT, MEET_STT(soniox|local), MEET_STT_URL(http://127.0.0.1:8782), MEET_TTS_URL(http://127.0.0.1:8790), MEET_TTS_VOICE, MEET_PROFILE_DIR
# 비밀값(SONIOX_API_KEY)은 ~/.config/pickle-clone/secrets.env(또는 PICKLE_SECRETS_FILE)를 --env-file로 읽는다. 화면·로그에 내지 않는다.
set -eu
HERE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
cd "$HERE/../.."
SECRETS="${PICKLE_SECRETS_FILE:-$HOME/.config/pickle-clone/secrets.env}"
if [ -r "$SECRETS" ]; then
  exec bun --env-file="$SECRETS" "$HERE/server.ts"
fi
exec bun "$HERE/server.ts"
