#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NODE_CMD="${NODE_CMD:-node}"

exec "$NODE_CMD" "$SCRIPT_DIR/lib/beads-migrate-to-dolt.mjs" "$@"
