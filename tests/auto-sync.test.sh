#!/usr/bin/env bash
# auto-sync.test.sh — Tests for auto_sync and check_sync_staleness in sync-utils.sh.
#
# Usage: bash tests/auto-sync.test.sh
# Exit code 0 = all pass, non-zero = failure.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# ── Test framework ─────────────────────────────────────────────────────

PASS=0
FAIL=0

assert_eq() {
  local label="$1" expected="$2" actual="$3"
  if [[ "$expected" == "$actual" ]]; then
    echo "  PASS: $label"
    PASS=$((PASS + 1))
  else
    echo "  FAIL: $label"
    echo "    expected: '$expected'"
    echo "    actual:   '$actual'"
    FAIL=$((FAIL + 1))
  fi
}

assert_match() {
  local label="$1" pattern="$2" actual="$3"
  if [[ "$actual" =~ $pattern ]]; then
    echo "  PASS: $label"
    PASS=$((PASS + 1))
  else
    echo "  FAIL: $label"
    echo "    pattern:  '$pattern'"
    echo "    actual:   '$actual'"
    FAIL=$((FAIL + 1))
  fi
}

assert_not_match() {
  local label="$1" pattern="$2" actual="$3"
  if [[ ! "$actual" =~ $pattern ]]; then
    echo "  PASS: $label"
    PASS=$((PASS + 1))
  else
    echo "  FAIL: $label (should NOT match)"
    echo "    pattern:  '$pattern'"
    echo "    actual:   '$actual'"
    FAIL=$((FAIL + 1))
  fi
}

# ── Setup temp directory ───────────────────────────────────────────────

TMPDIR_ROOT="$(mktemp -d)"
cleanup() {
  rm -rf -- "$TMPDIR_ROOT"
}
trap cleanup EXIT

# ── Source the module under test ───────────────────────────────────────

source "$REPO_ROOT/scripts/sync-utils.sh"

# ── Tests: auto_sync — successful sync records timestamp ─────────────

echo "=== auto_sync: successful sync records timestamp ==="

TEST_DIR="$TMPDIR_ROOT/test_sync_success"
mkdir -p "$TEST_DIR/.beads"

# Mock bd sync as a successful command
export BD_SYNC_CMD="true"
export FILE_INDEX_ROOT="$TEST_DIR"

# Run auto_sync
output="$(auto_sync "$TEST_DIR" 2>&1)"
exit_code=$?

assert_eq "auto_sync returns 0 on success" "0" "$exit_code"

# Check .last-sync file was created
if [[ -f "$TEST_DIR/.beads/.last-sync" ]]; then
  echo "  PASS: .last-sync file created"
  PASS=$((PASS + 1))
else
  echo "  FAIL: .last-sync file not created"
  FAIL=$((FAIL + 1))
fi

# Check timestamp is a valid Unix epoch (all digits)
ts="$(cat "$TEST_DIR/.beads/.last-sync")"
assert_match ".last-sync contains Unix epoch" '^[0-9]+$' "$ts"

# Check timestamp is recent (within 10 seconds of now)
now="$(date +%s)"
diff=$(( now - ts ))
if [[ "$diff" -ge 0 && "$diff" -le 10 ]]; then
  echo "  PASS: timestamp is recent (within 10s)"
  PASS=$((PASS + 1))
else
  echo "  FAIL: timestamp is not recent (diff=${diff}s)"
  FAIL=$((FAIL + 1))
fi

# ── Tests: auto_sync — failure is non-blocking ───────────────────────

echo ""
echo "=== auto_sync: failure is non-blocking ==="

TEST_DIR2="$TMPDIR_ROOT/test_sync_failure"
mkdir -p "$TEST_DIR2/.beads"

# Mock bd sync as a failing command
export BD_SYNC_CMD="false"
export FILE_INDEX_ROOT="$TEST_DIR2"

# Run auto_sync — should still return 0
output="$(auto_sync "$TEST_DIR2" 2>&1)"
exit_code=$?

assert_eq "auto_sync returns 0 even on bd sync failure" "0" "$exit_code"

# Should contain a warning about sync failure
assert_match "outputs sync failure warning" "sync failed" "$output"
assert_match "warning mentions local data" "local data" "$output"

# .last-sync should NOT be updated on failure (or not exist)
if [[ -f "$TEST_DIR2/.beads/.last-sync" ]]; then
  echo "  FAIL: .last-sync should not be created on sync failure"
  FAIL=$((FAIL + 1))
else
  echo "  PASS: .last-sync not created on sync failure"
  PASS=$((PASS + 1))
fi

# ── Tests: auto_sync — failure with existing .last-sync shows timestamp ──

echo ""
echo "=== auto_sync: failure warning shows last sync timestamp ==="

TEST_DIR3="$TMPDIR_ROOT/test_sync_fail_with_ts"
mkdir -p "$TEST_DIR3/.beads"

# Pre-seed a .last-sync file with a known timestamp
echo "1700000000" > "$TEST_DIR3/.beads/.last-sync"

export BD_SYNC_CMD="false"
export FILE_INDEX_ROOT="$TEST_DIR3"

output="$(auto_sync "$TEST_DIR3" 2>&1)"

assert_match "warning includes human-readable last sync" "m ago" "$output"

# The pre-existing timestamp should be preserved (not overwritten)
ts_after="$(cat "$TEST_DIR3/.beads/.last-sync")"
assert_eq ".last-sync preserved on failure" "1700000000" "$ts_after"

# ── Tests: check_sync_staleness — fresh sync (no warning) ────────────

echo ""
echo "=== check_sync_staleness: fresh sync ==="

TEST_DIR4="$TMPDIR_ROOT/test_staleness_fresh"
mkdir -p "$TEST_DIR4/.beads"

# Set timestamp to now (fresh)
date +%s > "$TEST_DIR4/.beads/.last-sync"

output="$(check_sync_staleness "$TEST_DIR4" 2>&1)"
exit_code=$?

assert_eq "check_sync_staleness returns 0 for fresh sync" "0" "$exit_code"
assert_not_match "no staleness warning for fresh sync" "stale" "$output"

# ── Tests: check_sync_staleness — stale sync (>15 min) ───────────────

echo ""
echo "=== check_sync_staleness: stale sync (>15 min) ==="

TEST_DIR5="$TMPDIR_ROOT/test_staleness_old"
mkdir -p "$TEST_DIR5/.beads"

# Set timestamp to 20 minutes ago
old_ts=$(( $(date +%s) - 1200 ))
echo "$old_ts" > "$TEST_DIR5/.beads/.last-sync"

output="$(check_sync_staleness "$TEST_DIR5" 2>&1)"
exit_code=$?

assert_eq "check_sync_staleness returns 0 (non-blocking)" "0" "$exit_code"
assert_match "warns about stale sync" "stale" "$output"

# ── Tests: check_sync_staleness — missing .last-sync ─────────────────

echo ""
echo "=== check_sync_staleness: missing .last-sync ==="

TEST_DIR6="$TMPDIR_ROOT/test_staleness_missing"
mkdir -p "$TEST_DIR6/.beads"

output="$(check_sync_staleness "$TEST_DIR6" 2>&1)"
exit_code=$?

assert_eq "check_sync_staleness returns 0 when .last-sync missing" "0" "$exit_code"
assert_match "warns about no sync record" "never" "$output"

# ── Tests: CLI dispatcher — auto-sync subcommand ─────────────────────

echo ""
echo "=== CLI dispatcher: auto-sync ==="

TEST_DIR7="$TMPDIR_ROOT/test_cli_autosync"
mkdir -p "$TEST_DIR7/.beads"

export BD_SYNC_CMD="true"
export FILE_INDEX_ROOT="$TEST_DIR7"

# Run via CLI dispatcher
bash "$REPO_ROOT/scripts/sync-utils.sh" auto-sync "$TEST_DIR7" >/dev/null 2>&1
exit_code=$?

assert_eq "CLI auto-sync exits 0" "0" "$exit_code"

if [[ -f "$TEST_DIR7/.beads/.last-sync" ]]; then
  echo "  PASS: CLI auto-sync creates .last-sync"
  PASS=$((PASS + 1))
else
  echo "  FAIL: CLI auto-sync does not create .last-sync"
  FAIL=$((FAIL + 1))
fi

# ── Tests: CLI dispatcher — check-staleness subcommand ────────────────

echo ""
echo "=== CLI dispatcher: check-staleness ==="

TEST_DIR8="$TMPDIR_ROOT/test_cli_staleness"
mkdir -p "$TEST_DIR8/.beads"

# Fresh timestamp
date +%s > "$TEST_DIR8/.beads/.last-sync"

output="$(bash "$REPO_ROOT/scripts/sync-utils.sh" check-staleness "$TEST_DIR8" 2>&1)"
exit_code=$?

assert_eq "CLI check-staleness exits 0" "0" "$exit_code"

# ── Summary ────────────────────────────────────────────────────────────

echo ""
echo "=== Results: $PASS passed, $FAIL failed ==="

if [ "$FAIL" -gt 0 ]; then
  exit 1
fi
exit 0
