#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
PASS=0
FAIL=0

assert_contains_file() {
  local label="$1" pattern="$2" file="$3"
  if grep -q "$pattern" "$file" 2>/dev/null; then
    PASS=$((PASS + 1)); echo "  PASS: $label"
  else
    FAIL=$((FAIL + 1)); echo "  FAIL: $label (pattern '$pattern' not in $file)"
  fi
}

echo "── /status integration ──"
STATUS="$SCRIPT_DIR/.claude/commands/status.md"
assert_contains_file "status calls workload --me" "forge-team.*workload.*--me" "$STATUS"
assert_contains_file "status calls dashboard" "forge-team.*dashboard" "$STATUS"

echo ""
echo "── /plan integration ──"
PLAN="$SCRIPT_DIR/.claude/commands/plan.md"
assert_contains_file "plan calls verify" "forge-team.*verify" "$PLAN"

echo ""
echo "── /ship integration ──"
SHIP="$SCRIPT_DIR/.claude/commands/ship.md"
assert_contains_file "ship calls sync" "forge-team.*sync" "$SHIP"
assert_contains_file "ship calls verify" "forge-team.*verify" "$SHIP"

echo ""
echo "── Sync check ──"
if node "$SCRIPT_DIR/scripts/sync-commands.js" --check 2>&1 | grep -qi 'error\|drift\|mismatch'; then
  FAIL=$((FAIL + 1)); echo "  FAIL: sync drift detected"
else
  PASS=$((PASS + 1)); echo "  PASS: all agent dirs in sync"
fi

echo ""
echo "Results: $PASS passed, $FAIL failed"
[[ $FAIL -eq 0 ]] && exit 0 || exit 1
