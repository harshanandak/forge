#!/usr/bin/env bash
# Test pr-coordinator.sh dispatcher and input validation

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PR_COORD="$SCRIPT_DIR/scripts/pr-coordinator.sh"
PASS=0
FAIL=0

assert_exit_code() {
  local label="$1" expected="$2" actual="$3"
  if [[ "$actual" -eq "$expected" ]]; then
    PASS=$((PASS + 1)); echo "  PASS: $label"
  else
    FAIL=$((FAIL + 1)); echo "  FAIL: $label (expected exit $expected, got $actual)"
  fi
}

assert_contains() {
  local label="$1" expected="$2" actual="$3"
  if [[ "$actual" == *"$expected"* ]]; then
    PASS=$((PASS + 1)); echo "  PASS: $label"
  else
    FAIL=$((FAIL + 1)); echo "  FAIL: $label (expected to contain '$expected')"
  fi
}

echo "── Dispatcher ──"

# help prints usage
output="$(bash "$PR_COORD" help 2>&1)"; rc=$?
assert_exit_code "help exits 0" 0 "$rc"
assert_contains "help shows usage" "Usage:" "$output"

# no args exits 1
output="$(bash "$PR_COORD" 2>&1)"; rc=$?
assert_exit_code "no args exits 1" 1 "$rc"

# unknown subcommand exits 1
output="$(bash "$PR_COORD" foobar 2>&1)"; rc=$?
assert_exit_code "unknown subcommand exits 1" 1 "$rc"
assert_contains "unknown shows error" "unknown subcommand" "$output"

# each subcommand is reachable
for cmd in dep merge-order rebase-check stale-worktrees; do
  output="$(bash "$PR_COORD" "$cmd" 2>&1)"; rc=$?
  assert_exit_code "$cmd is reachable (exits 0)" 0 "$rc"
  assert_contains "$cmd returns stub" "not implemented" "$output"
done

echo ""
echo "── Input Validation ──"

# merge-sim with bad branch name exits 2
output="$(bash "$PR_COORD" merge-sim ';rm -rf /' 2>&1)"; rc=$?
assert_exit_code "merge-sim bad branch exits 2" 2 "$rc"

# merge-sim with valid branch
output="$(bash "$PR_COORD" merge-sim feat/test-branch 2>&1)"; rc=$?
assert_exit_code "merge-sim valid branch exits 0" 0 "$rc"

# auto-label with bad issue-id exits 2
output="$(bash "$PR_COORD" auto-label ';drop table' 2>&1)"; rc=$?
assert_exit_code "auto-label bad issue exits 2" 2 "$rc"

# auto-label with valid issue-id
output="$(bash "$PR_COORD" auto-label forge-puh 2>&1)"; rc=$?
assert_exit_code "auto-label valid issue exits 0" 0 "$rc"

echo ""
echo "── Source Dependencies ──"

# Script sources sanitize.sh successfully
output="$(grep 'source.*lib/sanitize.sh' "$PR_COORD")"; rc=$?
assert_exit_code "sources sanitize.sh" 0 "$rc"

echo ""
echo "Results: $PASS passed, $FAIL failed"
[[ $FAIL -eq 0 ]] && exit 0 || exit 1
