#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"
out="${1:-../../packages/core/bin}"
mkdir -p "$out"

targets=(
  "linux-x64 linux amd64"
  "linux-arm64 linux arm64"
  "darwin-x64 darwin amd64"
  "darwin-arm64 darwin arm64"
  "win32-x64 windows amd64"
  "win32-arm64 windows arm64"
)

for target in "${targets[@]}"; do
  read -r name goos goarch <<<"$target"
  suffix=""
  if [[ "$goos" == "windows" ]]; then suffix=".exe"; fi
  echo "building $name"
  GOOS="$goos" GOARCH="$goarch" CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o "$out/html-to-markdown-$name$suffix" .
done

echo "binaries written to $out"
