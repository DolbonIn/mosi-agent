#!/bin/sh
# Build the publishable bundle of the draft viewer (see bundle.ts for the layout and budget).
#   sh docs/design/drafts/bundle.sh [out-dir]
set -eu
here="$(cd "$(dirname "$0")" && pwd)"
out="${1:-${TMPDIR:-/tmp}/pickle-draft-bundle}"
exec bun "$here/bundle.ts" "$out"
