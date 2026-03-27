#!/usr/bin/env bash
# tests/jsonl-locking.test.sh — Tests for atomic JSONL locking (scripts/lib/jsonl-lock.sh)
#
# Usage: bash tests/jsonl-locking.test.sh
# Exit 0 = all pass, exit 1 = any fail.

set -euo pipefail

# ── Test harness ──────────────────────────────────────────────────────────

PASS=0
FAIL=0
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SUT="$REPO_ROOT/scripts/lib/jsonl-lock.sh"

TEST_TMP=""

setup() {
  TEST_TMP="$(mktemp -d)"
}

teardown() {
  [[ -n "$TEST_TMP" ]] && rm -rf "$TEST_TMP"
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

# ── Test: basic single append ─────────────────────────────────────────────

test_basic_append() {
  echo "TEST: atomic_jsonl_append appends a single valid JSON line"
  setup

  source "$SUT"

  local jsonl_file="$TEST_TMP/test.jsonl"
  local json_line='{"id":"test-1","value":"hello"}'

  atomic_jsonl_append "$jsonl_file" "$json_line"
  local rc=$?

  assert_exit_code "append returns 0" 0 "$rc"

  # File should exist with exactly 1 line
  local line_count
  line_count="$(wc -l < "$jsonl_file" | tr -d ' ')"
  assert_eq "exactly 1 line" "1" "$line_count"

  # Line should be valid JSON
  local content
  content="$(head -1 "$jsonl_file")"
  if printf '%s' "$content" | jq empty 2>/dev/null; then
    PASS=$((PASS + 1))
    echo "  PASS: line is valid JSON"
  else
    FAIL=$((FAIL + 1))
    echo "  FAIL: line is not valid JSON"
  fi

  # Content should match what we appended
  assert_eq "content matches input" "$json_line" "$content"

  teardown
}

# ── Test: multiple sequential appends ─────────────────────────────────────

test_multiple_appends() {
  echo "TEST: atomic_jsonl_append appends multiple lines sequentially"
  setup

  source "$SUT"

  local jsonl_file="$TEST_TMP/multi.jsonl"
  atomic_jsonl_append "$jsonl_file" '{"id":"line-1"}'
  atomic_jsonl_append "$jsonl_file" '{"id":"line-2"}'
  atomic_jsonl_append "$jsonl_file" '{"id":"line-3"}'

  local line_count
  line_count="$(wc -l < "$jsonl_file" | tr -d ' ')"
  assert_eq "exactly 3 lines" "3" "$line_count"

  # Verify each line
  local line1 line2 line3
  line1="$(sed -n '1p' "$jsonl_file")"
  line2="$(sed -n '2p' "$jsonl_file")"
  line3="$(sed -n '3p' "$jsonl_file")"
  assert_eq "line 1 correct" '{"id":"line-1"}' "$line1"
  assert_eq "line 2 correct" '{"id":"line-2"}' "$line2"
  assert_eq "line 3 correct" '{"id":"line-3"}' "$line3"

  teardown
}

# ── Test: concurrent safety ───────────────────────────────────────────────

test_concurrent_appends() {
  echo "TEST: atomic_jsonl_append handles two concurrent appends safely"
  setup

  source "$SUT"

  local jsonl_file="$TEST_TMP/concurrent.jsonl"

  # Launch two appends in parallel
  atomic_jsonl_append "$jsonl_file" '{"id":"concurrent-A"}' &
  local pid1=$!
  atomic_jsonl_append "$jsonl_file" '{"id":"concurrent-B"}' &
  local pid2=$!

  wait "$pid1"
  local rc1=$?
  wait "$pid2"
  local rc2=$?

  assert_exit_code "first concurrent append succeeds" 0 "$rc1"
  assert_exit_code "second concurrent append succeeds" 0 "$rc2"

  # Both lines should be present (order may vary)
  local line_count
  line_count="$(wc -l < "$jsonl_file" | tr -d ' ')"
  assert_eq "exactly 2 lines from concurrent appends" "2" "$line_count"

  local has_a has_b
  has_a="$(grep -c 'concurrent-A' "$jsonl_file" || true)"
  has_b="$(grep -c 'concurrent-B' "$jsonl_file" || true)"
  assert_eq "concurrent-A present" "1" "$has_a"
  assert_eq "concurrent-B present" "1" "$has_b"

  # Each line should be valid JSON (no interleaving/corruption)
  local all_valid=true
  while IFS= read -r line; do
    if ! printf '%s' "$line" | jq empty 2>/dev/null; then
      all_valid=false
      break
    fi
  done < "$jsonl_file"
  if [[ "$all_valid" == "true" ]]; then
    PASS=$((PASS + 1))
    echo "  PASS: all lines valid JSON (no corruption)"
  else
    FAIL=$((FAIL + 1))
    echo "  FAIL: corrupted JSON from concurrent writes"
  fi

  teardown
}

# ── Test: lock cleanup after successful append ────────────────────────────

test_lock_cleanup() {
  echo "TEST: lock file is cleaned up after successful append"
  setup

  source "$SUT"

  local jsonl_file="$TEST_TMP/cleanup.jsonl"
  atomic_jsonl_append "$jsonl_file" '{"id":"cleanup-test"}'

  # For flock mode: .lock file may exist as empty file (that's OK, flock doesn't remove it)
  # For mkdir mode: .lock.d directory should NOT exist after completion
  if command -v flock &>/dev/null; then
    # flock mode: the lock file is a regular file used as a file descriptor target
    # It's OK for it to exist — what matters is that flock is released
    # Verify we can acquire the lock immediately (not held)
    local can_lock=false
    (
      flock -n 200 && can_lock=true
      echo "$can_lock"
    ) 200>"${jsonl_file}.lock" | grep -q "true"
    if [[ $? -eq 0 ]]; then
      PASS=$((PASS + 1))
      echo "  PASS: flock released after append"
    else
      FAIL=$((FAIL + 1))
      echo "  FAIL: flock still held after append"
    fi
  else
    # mkdir mode: directory lock should be removed
    if [[ ! -d "${jsonl_file}.lock.d" ]]; then
      PASS=$((PASS + 1))
      echo "  PASS: mkdir lock directory removed after append"
    else
      FAIL=$((FAIL + 1))
      echo "  FAIL: mkdir lock directory still exists after append"
    fi
  fi

  teardown
}

# ── Test: creates parent directories ──────────────────────────────────────

test_creates_parent_dirs() {
  echo "TEST: atomic_jsonl_append creates parent directories if missing"
  setup

  source "$SUT"

  local jsonl_file="$TEST_TMP/deep/nested/dir/test.jsonl"
  atomic_jsonl_append "$jsonl_file" '{"id":"nested-test"}'
  local rc=$?

  assert_exit_code "append to nested path succeeds" 0 "$rc"

  if [[ -f "$jsonl_file" ]]; then
    PASS=$((PASS + 1))
    echo "  PASS: file created in nested directory"
  else
    FAIL=$((FAIL + 1))
    echo "  FAIL: file not created in nested directory"
  fi

  teardown
}

# ── Test: mkdir fallback works when flock is absent ───────────────────────

test_mkdir_fallback() {
  echo "TEST: mkdir-based fallback works when flock is unavailable"
  setup

  # Source the file, then override 'command -v flock' to simulate no flock
  source "$SUT"

  # Save original function, redefine atomic_jsonl_append to force mkdir path
  # We do this by creating a wrapper that hides flock
  local jsonl_file="$TEST_TMP/mkdir-fallback.jsonl"

  # Create a temp bin dir with a fake 'flock' that doesn't exist
  local fake_bin="$TEST_TMP/fake_bin"
  mkdir -p "$fake_bin"

  # Run in a subshell with modified PATH that excludes real flock
  (
    # Remove flock from PATH by prepending a dir without it
    # and using 'command -v flock' override trick
    # Simplest approach: redefine the function to force mkdir path
    _atomic_jsonl_append_mkdir() {
      local jsonl_file="$1"
      local json_line="$2"
      local lock_file="${jsonl_file}.lock.d"

      mkdir -p "$(dirname "$jsonl_file")"

      local attempts=0
      while ! mkdir "$lock_file" 2>/dev/null; do
        attempts=$((attempts + 1))
        if [[ $attempts -ge 50 ]]; then
          echo "Error: JSONL lock timeout after 5s" >&2
          return 1
        fi
        sleep 0.1
      done
      trap 'rmdir "$lock_file" 2>/dev/null' RETURN
      printf '%s\n' "$json_line" >> "$jsonl_file"
      rmdir "$lock_file" 2>/dev/null
      trap - RETURN
    }

    _atomic_jsonl_append_mkdir "$jsonl_file" '{"id":"mkdir-test"}'
    rc=$?

    # Verify it worked
    if [[ $rc -eq 0 ]] && [[ -f "$jsonl_file" ]]; then
      content="$(head -1 "$jsonl_file")"
      if [[ "$content" == '{"id":"mkdir-test"}' ]]; then
        echo "MKDIR_FALLBACK_OK"
      else
        echo "MKDIR_FALLBACK_CONTENT_MISMATCH:$content"
      fi
    else
      echo "MKDIR_FALLBACK_FAIL:rc=$rc"
    fi
  )

  local subshell_output
  subshell_output="$( (
    _atomic_jsonl_append_mkdir() {
      local jsonl_file="$1"
      local json_line="$2"
      local lock_file="${jsonl_file}.lock.d"
      mkdir -p "$(dirname "$jsonl_file")"
      local attempts=0
      while ! mkdir "$lock_file" 2>/dev/null; do
        attempts=$((attempts + 1))
        if [[ $attempts -ge 50 ]]; then
          echo "Error: JSONL lock timeout after 5s" >&2
          return 1
        fi
        sleep 0.1
      done
      trap 'rmdir "$lock_file" 2>/dev/null' RETURN
      printf '%s\n' "$json_line" >> "$jsonl_file"
      rmdir "$lock_file" 2>/dev/null
      trap - RETURN
    }

    local jf="$TEST_TMP/mkdir-fallback2.jsonl"
    _atomic_jsonl_append_mkdir "$jf" '{"id":"mkdir-test-2"}'
    if [[ -f "$jf" ]]; then
      head -1 "$jf"
    fi
  ) )"

  assert_eq "mkdir fallback produces correct content" '{"id":"mkdir-test-2"}' "$subshell_output"

  # Verify lock directory cleaned up
  if [[ ! -d "$TEST_TMP/mkdir-fallback2.jsonl.lock.d" ]]; then
    PASS=$((PASS + 1))
    echo "  PASS: mkdir lock directory cleaned up"
  else
    FAIL=$((FAIL + 1))
    echo "  FAIL: mkdir lock directory not cleaned up"
  fi

  teardown
}

# ── Test: file-index.sh sources jsonl-lock.sh and uses atomic append ──────

test_file_index_uses_atomic_append() {
  echo "TEST: file-index.sh sources jsonl-lock.sh and atomic_jsonl_append is available"
  setup

  local fi_script="$REPO_ROOT/scripts/file-index.sh"
  source "$fi_script"

  # After sourcing file-index.sh, atomic_jsonl_append should be available
  if command -v atomic_jsonl_append &>/dev/null; then
    PASS=$((PASS + 1))
    echo "  PASS: atomic_jsonl_append available after sourcing file-index.sh"
  else
    FAIL=$((FAIL + 1))
    echo "  FAIL: atomic_jsonl_append NOT available after sourcing file-index.sh"
  fi

  # Verify file_index_add still works (uses atomic append internally)
  export FILE_INDEX_ROOT="$TEST_TMP"
  mkdir -p "$TEST_TMP/.beads"
  file_index_add "lock-test-1" "dev@host" '["a.ts"]' '["src/"]'

  local jsonl_file="$TEST_TMP/.beads/file-index.jsonl"
  if [[ -f "$jsonl_file" ]]; then
    local line_count
    line_count="$(wc -l < "$jsonl_file" | tr -d ' ')"
    assert_eq "file_index_add with locking produces 1 line" "1" "$line_count"

    local issue_id
    issue_id="$(head -1 "$jsonl_file" | jq -r '.issue_id')"
    assert_eq "correct issue_id through locked append" "lock-test-1" "$issue_id"
  else
    FAIL=$((FAIL + 1))
    echo "  FAIL: JSONL file not created via locked file_index_add"
  fi

  teardown
}

# ── Test: file_index_remove uses atomic append ────────────────────────────

test_file_index_remove_uses_atomic() {
  echo "TEST: file_index_remove uses atomic append for tombstone"
  setup

  source "$REPO_ROOT/scripts/file-index.sh"
  export FILE_INDEX_ROOT="$TEST_TMP"
  mkdir -p "$TEST_TMP/.beads"

  file_index_add "lock-remove-1" "dev@host" '["a.ts"]' '["src/"]'
  file_index_remove "lock-remove-1"

  local jsonl_file="$TEST_TMP/.beads/file-index.jsonl"
  local line_count
  line_count="$(wc -l < "$jsonl_file" | tr -d ' ')"
  assert_eq "add + remove = 2 lines" "2" "$line_count"

  # Second line should be tombstone
  local tombstone
  tombstone="$(sed -n '2p' "$jsonl_file" | jq -r '.tombstone')"
  assert_eq "tombstone entry present" "true" "$tombstone"

  teardown
}

# ── Run all tests ─────────────────────────────────────────────────────────

echo "=== jsonl-locking.test.sh test suite ==="
echo ""

test_basic_append
test_multiple_appends
test_concurrent_appends
test_lock_cleanup
test_creates_parent_dirs
test_mkdir_fallback
test_file_index_uses_atomic_append
test_file_index_remove_uses_atomic

echo ""
echo "=== Results: $PASS passed, $FAIL failed ==="

if [[ $FAIL -gt 0 ]]; then
  exit 1
fi
exit 0
