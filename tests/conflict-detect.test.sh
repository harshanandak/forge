#!/usr/bin/env bash
# tests/conflict-detect.test.sh — Tests for conflict-detect.sh
#
# Usage: bash tests/conflict-detect.test.sh
# Exit 0 = all pass, exit 1 = any fail.

set -euo pipefail

# ── Test harness ──────────────────────────────────────────────────────────

PASS=0
FAIL=0
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SUT="$REPO_ROOT/scripts/conflict-detect.sh"
FILE_INDEX_SH="$REPO_ROOT/scripts/file-index.sh"

# Each test gets its own temp dir with a .beads/ subdirectory
TEST_TMP=""

setup() {
  TEST_TMP="$(mktemp -d)"
  mkdir -p "$TEST_TMP/.beads"
  export FILE_INDEX_ROOT="$TEST_TMP"
}

teardown() {
  [[ -n "$TEST_TMP" ]] && rm -rf "$TEST_TMP"
  unset FILE_INDEX_ROOT
}

assert_eq() {
  local label="$1" expected="$2" actual="$3"
  if [[ "$expected" == "$actual" ]]; then
    PASS=$((PASS + 1))
    echo "  PASS: $label"
  else
    FAIL=$((FAIL + 1))
    echo "  FAIL: $label"
    echo "    expected: $expected"
    echo "    actual:   $actual"
  fi
}

assert_exit_code() {
  local label="$1" expected="$2" actual="$3"
  if [[ "$expected" -eq "$actual" ]]; then
    PASS=$((PASS + 1))
    echo "  PASS: $label"
  else
    FAIL=$((FAIL + 1))
    echo "  FAIL: $label"
    echo "    expected exit code: $expected"
    echo "    actual exit code:   $actual"
  fi
}

assert_contains() {
  local label="$1" needle="$2" haystack="$3"
  if printf '%s' "$haystack" | grep -qF "$needle"; then
    PASS=$((PASS + 1))
    echo "  PASS: $label"
  else
    FAIL=$((FAIL + 1))
    echo "  FAIL: $label"
    echo "    expected to contain: $needle"
    echo "    actual: $haystack"
  fi
}

assert_not_contains() {
  local label="$1" needle="$2" haystack="$3"
  if ! printf '%s' "$haystack" | grep -qF "$needle"; then
    PASS=$((PASS + 1))
    echo "  PASS: $label"
  else
    FAIL=$((FAIL + 1))
    echo "  FAIL: $label"
    echo "    expected NOT to contain: $needle"
    echo "    actual: $haystack"
  fi
}

# Helper: seed the file index with entries
seed_index() {
  source "$FILE_INDEX_SH"
  # Issue forge-aaa: developer dev1@host, files src/lib/status.ts, modules src/lib/
  file_index_add "forge-aaa" "dev1@host" '["src/lib/status.ts","src/lib/helpers.ts"]' '["src/lib/"]'
  # Issue forge-bbb: developer dev2@host, files src/cli/main.ts, modules src/cli/
  file_index_add "forge-bbb" "dev2@host" '["src/cli/main.ts"]' '["src/cli/"]'
  # Issue forge-ccc: developer dev3@host, files src/lib/utils.ts (overlaps module with forge-aaa), modules src/lib/
  file_index_add "forge-ccc" "dev3@host" '["src/lib/utils.ts"]' '["src/lib/"]'
}

# Helper: seed with exact file overlap
seed_index_file_overlap() {
  source "$FILE_INDEX_SH"
  file_index_add "forge-aaa" "dev1@host" '["src/lib/status.ts"]' '["src/lib/"]'
  file_index_add "forge-bbb" "dev2@host" '["src/lib/status.ts","src/cli/main.ts"]' '["src/lib/","src/cli/"]'
}

# ── Test: module overlap detected (exit 1) ───────────────────────────────

test_module_overlap_detected() {
  echo "TEST: module overlap detected exits 1"
  setup
  seed_index

  # forge-aaa and forge-ccc both touch src/lib/ — conflict expected
  local output rc=0
  output="$(bash "$SUT" --issue forge-aaa 2>&1)" || rc=$?

  assert_exit_code "exit 1 on module overlap" 1 "$rc"
  assert_contains "mentions overlapping issue" "forge-ccc" "$output"
  assert_contains "mentions overlapping module" "src/lib/" "$output"
  assert_contains "mentions developer" "dev3@host" "$output"

  teardown
}

# ── Test: no overlap (exit 0) ────────────────────────────────────────────

test_no_overlap() {
  echo "TEST: no overlap exits 0"
  setup
  seed_index

  # forge-bbb touches src/cli/ — no other issue shares that module
  local output rc=0
  output="$(bash "$SUT" --issue forge-bbb 2>&1)" || rc=$?

  assert_exit_code "exit 0 when no overlap" 0 "$rc"
  assert_contains "no conflicts" "No conflicts" "$output"

  teardown
}

# ── Test: --files flag checks arbitrary files ────────────────────────────

test_files_flag() {
  echo "TEST: --files flag checks arbitrary file list"
  setup
  seed_index

  # Check files in src/lib/ — should find overlap with forge-aaa and forge-ccc
  local output rc=0
  output="$(bash "$SUT" --files "src/lib/newfile.ts" 2>&1)" || rc=$?

  assert_exit_code "exit 1 on file list overlap" 1 "$rc"
  assert_contains "mentions forge-aaa" "forge-aaa" "$output"
  assert_contains "mentions forge-ccc" "forge-ccc" "$output"

  teardown
}

# ── Test: --files with no overlap ────────────────────────────────────────

test_files_flag_no_overlap() {
  echo "TEST: --files flag with no overlapping modules"
  setup
  seed_index

  # Check files in test/ — no issues touch that module
  local output rc=0
  output="$(bash "$SUT" --files "test/foo.ts" 2>&1)" || rc=$?

  assert_exit_code "exit 0 when no file overlap" 0 "$rc"

  teardown
}

# ── Test: --detail flag shows file-level overlap ─────────────────────────

test_detail_flag_shows_files() {
  echo "TEST: --detail flag shows file-level overlap"
  setup
  seed_index_file_overlap

  # forge-aaa and forge-bbb both touch src/lib/status.ts
  local output rc=0
  output="$(bash "$SUT" --issue forge-aaa --detail 2>&1)" || rc=$?

  assert_exit_code "exit 1 with detail" 1 "$rc"
  assert_contains "shows exact file" "src/lib/status.ts" "$output"
  assert_contains "mentions forge-bbb" "forge-bbb" "$output"

  teardown
}

# ── Test: stale sync warning shown ───────────────────────────────────────

test_stale_sync_warning() {
  echo "TEST: stale sync warning shown when last-sync is old"
  setup
  seed_index

  # Create a .last-sync file with a timestamp 20 minutes ago
  local old_ts
  old_ts="$(date -u -d '20 minutes ago' +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -v-20M +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || echo '2020-01-01T00:00:00Z')"
  printf '%s' "$old_ts" > "$TEST_TMP/.beads/.last-sync"

  local output rc=0
  output="$(bash "$SUT" --issue forge-aaa 2>&1)" || rc=$?

  assert_contains "shows stale warning" "stale" "$output"

  teardown
}

# ── Test: no stale warning when sync is fresh ────────────────────────────

test_no_stale_warning_when_fresh() {
  echo "TEST: no stale warning when last-sync is recent"
  setup
  seed_index

  # Create a .last-sync file with current timestamp
  local now_ts
  now_ts="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  printf '%s' "$now_ts" > "$TEST_TMP/.beads/.last-sync"

  local output rc=0
  output="$(bash "$SUT" --issue forge-bbb 2>&1)" || rc=$?

  assert_not_contains "no stale warning" "stale" "$output"

  teardown
}

# ── Test: injection in --issue rejected ──────────────────────────────────

test_injection_issue_rejected() {
  echo "TEST: injection in --issue flag rejected"
  setup

  local output rc=0
  output="$(bash "$SUT" --issue 'forge-abc; rm -rf /' 2>&1)" || rc=$?

  assert_exit_code "injection rejected (non-zero exit)" 1 "$rc"
  assert_contains "shows error" "invalid" "$output"

  teardown
}

# ── Test: injection in --files rejected ──────────────────────────────────

test_injection_files_rejected() {
  echo "TEST: injection in --files flag rejected"
  setup

  local output rc=0
  output="$(bash "$SUT" --files '$(whoami)/evil.ts' 2>&1)" || rc=$?

  assert_exit_code "injection in files rejected" 1 "$rc"
  assert_contains "shows error" "invalid" "$output"

  teardown
}

# ── Test: missing arguments shows usage ──────────────────────────────────

test_missing_args_shows_usage() {
  echo "TEST: missing arguments shows usage"
  setup

  local output rc=0
  output="$(bash "$SUT" 2>&1)" || rc=$?

  assert_exit_code "exits non-zero on no args" 1 "$rc"
  assert_contains "shows usage" "Usage" "$output"

  teardown
}

# ── Test: --files with multiple comma-separated files ────────────────────

test_files_multiple_comma_separated() {
  echo "TEST: --files accepts comma-separated file list"
  setup
  seed_index

  # Check multiple files: one in src/cli/ and one in test/
  local output rc=0
  output="$(bash "$SUT" --files "src/cli/something.ts,test/foo.ts" 2>&1)" || rc=$?

  assert_exit_code "exit 1 when one file overlaps" 1 "$rc"
  assert_contains "mentions forge-bbb" "forge-bbb" "$output"

  teardown
}

# ── Run all tests ─────────────────────────────────────────────────────────

echo "=== conflict-detect.sh test suite ==="
echo ""

test_module_overlap_detected
test_no_overlap
test_files_flag
test_files_flag_no_overlap
test_detail_flag_shows_files
test_stale_sync_warning
test_no_stale_warning_when_fresh
test_injection_issue_rejected
test_injection_files_rejected
test_missing_args_shows_usage
test_files_multiple_comma_separated

echo ""
echo "=== Results: $PASS passed, $FAIL failed ==="

if [[ $FAIL -gt 0 ]]; then
  exit 1
fi
exit 0
