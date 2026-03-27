#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PASS=0
FAIL=0

assert_contains_file() {
  local label="$1" pattern="$2" file="$3"
  if grep -q "$pattern" "$file" 2>/dev/null; then
    PASS=$((PASS + 1)); echo "  PASS: $label"
  else
    FAIL=$((FAIL + 1)); echo "  FAIL: $label (pattern '$pattern' not found in $file)"
  fi
}

echo "── /plan command integration ──"
PLAN="$SCRIPT_DIR/.claude/commands/plan.md"
assert_contains_file "plan calls merge-sim" "pr-coordinator.sh merge-sim" "$PLAN"
assert_contains_file "plan calls merge-order" "pr-coordinator.sh merge-order" "$PLAN"
assert_contains_file "plan calls stale-worktrees" "pr-coordinator.sh stale-worktrees" "$PLAN"
assert_contains_file "plan has soft-block prompt" "Proceed with planning anyway" "$PLAN"

echo ""
echo "── /ship command integration ──"
SHIP="$SCRIPT_DIR/.claude/commands/ship.md"
assert_contains_file "ship calls merge-sim" "pr-coordinator.sh merge-sim" "$SHIP"
assert_contains_file "ship calls merge-order" "pr-coordinator.sh merge-order" "$SHIP"
assert_contains_file "ship calls auto-label" "pr-coordinator.sh auto-label" "$SHIP"
assert_contains_file "ship has soft-block prompt" "Proceed with PR creation anyway" "$SHIP"

echo ""
echo "── Sync check ──"
# Verify sync-commands.js --check passes (no drift between agent directories)
if node "$SCRIPT_DIR/scripts/sync-commands.js" --check 2>&1 | grep -qi 'error\|drift\|mismatch'; then
  FAIL=$((FAIL + 1)); echo "  FAIL: sync-commands.js --check detected drift"
else
  PASS=$((PASS + 1)); echo "  PASS: all agent directories in sync"
fi

echo ""
echo "Results: $PASS passed, $FAIL failed"
[[ $FAIL -eq 0 ]] && exit 0 || exit 1
