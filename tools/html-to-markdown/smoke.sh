#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$root"

if ! compgen -G "packages/core/bin/html-to-markdown-*" >/dev/null; then
  tools/html-to-markdown/build.sh
fi

(cd apps/cli && bun run build >/dev/null)
tgz="$(cd apps/cli && rm -f webmesh.js-*.tgz && bun pm pack >/dev/null && ls webmesh.js-*.tgz | head -1)"

smoke="$(mktemp -d)"
trap 'rm -rf "$smoke"' EXIT
cd "$smoke"
printf '{"name":"webmesh-smoke","private":true,"type":"module"}' >package.json
bun add "$root/apps/cli/$tgz" >/dev/null

WEBMESH_SMOKE_BIN="$smoke/node_modules/.bin/webmesh" bun run "$root/tools/html-to-markdown/smoke.ts"
