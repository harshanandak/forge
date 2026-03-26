#!/usr/bin/env bash
# tests/error-handling.test.sh — Tests for error handling improvements

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TEST_TMP=""
PASS=0
FAIL=0

setup() {
  TEST_TMP="$(mktemp -d)"
  mkdir -p "$TEST_TMP/.beads"
  mkdir -p "$TEST_TMP/scripts"
  export FILE_INDEX_ROOT="$TEST_TMP"
}

teardown() {
  rm -rf "$TEST_TMP"
  unset FILE_INDEX_ROOT
}

assert_eq() {
  if [[ "$1" == "$2" ]]; then
    PASS=$((PASS + 1))
    echo "  PASS: $3"
  else
    FAIL=$((FAIL + 1))
    echo "  FAIL: $3 (expected '$2', got '$1')"
  fi
}

assert_contains() {
  if [[ "$1" == *"$2"* ]]; then
    PASS=$((PASS + 1))
    echo "  PASS: $3"
  else
    FAIL=$((FAIL + 1))
    echo "  FAIL: $3 (expected to contain '$2', got '$1')"
  fi
}

assert_exit_code() {
  if [[ "$1" -eq "$2" ]]; then
    PASS=$((PASS + 1))
    echo "  PASS: $3"
  else
    FAIL=$((FAIL + 1))
    echo "  FAIL: $3 (expected exit $2, got exit $1)"
  fi
}

# Test 1: conflict-detect.sh fails with exit 2 when file-index.sh is missing
test_source_failure_conflict_detect() {
  echo "Test: conflict-detect.sh exits 2 when source file missing"
  setup

  # Copy conflict-detect.sh to a temp dir where file-index.sh does NOT exist
  cp "$SCRIPT_DIR/scripts/conflict-detect.sh" "$TEST_TMP/scripts/conflict-detect.sh"
  chmod +x "$TEST_TMP/scripts/conflict-detect.sh"

  local output
  local exit_code=0

  output="$(bash "$TEST_TMP/scripts/conflict-detect.sh" --issue test-123 2>&1)" || exit_code=$?

  assert_eq "$exit_code" "2" "exits with code 2 when file-index.sh missing"
  assert_contains "$output" "FATAL" "error message contains FATAL"

  teardown
}

# Test 2: sync-utils.sh warns when jq missing
test_jq_missing_warning() {
  echo "Test: _auto_sync_update_file_index warns when jq missing"
  setup

  # Source sync-utils.sh
  source "$SCRIPT_DIR/scripts/sync-utils.sh"

  # Create a minimal issues.jsonl
  echo '{"id":"test-1","status":"in_progress","updated_at":"2026-03-26T00:00:00Z"}' > "$TEST_TMP/.beads/issues.jsonl"

  # Override command to pretend jq doesn't exist
  command() {
    if [[ "$2" == "jq" ]]; then return 1; fi
    builtin command "$@"
  }
  local output
  local exit_code
  output="$(_auto_sync_update_file_index "$TEST_TMP" 2>&1)"
  exit_code=$?

  assert_contains "$output" "jq not found" "warns about missing jq"

  teardown
}

# Test 3: pipefail catches jq failures in file_index_update_from_tasks
test_pipefail_jq_failure() {
  echo "Test: file_index_update_from_tasks has pipefail guard"
  setup

  source "$SCRIPT_DIR/scripts/file-index.sh"

  # Verify the pipefail guard wraps jq pipelines (uses _prev_pipefail save/restore pattern)
  local has_pipefail_guard
  has_pipefail_guard="$(grep -c '_prev_pipefail' "$SCRIPT_DIR/scripts/file-index.sh")" || true

  if [[ "$has_pipefail_guard" -gt 0 ]]; then
    PASS=$((PASS + 1))
    echo "  PASS: file-index.sh contains pipefail save/restore guard"
  else
    FAIL=$((FAIL + 1))
    echo "  FAIL: file-index.sh missing pipefail save/restore guard around jq pipelines"
  fi

  teardown
}

# Test 4: auto_sync uses correct bd command (not "bd sync")
test_sync_cmd_default() {
  echo "Test: auto_sync default command is not 'bd sync'"

  local default_cmd
  default_cmd="$(grep 'BD_SYNC_CMD:-' "$SCRIPT_DIR/scripts/sync-utils.sh" | head -1)"

  if [[ "$default_cmd" == *"bd sync"* ]] && [[ "$default_cmd" != *"bd dolt"* ]]; then
    FAIL=$((FAIL + 1))
    echo "  FAIL: still uses 'bd sync' which doesn't exist"
  else
    PASS=$((PASS + 1))
    echo "  PASS: default sync command is not 'bd sync'"
  fi
}

# Run all tests
echo "=== Error Handling Tests ==="
test_source_failure_conflict_detect
test_jq_missing_warning
test_pipefail_jq_failure
test_sync_cmd_default

echo ""
echo "Results: $PASS passed, $FAIL failed"
[[ $FAIL -eq 0 ]] && exit 0 || exit 1
