#!/usr/bin/env bash
# tests/pr-coordinator-dep.test.sh — Tests for pr-coordinator.sh dep subcommand (Task 6)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
COORD="$PROJECT_DIR/scripts/pr-coordinator.sh"

PASS=0
FAIL=0
ERRORS=""

assert_exit() {
  local label="$1" expected="$2" actual="$3"
  if [[ "$actual" -eq "$expected" ]]; then
    PASS=$((PASS + 1))
    echo "  PASS: $label"
  else
    FAIL=$((FAIL + 1))
    ERRORS="${ERRORS}\n  FAIL: $label (expected exit $expected, got $actual)"
    echo "  FAIL: $label (expected exit $expected, got $actual)"
  fi
}

assert_contains() {
  local label="$1" haystack="$2" needle="$3"
  if printf '%s' "$haystack" | grep -qF "$needle"; then
    PASS=$((PASS + 1))
    echo "  PASS: $label"
  else
    FAIL=$((FAIL + 1))
    ERRORS="${ERRORS}\n  FAIL: $label (expected to contain '$needle', got: $haystack)"
    echo "  FAIL: $label (expected to contain '$needle')"
  fi
}

assert_not_contains() {
  local label="$1" haystack="$2" needle="$3"
  if ! printf '%s' "$haystack" | grep -qF "$needle"; then
    PASS=$((PASS + 1))
    echo "  PASS: $label"
  else
    FAIL=$((FAIL + 1))
    ERRORS="${ERRORS}\n  FAIL: $label (expected NOT to contain '$needle')"
    echo "  FAIL: $label (expected NOT to contain '$needle')"
  fi
}

# ── Setup mock bd ──────────────────────────────────────────────────────

mock_bd_dir="$(mktemp -d)"
trap 'rm -rf "$mock_bd_dir"' EXIT

# Standard mock bd — no cycles, normal behavior
cat > "$mock_bd_dir/bd" << 'MOCK'
#!/usr/bin/env bash
case "$1 $2" in
  "dep add") echo "Dependency added" ;;
  "dep remove") echo "Dependency removed" ;;
  "dep cycles") echo "No cycles found" ;;
  "show forge-test1")
    cat << 'SHOW'
forge-test1 - Test issue 1

DEPENDS ON
  -> forge-test2: Test issue 2 P2

STATUS: open
SHOW
    ;;
  "show forge-nodeps")
    cat << 'SHOW'
forge-nodeps - No deps issue

STATUS: open
SHOW
    ;;
  "list --status=open,in_progress")
    echo "forge-test1  Test issue 1  open"
    echo "forge-nodeps  No deps issue  open"
    ;;
  "set-state"*) echo "State set" ;;
  *) echo "Unknown command: $*" >&2; exit 1 ;;
esac
MOCK
chmod +x "$mock_bd_dir/bd"

# Cycle-detecting mock bd
cat > "$mock_bd_dir/bd-cycle" << 'MOCK'
#!/usr/bin/env bash
case "$1 $2" in
  "dep add") echo "Dependency added" ;;
  "dep remove") echo "Dependency removed" ;;
  "dep cycles") echo "Cycle detected: forge-a -> forge-b -> forge-a" ;;
  *) echo "Unknown command: $*" >&2; exit 1 ;;
esac
MOCK
chmod +x "$mock_bd_dir/bd-cycle"

# Failing mock bd — simulates bd errors
cat > "$mock_bd_dir/bd-fail" << 'MOCK'
#!/usr/bin/env bash
echo "bd error: database locked" >&2
exit 1
MOCK
chmod +x "$mock_bd_dir/bd-fail"

echo "=== pr-coordinator dep tests ==="
echo ""

# ── Test 1: dep add with valid pair ────────────────────────────────────
echo "Test 1: dep add with valid pair"
output="$(BD_CMD="$mock_bd_dir/bd" bash "$COORD" dep add forge-a forge-b 2>&1)" && rc=$? || rc=$?
assert_exit "dep add exits 0" 0 "$rc"
assert_contains "dep add prints confirmation" "$output" "Dependency added: forge-a depends on forge-b"

# ── Test 2: dep add with circular dependency ───────────────────────────
echo ""
echo "Test 2: dep add with circular dependency (cycle detection)"
output="$(BD_CMD="$mock_bd_dir/bd-cycle" bash "$COORD" dep add forge-a forge-b 2>&1)" && rc=$? || rc=$?
assert_exit "dep add cycle exits 1" 1 "$rc"
assert_contains "dep add cycle reports circular" "$output" "circular dependency"
assert_contains "dep add cycle reports rollback" "$output" "rolled back"

# ── Test 3: dep remove with valid pair ─────────────────────────────────
echo ""
echo "Test 3: dep remove with valid pair"
output="$(BD_CMD="$mock_bd_dir/bd" bash "$COORD" dep remove forge-a forge-b 2>&1)" && rc=$? || rc=$?
assert_exit "dep remove exits 0" 0 "$rc"
assert_contains "dep remove prints confirmation" "$output" "Dependency removed: forge-a no longer depends on forge-b"

# ── Test 4: dep list with valid issue (has deps) ──────────────────────
echo ""
echo "Test 4: dep list with valid issue (has dependencies)"
output="$(BD_CMD="$mock_bd_dir/bd" bash "$COORD" dep list forge-test1 2>&1)" && rc=$? || rc=$?
assert_exit "dep list exits 0" 0 "$rc"
assert_contains "dep list shows header" "$output" "Dependencies for forge-test1"

# ── Test 5: dep list with no deps ─────────────────────────────────────
echo ""
echo "Test 5: dep list with no dependencies"
output="$(BD_CMD="$mock_bd_dir/bd" bash "$COORD" dep list forge-nodeps 2>&1)" && rc=$? || rc=$?
assert_exit "dep list no-deps exits 0" 0 "$rc"
assert_contains "dep list no-deps message" "$output" "No dependencies for forge-nodeps"

# ── Test 6: dep set-pr with valid issue + PR ──────────────────────────
echo ""
echo "Test 6: dep set-pr with valid issue and PR number"
output="$(BD_CMD="$mock_bd_dir/bd" bash "$COORD" dep set-pr forge-test1 42 2>&1)" && rc=$? || rc=$?
assert_exit "dep set-pr exits 0" 0 "$rc"
assert_contains "dep set-pr prints confirmation" "$output" "PR #42 linked to forge-test1"

# ── Test 7: dep set-pr with invalid PR number ─────────────────────────
echo ""
echo "Test 7: dep set-pr with invalid PR number"
output="$(BD_CMD="$mock_bd_dir/bd" bash "$COORD" dep set-pr forge-test1 abc 2>&1)" && rc=$? || rc=$?
assert_exit "dep set-pr invalid PR exits 2" 2 "$rc"

# ── Test 8: dep with no action ─────────────────────────────────────────
echo ""
echo "Test 8: dep with no action"
output="$(BD_CMD="$mock_bd_dir/bd" bash "$COORD" dep 2>&1)" && rc=$? || rc=$?
assert_exit "dep no-action exits 1" 1 "$rc"
assert_contains "dep no-action shows usage" "$output" "Usage:"

# ── Test 9: dep add with invalid issue-id ──────────────────────────────
echo ""
echo "Test 9: dep add with invalid issue-id"
output="$(BD_CMD="$mock_bd_dir/bd" bash "$COORD" dep add 'forge;drop' forge-b 2>&1)" && rc=$? || rc=$?
assert_exit "dep add invalid id exits 2" 2 "$rc"
assert_contains "dep add invalid id reports error" "$output" "invalid issue-id"

# ── Test 10: dep with unknown action ───────────────────────────────────
echo ""
echo "Test 10: dep with unknown action"
output="$(BD_CMD="$mock_bd_dir/bd" bash "$COORD" dep frobnicate 2>&1)" && rc=$? || rc=$?
assert_exit "dep unknown action exits 1" 1 "$rc"
assert_contains "dep unknown action reports error" "$output" "unknown dep action"

# ── Test 11: dep remove with missing args ──────────────────────────────
echo ""
echo "Test 11: dep remove with missing args"
output="$(BD_CMD="$mock_bd_dir/bd" bash "$COORD" dep remove forge-a 2>&1)" && rc=$? || rc=$?
assert_exit "dep remove missing args exits 1" 1 "$rc"
assert_contains "dep remove missing args shows usage" "$output" "Usage:"

# ── Test 12: dep list with missing args ────────────────────────────────
echo ""
echo "Test 12: dep list with missing args"
output="$(BD_CMD="$mock_bd_dir/bd" bash "$COORD" dep list 2>&1)" && rc=$? || rc=$?
assert_exit "dep list missing args exits 1" 1 "$rc"
assert_contains "dep list missing args shows usage" "$output" "Usage:"

# ── Test 13: dep set-pr with missing args ──────────────────────────────
echo ""
echo "Test 13: dep set-pr with missing args"
output="$(BD_CMD="$mock_bd_dir/bd" bash "$COORD" dep set-pr forge-test1 2>&1)" && rc=$? || rc=$?
assert_exit "dep set-pr missing args exits 1" 1 "$rc"
assert_contains "dep set-pr missing args shows usage" "$output" "Usage:"

# ── Test 14: dep add with invalid second issue-id ──────────────────────
echo ""
echo "Test 14: dep add with invalid second issue-id"
output="$(BD_CMD="$mock_bd_dir/bd" bash "$COORD" dep add forge-a 'bad id!' 2>&1)" && rc=$? || rc=$?
assert_exit "dep add invalid second id exits 2" 2 "$rc"
assert_contains "dep add invalid second id reports error" "$output" "invalid issue-id"

# ── Summary ────────────────────────────────────────────────────────────
echo ""
echo "=== Results: $PASS passed, $FAIL failed ==="
if [[ $FAIL -gt 0 ]]; then
  printf "$ERRORS\n"
  exit 1
fi
exit 0
