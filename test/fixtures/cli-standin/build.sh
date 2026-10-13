#!/bin/sh
# What cli/build.sh promises the app build: a macOS arm64 binary at dist/todos-darwin-arm64.
set -e
cd "$(dirname "$0")"
mkdir -p dist
GOOS=darwin GOARCH=arm64 CGO_ENABLED=0 go build -o dist/todos-darwin-arm64 .
