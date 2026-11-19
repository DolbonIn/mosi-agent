#!/bin/sh
# Build the SGLang-Omni 0.2.0 environment for Drama-3 on NFS. Uses no GPU: nothing here creates a CUDA context.
# Run it ON the GPU box from ~/mosi-tts, after copying the files there from the Mac:
#
#   scp services/tts-remote/gpu/install-sglang.sh services/tts-remote/gpu/run-sglang.sh \
#       services/tts-remote/gpu/sglang-omni-0.2.0.lock.txt gpu-host:mosi-tts/
#   ssh gpu-host 'cd ~/mosi-tts && ./install-sglang.sh'
#
# Everything goes under $MOSI_SGL_ROOT (default /mnt/shared/mosi-tts/sgl), nothing on /:
#   python/      uv-managed CPython 3.12            uv-cache/   uv's cache (the venv hardlinks from it)
#   venv-0.2.0/  the environment run-sglang.sh runs  cache/      runtime caches the container writes (HOME there)
#   tmp/         build scratch
# The venv is installed from the lock file (every package pinned, made with `uv pip compile`, see its header), so a
# re-run gives the same set. About 5.2 GB to download and ~13-15 GB on NFS. Re-running is safe: sync only fixes drift.
set -eu
HERE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
ROOT="${MOSI_SGL_ROOT:-/mnt/shared/mosi-tts/sgl}"
VENV="$ROOT/venv-0.2.0"
LOCK="$HERE/sglang-omni-0.2.0.lock.txt"
UV="${UV:-$HOME/.local/bin/uv}"

[ -f "$LOCK" ] || { echo "missing $LOCK" >&2; exit 1; }
mkdir -p "$ROOT/python" "$ROOT/uv-cache" "$ROOT/cache" "$ROOT/tmp"
export UV_CACHE_DIR="$ROOT/uv-cache" UV_PYTHON_INSTALL_DIR="$ROOT/python" UV_PYTHON_PREFERENCE=only-managed
export UV_LINK_MODE=hardlink   # cache and venv share the NFS volume, so the venv costs almost nothing extra
export TMPDIR="$ROOT/tmp"      # sdist builds (cdifflib, cuda-tile's wheel stub) must not fill /tmp on /
export CUDA_VISIBLE_DEVICES="" # belt and braces: no GPU is touched by anything below
export UV_HTTP_TIMEOUT=300

"$UV" python install 3.12
[ -x "$VENV/bin/python" ] || "$UV" venv --python 3.12 "$VENV"
# --compile-bytecode: the container mounts the venv read-only, so .pyc files must exist ahead of time
"$UV" pip sync --python "$VENV/bin/python" --compile-bytecode "$LOCK"

# import check without a GPU (CUDA_VISIBLE_DEVICES="" above): fails loudly on a missing or broken package
"$VENV/bin/python" - <<'PY'
import importlib.metadata as md, sys, torch
assert not torch.cuda.is_available(), "a GPU is visible to the import check; stop"
import sglang  # noqa: F401
from sglang_omni.models.fishaudio_drama3 import config, stages  # noqa: F401
from sglang_omni.serve import openai_api  # noqa: F401
print("python", sys.version.split()[0], "| " + ", ".join(f"{p} {md.version(p)}" for p in
      ("sglang-omni", "sglang", "sglang-kernel", "torch", "triton", "flashinfer-python", "transformers")))
print("torch cuda build", torch.version.cuda, "| default codec", config.DEFAULT_CODEC_PATH,
      "| stream_stride default", config.DEFAULT_STREAM_STRIDE)
PY
rm -rf "$ROOT/tmp"/* 2>/dev/null || true
du -sh "$ROOT/python" "$ROOT/uv-cache" "$VENV" 2>/dev/null
echo "ready: $VENV (start an engine with run-sglang.sh)"
