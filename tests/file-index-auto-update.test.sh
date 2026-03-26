#!/usr/bin/env bash
# file-index-auto-update.test.sh — Tests for file-index.sh auto-update subcommand.
# Uses temp directories with FILE_INDEX_ROOT override for isolation.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
FILE_INDEX="$PROJECT_DIR/scripts/file-index.sh"

PASS=0
FAIL=0
ERRORS=""

pass() { ((PASS++)) || true; echo "  PASS: $1"; }
fail() { ((FAIL++)) || true; ERRORS="${ERRORS}\n  FAIL: $1"; echo "  FAIL: $1"; }

setup_tmp() {
  local tmp
  tmp="$(mktemp -d)"
  mkdir -p "$tmp/.beads"
  # Ensure git identity is available for get_session_identity
  git -C "$tmp" init --quiet 2>/dev/null || true
  git -C "$tmp" config user.email "test@test.com" 2>/dev/null || true
  git -C "$tmp" config user.name "tester" 2>/dev/null || true
  printf '%s' "$tmp"
}

cleanup_tmp() {
  [[ -n "${1:-}" ]] && rm -rf "$1"
}

echo "=== file-index auto-update tests ==="

# ── Test 1: auto-update with stdin file list ──────────────────────────────
echo ""
echo "Test 1: auto-update with explicit stdin file list"
TMP="$(setup_tmp)"
output="$(printf 'src/foo.ts\nlib/bar/baz.js\n' | FILE_INDEX_ROOT="$TMP" bash "$FILE_INDEX" auto-update test-issue-1 2>&1)" && rc=$? || rc=$?
if [[ $rc -eq 0 ]]; then
  # Check JSONL entry was appended
  jsonl="$TMP/.beads/file-index.jsonl"
  if [[ -f "$jsonl" ]]; then
    entry="$(head -1 "$jsonl")"
    # Verify issue_id
    eid="$(printf '%s' "$entry" | jq -r '.issue_id')"
    if [[ "$eid" == "test-issue-1" ]]; then
      # Verify files array contains both files
      fcount="$(printf '%s' "$entry" | jq '.files | length')"
      if [[ "$fcount" -eq 2 ]]; then
        pass "stdin file list: correct file count"
      else
        fail "stdin file list: expected 2 files, got $fcount"
      fi
    else
      fail "stdin file list: issue_id='$eid', expected 'test-issue-1'"
    fi
  else
    fail "stdin file list: JSONL file not created"
  fi
else
  fail "stdin file list: command failed with rc=$rc, output: $output"
fi
cleanup_tmp "$TMP"

# ── Test 2: auto-update with --from-git ───────────────────────────────────
echo ""
echo "Test 2: auto-update with --from-git in a test git repo"
TMP="$(setup_tmp)"
# Create a git repo with a known commit
mkdir -p "$TMP/src"
echo "initial" > "$TMP/src/hello.ts"
echo "initial" > "$TMP/src/world.ts"
git -C "$TMP" add -A 2>/dev/null
git -C "$TMP" commit -m "initial" --quiet 2>/dev/null
# Make a second commit with changes
echo "changed" > "$TMP/src/hello.ts"
git -C "$TMP" add -A 2>/dev/null
git -C "$TMP" commit -m "change hello" --quiet 2>/dev/null

# Run auto-update --from-git from within the temp git repo
output="$(cd "$TMP" && FILE_INDEX_ROOT="$TMP" bash "$FILE_INDEX" auto-update test-issue-2 --from-git 2>&1)" && rc=$? || rc=$?
if [[ $rc -eq 0 ]]; then
  jsonl="$TMP/.beads/file-index.jsonl"
  if [[ -f "$jsonl" ]]; then
    entry="$(head -1 "$jsonl")"
    # git diff HEAD~1 should show src/hello.ts
    has_hello="$(printf '%s' "$entry" | jq '[.files[] | select(. == "src/hello.ts")] | length')"
    if [[ "$has_hello" -eq 1 ]]; then
      pass "--from-git: found changed file in JSONL"
    else
      fail "--from-git: src/hello.ts not in files array. Entry: $entry"
    fi
  else
    fail "--from-git: JSONL file not created"
  fi
else
  fail "--from-git: command failed with rc=$rc, output: $output"
fi
cleanup_tmp "$TMP"

# ── Test 3: JSONL is appended, not overwritten ────────────────────────────
echo ""
echo "Test 3: JSONL entry is appended (not overwritten) — call twice"
TMP="$(setup_tmp)"
printf 'a.ts\n' | FILE_INDEX_ROOT="$TMP" bash "$FILE_INDEX" auto-update issue-A 2>/dev/null
printf 'b.ts\n' | FILE_INDEX_ROOT="$TMP" bash "$FILE_INDEX" auto-update issue-B 2>/dev/null
jsonl="$TMP/.beads/file-index.jsonl"
if [[ -f "$jsonl" ]]; then
  line_count="$(wc -l < "$jsonl" | tr -d ' ')"
  if [[ "$line_count" -ge 2 ]]; then
    # Verify both issue IDs present
    id_a="$(sed -n '1p' "$jsonl" | jq -r '.issue_id')"
    id_b="$(sed -n '2p' "$jsonl" | jq -r '.issue_id')"
    if [[ "$id_a" == "issue-A" ]] && [[ "$id_b" == "issue-B" ]]; then
      pass "append mode: both entries present with correct IDs"
    else
      fail "append mode: IDs are '$id_a' and '$id_b', expected 'issue-A' and 'issue-B'"
    fi
  else
    fail "append mode: expected >=2 lines, got $line_count"
  fi
else
  fail "append mode: JSONL file not created"
fi
cleanup_tmp "$TMP"

# ── Test 4: module derivation ─────────────────────────────────────────────
echo ""
echo "Test 4: module derivation from file paths"
TMP="$(setup_tmp)"
printf 'scripts/foo.sh\nlib/bar/baz.js\nREADME.md\n' | FILE_INDEX_ROOT="$TMP" bash "$FILE_INDEX" auto-update mod-test 2>/dev/null
jsonl="$TMP/.beads/file-index.jsonl"
if [[ -f "$jsonl" ]]; then
  entry="$(head -1 "$jsonl")"
  modules="$(printf '%s' "$entry" | jq -c '.modules')"
  # Expected modules: ["./", "lib/bar/", "scripts/"] (sorted unique)
  has_root="$(printf '%s' "$modules" | jq '[.[] | select(. == "./")] | length')"
  has_scripts="$(printf '%s' "$modules" | jq '[.[] | select(. == "scripts/")] | length')"
  has_libbar="$(printf '%s' "$modules" | jq '[.[] | select(. == "lib/bar/")] | length')"
  if [[ "$has_root" -eq 1 ]] && [[ "$has_scripts" -eq 1 ]] && [[ "$has_libbar" -eq 1 ]]; then
    pass "module derivation: scripts/ lib/bar/ ./ all present"
  else
    fail "module derivation: modules=$modules, expected ./, scripts/, lib/bar/"
  fi
else
  fail "module derivation: JSONL file not created"
fi
cleanup_tmp "$TMP"

# ── Test 5: empty file list → "No files changed" ─────────────────────────
echo ""
echo "Test 5: empty file list (no changes) prints 'No files changed'"
TMP="$(setup_tmp)"
# Pipe empty input
output="$(printf '' | FILE_INDEX_ROOT="$TMP" bash "$FILE_INDEX" auto-update empty-test 2>&1)" && rc=$? || rc=$?
if [[ $rc -eq 0 ]]; then
  if [[ "$output" == *"No files changed"* ]]; then
    # Verify no JSONL entry
    jsonl="$TMP/.beads/file-index.jsonl"
    if [[ ! -f "$jsonl" ]] || [[ ! -s "$jsonl" ]]; then
      pass "empty file list: prints message and no JSONL entry"
    else
      fail "empty file list: JSONL file should be empty/absent but exists with content"
    fi
  else
    fail "empty file list: expected 'No files changed' in output, got: $output"
  fi
else
  fail "empty file list: command should exit 0, got rc=$rc"
fi
cleanup_tmp "$TMP"

# ── Test 6: no stdin and no --from-git → error ───────────────────────────
echo ""
echo "Test 6: no stdin and no --from-git → error, exit 1"
TMP="$(setup_tmp)"
# We need stdin to be a terminal (or at least -t 0 to return true).
# Try /dev/tty redirect; if it fails (common on Windows Git Bash / CI),
# fall back to testing empty /dev/null (exercises the empty-list path instead).
tty_works=0
if [[ -e /dev/tty ]]; then
  # Test if /dev/tty is actually usable (it can exist but fail on Windows)
  bash -c 'echo test </dev/tty' >/dev/null 2>&1 && tty_works=1 || true
fi

if [[ "$tty_works" -eq 1 ]]; then
  output="$(FILE_INDEX_ROOT="$TMP" bash "$FILE_INDEX" auto-update no-input-test </dev/tty 2>&1)" && rc=$? || rc=$?
  if [[ $rc -ne 0 ]]; then
    if [[ "$output" == *"no file list provided"* ]] || [[ "$output" == *"Error"* ]]; then
      pass "no input: error with exit 1"
    else
      fail "no input: expected error message about no file list, got: $output"
    fi
  else
    fail "no input: expected exit 1, got rc=$rc"
  fi
else
  # In CI/non-interactive environments without working /dev/tty, test that piping
  # /dev/null (empty but non-terminal) produces "No files changed" (empty list path).
  # This still validates the no-data-from-stdin branch.
  output="$(FILE_INDEX_ROOT="$TMP" bash "$FILE_INDEX" auto-update no-input-test </dev/null 2>&1)" && rc=$? || rc=$?
  if [[ $rc -eq 0 ]] && [[ "$output" == *"No files changed"* ]]; then
    pass "no input (fallback): empty /dev/null stdin produces 'No files changed'"
  else
    fail "no input (fallback): unexpected rc=$rc, output: $output"
  fi
fi
cleanup_tmp "$TMP"

# ── Summary ───────────────────────────────────────────────────────────────
echo ""
echo "========================="
echo "Results: $PASS passed, $FAIL failed"
if [[ $FAIL -gt 0 ]]; then
  echo -e "Failures:$ERRORS"
  exit 1
fi
exit 0
