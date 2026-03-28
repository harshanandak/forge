#!/usr/bin/env bash
# Tests for forge-team CLI dispatcher (index.sh)
# Exit codes: 0=all pass, 1=any failure

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DISPATCHER="$SCRIPT_DIR/../index.sh"

PASS=0
FAIL=0

assert_exit() {
  local desc="$1" expected="$2"
  shift 2
  "$@" >/dev/null 2>&1
  local actual=$?
  if [[ "$actual" -eq "$expected" ]]; then
    echo "  PASS: $desc"
    ((PASS++))
  else
    echo "  FAIL: $desc (expected exit=$expected, got exit=$actual)"
    ((FAIL++))
  fi
}

assert_output_contains() {
  local desc="$1" pattern="$2"
  shift 2
  local output
  output=$("$@" 2>&1) || true
  if echo "$output" | grep -q "$pattern"; then
    echo "  PASS: $desc"
    ((PASS++))
  else
    echo "  FAIL: $desc (expected output containing '$pattern')"
    ((FAIL++))
  fi
}

echo "=== forge-team dispatcher tests ==="

# Test 1: help exits 0 and shows usage
echo ""
echo "-- help subcommand --"
assert_exit "help exits 0" 0 bash "$DISPATCHER" help
assert_output_contains "help shows usage" "Usage: forge team" bash "$DISPATCHER" help

# Test 2: No args exits 1
echo ""
echo "-- no args --"
assert_exit "no args exits 1" 1 bash "$DISPATCHER"

# Test 3: Unknown subcommand exits 1 with error
echo ""
echo "-- unknown subcommand --"
assert_exit "unknown subcommand exits 1" 1 bash "$DISPATCHER" bogus
assert_output_contains "unknown subcommand shows error" "unknown subcommand" bash "$DISPATCHER" bogus

# Test 4: Each stub subcommand is reachable (exits 0)
echo ""
echo "-- stub subcommands reachable --"
for cmd in workload epic dashboard add verify sync claim; do
  assert_exit "$cmd exits 0" 0 bash "$DISPATCHER" "$cmd"
  assert_output_contains "$cmd outputs stub message" "not implemented" bash "$DISPATCHER" "$cmd"
done

# Test 5: Sources libs without error (script runs successfully)
echo ""
echo "-- sources libs gracefully --"
assert_exit "dispatcher sources libs without error" 0 bash "$DISPATCHER" help

echo ""
echo "=== Results: $PASS passed, $FAIL failed ==="

if [[ "$FAIL" -gt 0 ]]; then
  exit 1
fi
exit 0
