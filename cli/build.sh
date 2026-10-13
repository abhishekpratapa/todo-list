#!/bin/sh
# Builds the todos command.
#
#   ./build.sh        the macOS arm64 binary the Todos app carries inside it,
#                     at dist/todos-darwin-arm64. This is what `npm run dist` runs.
#   ./build.sh all    that, plus standalone binaries for Linux (amd64 and arm64),
#                     for machines that reach the Mac over the tailnet.
#
# Every binary is static (no cgo) and needs nothing installed to run. All of
# them are cross-compiled here; only Go is needed.
set -eu
cd "$(dirname "$0")"

if ! command -v go >/dev/null 2>&1; then
  echo "Go was not found. Install it (https://go.dev/dl, or: brew install go) and run this again." >&2
  exit 1
fi

targets="darwin/arm64"
case "${1:-}" in
  "") ;;
  all) targets="darwin/arm64 linux/amd64 linux/arm64" ;;
  *) echo "usage: ./build.sh [all]" >&2; exit 2 ;;
esac

mkdir -p dist
for target in $targets; do
  os=${target%/*}
  arch=${target#*/}
  CGO_ENABLED=0 GOOS="$os" GOARCH="$arch" go build -trimpath -ldflags "-s -w" -o "dist/todos-$os-$arch" .
  echo "built dist/todos-$os-$arch"
done
