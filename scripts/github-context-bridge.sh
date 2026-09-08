#!/usr/bin/env bash
# GH_CMD bridge: re-enter this Forge runtime without credentials in the Bash parent.
set -euo pipefail

: "${FORGE_GITHUB_RUNTIME:?Forge GitHub runtime is required}"
if [[ -n "${FORGE_GITHUB_ENTRY:-}" ]]; then
  exec "$FORGE_GITHUB_RUNTIME" "$FORGE_GITHUB_ENTRY" github run -- gh "$@"
else
  exec "$FORGE_GITHUB_RUNTIME" github run -- gh "$@"
fi
