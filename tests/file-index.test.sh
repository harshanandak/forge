#!/usr/bin/env bash
# tests/file-index.test.sh — Tests for file-index.sh JSONL helpers
#
# Usage: bash tests/file-index.test.sh
# Exit 0 = all pass, exit 1 = any fail.

set -euo pipefail

# ── Test harness ──────────────────────────────────────────────────────────

PASS=0
FAIL=0
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SUT="$REPO_ROOT/scripts/file-index.sh"

# Each test gets its own temp dir with a .beads/ subdirectory
TEST_TMP=""

setup() {
  TEST_TMP="$(mktemp -d)"
  mkdir -p "$TEST_TMP/.beads"
  # Override FILE_INDEX_ROOT so the script writes to our temp dir
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

# ── Test: file_index_add creates valid JSONL ──────────────────────────────

test_add_creates_valid_jsonl() {
  echo "TEST: file_index_add creates valid JSONL"
  setup

  source "$SUT"
  file_index_add "forge-abc" "harsha@laptop" '["src/lib/status.ts"]' '["src/lib/"]'

  local jsonl_file="$TEST_TMP/.beads/file-index.jsonl"

  # File should exist
  if [[ -f "$jsonl_file" ]]; then
    PASS=$((PASS + 1))
    echo "  PASS: JSONL file created"
  else
    FAIL=$((FAIL + 1))
    echo "  FAIL: JSONL file not created"
    teardown
    return
  fi

  # Should have exactly 1 line
  local line_count
  line_count="$(wc -l < "$jsonl_file" | tr -d ' ')"
  assert_eq "exactly 1 line" "1" "$line_count"

  # Line should be valid JSON
  local line
  line="$(head -1 "$jsonl_file")"
  if printf '%s' "$line" | jq empty 2>/dev/null; then
    PASS=$((PASS + 1))
    echo "  PASS: line is valid JSON"
  else
    FAIL=$((FAIL + 1))
    echo "  FAIL: line is not valid JSON"
    teardown
    return
  fi

  # Check fields
  local issue_id developer tombstone
  issue_id="$(printf '%s' "$line" | jq -r '.issue_id')"
  developer="$(printf '%s' "$line" | jq -r '.developer')"
  tombstone="$(printf '%s' "$line" | jq -r '.tombstone')"

  assert_eq "issue_id field" "forge-abc" "$issue_id"
  assert_eq "developer field" "harsha@laptop" "$developer"
  assert_eq "tombstone is false" "false" "$tombstone"

  # Check files array
  local files_count
  files_count="$(printf '%s' "$line" | jq '.files | length')"
  assert_eq "files has 1 element" "1" "$files_count"

  local first_file
  first_file="$(printf '%s' "$line" | jq -r '.files[0]')"
  assert_eq "first file path" "src/lib/status.ts" "$first_file"

  # Check modules array
  local modules_count
  modules_count="$(printf '%s' "$line" | jq '.modules | length')"
  assert_eq "modules has 1 element" "1" "$modules_count"

  # Check updated_at is present and looks like ISO 8601
  local updated_at
  updated_at="$(printf '%s' "$line" | jq -r '.updated_at')"
  if [[ "$updated_at" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$ ]]; then
    PASS=$((PASS + 1))
    echo "  PASS: updated_at is ISO 8601"
  else
    FAIL=$((FAIL + 1))
    echo "  FAIL: updated_at format invalid: $updated_at"
  fi

  teardown
}

# ── Test: file_index_add appends (does not overwrite) ─────────────────────

test_add_appends() {
  echo "TEST: file_index_add appends multiple entries"
  setup

  source "$SUT"
  file_index_add "forge-aaa" "dev1@host" '["a.ts"]' '["src/"]'
  file_index_add "forge-bbb" "dev2@host" '["b.ts"]' '["lib/"]'

  local jsonl_file="$TEST_TMP/.beads/file-index.jsonl"
  local line_count
  line_count="$(wc -l < "$jsonl_file" | tr -d ' ')"
  assert_eq "2 lines after 2 adds" "2" "$line_count"

  # Second line should have forge-bbb
  local second_id
  second_id="$(sed -n '2p' "$jsonl_file" | jq -r '.issue_id')"
  assert_eq "second entry issue_id" "forge-bbb" "$second_id"

  teardown
}

# ── Test: file_index_remove creates tombstone ─────────────────────────────

test_remove_creates_tombstone() {
  echo "TEST: file_index_remove creates tombstone entry"
  setup

  source "$SUT"
  file_index_add "forge-xyz" "dev@host" '["x.ts"]' '["src/"]'
  file_index_remove "forge-xyz"

  local jsonl_file="$TEST_TMP/.beads/file-index.jsonl"
  local line_count
  line_count="$(wc -l < "$jsonl_file" | tr -d ' ')"
  assert_eq "2 lines (add + tombstone)" "2" "$line_count"

  # Second line should be tombstone
  local tombstone
  tombstone="$(sed -n '2p' "$jsonl_file" | jq -r '.tombstone')"
  assert_eq "tombstone is true" "true" "$tombstone"

  # Issue ID should match
  local issue_id
  issue_id="$(sed -n '2p' "$jsonl_file" | jq -r '.issue_id')"
  assert_eq "tombstone issue_id" "forge-xyz" "$issue_id"

  teardown
}

# ── Test: file_index_read resolves LWW ────────────────────────────────────

test_read_resolves_lww() {
  echo "TEST: file_index_read resolves LWW (last-write-wins)"
  setup

  source "$SUT"
  # Add two entries for the same issue (simulating an update)
  file_index_add "forge-lww" "dev@host" '["old.ts"]' '["old/"]'
  sleep 1  # Ensure different timestamp
  file_index_add "forge-lww" "dev@host" '["new.ts"]' '["new/"]'
  # Add a different issue
  file_index_add "forge-other" "dev2@host" '["other.ts"]' '["other/"]'

  local output
  output="$(file_index_read)"

  # Should have 2 active entries (LWW deduplicates forge-lww)
  local count
  count="$(printf '%s' "$output" | jq '. | length')"
  assert_eq "2 active entries after LWW" "2" "$count"

  # forge-lww should show the latest files (new.ts)
  local lww_file
  lww_file="$(printf '%s' "$output" | jq -r '.[] | select(.issue_id == "forge-lww") | .files[0]')"
  assert_eq "LWW keeps latest files" "new.ts" "$lww_file"

  teardown
}

# ── Test: file_index_read excludes tombstoned entries ─────────────────────

test_read_excludes_tombstoned() {
  echo "TEST: file_index_read excludes tombstoned entries"
  setup

  source "$SUT"
  file_index_add "forge-alive" "dev@host" '["alive.ts"]' '["src/"]'
  file_index_add "forge-dead" "dev@host" '["dead.ts"]' '["lib/"]'
  file_index_remove "forge-dead"

  local output
  output="$(file_index_read)"

  # Should have 1 active entry
  local count
  count="$(printf '%s' "$output" | jq '. | length')"
  assert_eq "1 active entry (tombstoned excluded)" "1" "$count"

  # Only forge-alive should remain
  local alive_id
  alive_id="$(printf '%s' "$output" | jq -r '.[0].issue_id')"
  assert_eq "surviving entry is forge-alive" "forge-alive" "$alive_id"

  teardown
}

# ── Test: file_index_get returns single entry ─────────────────────────────

test_get_single_entry() {
  echo "TEST: file_index_get returns single entry"
  setup

  source "$SUT"
  file_index_add "forge-get1" "dev@host" '["a.ts","b.ts"]' '["src/","lib/"]'
  file_index_add "forge-get2" "dev2@host" '["c.ts"]' '["test/"]'

  local output
  output="$(file_index_get "forge-get1")"

  # Should be a single JSON object (not array)
  local issue_id
  issue_id="$(printf '%s' "$output" | jq -r '.issue_id')"
  assert_eq "get returns correct issue" "forge-get1" "$issue_id"

  local files_count
  files_count="$(printf '%s' "$output" | jq '.files | length')"
  assert_eq "get returns correct files count" "2" "$files_count"

  teardown
}

# ── Test: file_index_get returns empty for missing issue ──────────────────

test_get_missing_returns_empty() {
  echo "TEST: file_index_get returns null for missing issue"
  setup

  source "$SUT"
  file_index_add "forge-exists" "dev@host" '["a.ts"]' '["src/"]'

  local output
  output="$(file_index_get "forge-missing")"

  assert_eq "missing issue returns null" "null" "$output"

  teardown
}

# ── Test: file_index_get returns null for tombstoned issue ────────────────

test_get_tombstoned_returns_null() {
  echo "TEST: file_index_get returns null for tombstoned issue"
  setup

  source "$SUT"
  file_index_add "forge-tomb" "dev@host" '["a.ts"]' '["src/"]'
  file_index_remove "forge-tomb"

  local output
  output="$(file_index_get "forge-tomb")"

  assert_eq "tombstoned issue returns null" "null" "$output"

  teardown
}

# ── Test: sanitize rejects injection in issue_id ──────────────────────────

test_sanitize_issue_id() {
  echo "TEST: rejects invalid issue_id (injection attempt)"
  setup

  source "$SUT"
  local rc=0
  file_index_add 'forge-abc; rm -rf /' "dev@host" '["a.ts"]' '["src/"]' 2>/dev/null || rc=$?

  assert_exit_code "invalid issue_id rejected" 1 "$rc"

  teardown
}

# ── Test: sanitize rejects injection in developer ─────────────────────────

test_sanitize_developer() {
  echo "TEST: rejects invalid developer (injection attempt)"
  setup

  source "$SUT"
  local rc=0
  file_index_add "forge-ok" 'dev@host; echo pwned' '["a.ts"]' '["src/"]' 2>/dev/null || rc=$?

  assert_exit_code "invalid developer rejected" 1 "$rc"

  teardown
}

# ── Test: sanitize rejects $(command) in issue_id ─────────────────────────

test_sanitize_command_substitution() {
  echo "TEST: rejects command substitution in issue_id"
  setup

  source "$SUT"
  local rc=0
  file_index_add '$(whoami)' "dev@host" '["a.ts"]' '["src/"]' 2>/dev/null || rc=$?

  assert_exit_code "command substitution rejected" 1 "$rc"

  teardown
}

# ── Test: file_index_read on empty/missing file ───────────────────────────

test_read_empty_file() {
  echo "TEST: file_index_read returns empty array for missing file"
  setup

  source "$SUT"
  local output
  output="$(file_index_read)"

  assert_eq "empty file returns empty array" "[]" "$output"

  teardown
}

# ── Test: valid developer formats accepted ────────────────────────────────

test_valid_developer_formats() {
  echo "TEST: valid developer identity formats accepted"
  setup

  source "$SUT"

  # user@hostname
  local rc=0
  file_index_add "forge-d1" "user@hostname" '["a.ts"]' '["src/"]' || rc=$?
  assert_exit_code "user@hostname accepted" 0 "$rc"

  # user.name+tag@host
  rc=0
  file_index_add "forge-d2" "user.name+tag@host" '["b.ts"]' '["lib/"]' || rc=$?
  assert_exit_code "user.name+tag@host accepted" 0 "$rc"

  # simple-user
  rc=0
  file_index_add "forge-d3" "simple-user" '["c.ts"]' '["test/"]' || rc=$?
  assert_exit_code "simple-user accepted" 0 "$rc"

  teardown
}

# ── Run all tests ─────────────────────────────────────────────────────────

echo "=== file-index.sh test suite ==="
echo ""

test_add_creates_valid_jsonl
test_add_appends
test_remove_creates_tombstone
test_read_resolves_lww
test_read_excludes_tombstoned
test_get_single_entry
test_get_missing_returns_empty
test_get_tombstoned_returns_null
test_sanitize_issue_id
test_sanitize_developer
test_sanitize_command_substitution
test_read_empty_file
test_valid_developer_formats

echo ""
echo "=== Results: $PASS passed, $FAIL failed ==="

if [[ $FAIL -gt 0 ]]; then
  exit 1
fi
exit 0
