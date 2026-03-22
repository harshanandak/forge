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

# ── Test: file_index_update_from_tasks parses task file correctly ──────────

SYNC_UTILS="$REPO_ROOT/scripts/sync-utils.sh"

test_update_from_tasks_parses_task_file() {
  echo "TEST: file_index_update_from_tasks parses File(s): lines from task file"
  setup

  # Create a mock task file with File(s): lines
  local task_file="$TEST_TMP/task-file.md"
  cat > "$task_file" <<'TASKEOF'
### Task 1: Pluggable sync backend abstraction
File(s): `scripts/sync-utils.sh`
What to implement: Sync backend system

### Task 2: Sync branch/remote detection utility
File(s): `scripts/sync-utils.sh` (extend), `src/lib/status.ts`
What to implement: Functions for branch and inline backends

### Task 3: No files line
What to implement: Something without a File(s): line
TASKEOF

  source "$SUT"
  # Mock get_session_identity so we don't depend on git config
  get_session_identity() { printf '%s' "testdev@testhost"; }

  file_index_update_from_tasks "forge-task1" "$task_file"

  local output
  output="$(file_index_get "forge-task1")"

  # Should have created an entry
  local issue_id
  issue_id="$(printf '%s' "$output" | jq -r '.issue_id')"
  assert_eq "issue_id set correctly" "forge-task1" "$issue_id"

  # Should have extracted 2 unique files from the task file
  local files_count
  files_count="$(printf '%s' "$output" | jq '.files | length')"
  assert_eq "extracted 2 unique files" "2" "$files_count"

  # Should contain both file paths (without annotations like "(extend)")
  local has_sync_utils has_status
  has_sync_utils="$(printf '%s' "$output" | jq '[.files[] | select(. == "scripts/sync-utils.sh")] | length')"
  has_status="$(printf '%s' "$output" | jq '[.files[] | select(. == "src/lib/status.ts")] | length')"
  assert_eq "contains scripts/sync-utils.sh" "1" "$has_sync_utils"
  assert_eq "contains src/lib/status.ts" "1" "$has_status"

  # Should have derived modules from directory paths
  local has_scripts_mod has_src_mod
  has_scripts_mod="$(printf '%s' "$output" | jq '[.modules[] | select(. == "scripts/")] | length')"
  has_src_mod="$(printf '%s' "$output" | jq '[.modules[] | select(. == "src/lib/")] | length')"
  assert_eq "module scripts/ derived" "1" "$has_scripts_mod"
  assert_eq "module src/lib/ derived" "1" "$has_src_mod"

  # Developer should be set from session identity
  local developer
  developer="$(printf '%s' "$output" | jq -r '.developer')"
  assert_eq "developer from session identity" "testdev@testhost" "$developer"

  teardown
}

# ── Test: file_index_update_from_tasks with no task file (fallback) ───────

test_update_from_tasks_no_task_file() {
  echo "TEST: file_index_update_from_tasks falls back with confidence:low when no task file"
  setup

  source "$SUT"
  get_session_identity() { printf '%s' "testdev@testhost"; }

  file_index_update_from_tasks "forge-nofile" "/nonexistent/path/task-file.md"

  local output
  output="$(file_index_get "forge-nofile")"

  # Should still create an entry
  local issue_id
  issue_id="$(printf '%s' "$output" | jq -r '.issue_id')"
  assert_eq "entry created for missing task file" "forge-nofile" "$issue_id"

  # Should have confidence: low
  local confidence
  confidence="$(printf '%s' "$output" | jq -r '.confidence')"
  assert_eq "confidence is low for missing task file" "low" "$confidence"

  # Files should be empty array
  local files_count
  files_count="$(printf '%s' "$output" | jq '.files | length')"
  assert_eq "files empty for missing task file" "0" "$files_count"

  teardown
}

# ── Test: file_index_update_from_tasks with no File(s): lines (fallback) ──

test_update_from_tasks_no_files_lines() {
  echo "TEST: file_index_update_from_tasks falls back when task file has no File(s): lines"
  setup

  local task_file="$TEST_TMP/no-files-task.md"
  cat > "$task_file" <<'TASKEOF'
### Task 1: Something
What to implement: Something without file references
TASKEOF

  source "$SUT"
  get_session_identity() { printf '%s' "testdev@testhost"; }

  file_index_update_from_tasks "forge-nolines" "$task_file"

  local output
  output="$(file_index_get "forge-nolines")"

  # Should have confidence: low
  local confidence
  confidence="$(printf '%s' "$output" | jq -r '.confidence')"
  assert_eq "confidence is low for no File(s): lines" "low" "$confidence"

  teardown
}

# ── Test: file_index_update_from_tasks tombstones on close ────────────────

test_update_from_tasks_tombstone_on_close() {
  echo "TEST: file_index_update_from_tasks with closed status creates tombstone"
  setup

  local task_file="$TEST_TMP/task-close.md"
  cat > "$task_file" <<'TASKEOF'
### Task 1: Something
File(s): `src/index.ts`
TASKEOF

  source "$SUT"
  get_session_identity() { printf '%s' "testdev@testhost"; }

  # First add an entry
  file_index_update_from_tasks "forge-closing" "$task_file"

  # Verify it exists
  local before
  before="$(file_index_get "forge-closing")"
  local before_id
  before_id="$(printf '%s' "$before" | jq -r '.issue_id')"
  assert_eq "entry exists before close" "forge-closing" "$before_id"

  # Now call with "closed" action
  file_index_update_from_tasks "forge-closing" "$task_file" "closed"

  # Should be tombstoned
  local after
  after="$(file_index_get "forge-closing")"
  assert_eq "entry tombstoned after close" "null" "$after"

  teardown
}

# ── Test: file_index_update_from_tasks strips annotations ─────────────────

test_update_from_tasks_strips_annotations() {
  echo "TEST: file_index_update_from_tasks strips annotations like (extend), (run script only)"
  setup

  local task_file="$TEST_TMP/task-annotated.md"
  cat > "$task_file" <<'TASKEOF'
### Task 7: Auto-sync at Forge command entry
File(s): `scripts/sync-utils.sh` (extend), `.claude/commands/plan.md`, `.claude/commands/dev.md` (run script only), `.claude/commands/status.md`
TASKEOF

  source "$SUT"
  get_session_identity() { printf '%s' "testdev@testhost"; }

  file_index_update_from_tasks "forge-annot" "$task_file"

  local output
  output="$(file_index_get "forge-annot")"

  # Should have 4 files, all without annotations
  local files_count
  files_count="$(printf '%s' "$output" | jq '.files | length')"
  assert_eq "4 files extracted" "4" "$files_count"

  # Verify no annotations leaked into paths
  local has_paren
  has_paren="$(printf '%s' "$output" | jq '[.files[] | select(contains("("))] | length')"
  assert_eq "no parenthetical annotations in paths" "0" "$has_paren"

  # Verify specific files present
  local has_plan
  has_plan="$(printf '%s' "$output" | jq '[.files[] | select(. == ".claude/commands/plan.md")] | length')"
  assert_eq "plan.md extracted" "1" "$has_plan"

  teardown
}

# ── Test: file_index_update_from_tasks rejects injection in file paths ────

test_update_from_tasks_rejects_injection() {
  echo "TEST: file_index_update_from_tasks sanitizes malicious file paths"
  setup

  local task_file="$TEST_TMP/task-injection.md"
  cat > "$task_file" <<'TASKEOF'
### Task 1: Injection attempt
File(s): `src/legit.ts`, `$(rm -rf /)`
TASKEOF

  source "$SUT"
  get_session_identity() { printf '%s' "testdev@testhost"; }

  file_index_update_from_tasks "forge-inject" "$task_file"

  local output
  output="$(file_index_get "forge-inject")"

  # The injection path should be stripped/excluded
  local has_injection
  has_injection="$(printf '%s' "$output" | jq '[.files[] | select(contains("rm"))] | length')"
  assert_eq "injection path excluded" "0" "$has_injection"

  # The legit file should be present
  local has_legit
  has_legit="$(printf '%s' "$output" | jq '[.files[] | select(. == "src/legit.ts")] | length')"
  assert_eq "legit file kept" "1" "$has_legit"

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
test_update_from_tasks_parses_task_file
test_update_from_tasks_no_task_file
test_update_from_tasks_no_files_lines
test_update_from_tasks_tombstone_on_close
test_update_from_tasks_strips_annotations
test_update_from_tasks_rejects_injection

echo ""
echo "=== Results: $PASS passed, $FAIL failed ==="

if [[ $FAIL -gt 0 ]]; then
  exit 1
fi
exit 0
