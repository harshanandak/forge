#!/usr/bin/env bash
# Test pr-coordinator.sh merge-sim subcommand
# Uses REAL git repos (not mocks) since we test actual git merge behavior.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PR_COORD="$SCRIPT_DIR/scripts/pr-coordinator.sh"
PASS=0
FAIL=0
CLEANUP_DIRS=()

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
    FAIL=$((FAIL + 1)); echo "  FAIL: $label (expected to contain '$expected', got: $actual)"
  fi
}

assert_not_contains() {
  local label="$1" unexpected="$2" actual="$3"
  if [[ "$actual" != *"$unexpected"* ]]; then
    PASS=$((PASS + 1)); echo "  PASS: $label"
  else
    FAIL=$((FAIL + 1)); echo "  FAIL: $label (expected NOT to contain '$unexpected')"
  fi
}

# Create a temporary git repo with controlled branches for testing
setup_test_repo() {
  local repo
  repo="$(mktemp -d)"
  CLEANUP_DIRS+=("$repo")
  git -C "$repo" init -b master &>/dev/null
  git -C "$repo" config user.email "test@test.com"
  git -C "$repo" config user.name "Test"

  # Initial commit on master
  printf '%s' "base content" > "$repo/file.txt"
  git -C "$repo" add file.txt &>/dev/null
  git -C "$repo" commit -m "initial" &>/dev/null

  # Create clean branch (no conflict — adds a new file)
  git -C "$repo" checkout -b feat/clean &>/dev/null
  printf '%s' "new file" > "$repo/new.txt"
  git -C "$repo" add new.txt &>/dev/null
  git -C "$repo" commit -m "add new file" &>/dev/null
  git -C "$repo" checkout master &>/dev/null

  # Create conflicting branch (modifies same file differently)
  git -C "$repo" checkout -b feat/conflict &>/dev/null
  printf '%s' "conflict content" > "$repo/file.txt"
  git -C "$repo" add file.txt &>/dev/null
  git -C "$repo" commit -m "modify file on branch" &>/dev/null
  git -C "$repo" checkout master &>/dev/null
  printf '%s' "different content" > "$repo/file.txt"
  git -C "$repo" add file.txt &>/dev/null
  git -C "$repo" commit -m "modify file on master" &>/dev/null

  # Create a develop branch (for --base testing)
  git -C "$repo" checkout -b develop &>/dev/null
  printf '%s' "develop content" > "$repo/dev.txt"
  git -C "$repo" add dev.txt &>/dev/null
  git -C "$repo" commit -m "develop commit" &>/dev/null
  git -C "$repo" checkout master &>/dev/null

  printf '%s' "$repo"
}

cleanup() {
  for d in "${CLEANUP_DIRS[@]}"; do
    rm -rf "$d" 2>/dev/null || true
  done
}
trap cleanup EXIT

# ── Test 1: Clean merge ──────────────────────────────────────────────────
echo "── Clean Merge ──"

repo="$(setup_test_repo)"
pushd "$repo" > /dev/null

output="$(bash "$PR_COORD" merge-sim feat/clean 2>&1)"; rc=$?
assert_exit_code "clean merge exits 0" 0 "$rc"
assert_contains "clean merge reports no conflicts" "No conflicts detected" "$output"

popd > /dev/null

# ── Test 2: Conflict detected ────────────────────────────────────────────
echo ""
echo "── Conflict Detected ──"

repo="$(setup_test_repo)"
pushd "$repo" > /dev/null

output="$(bash "$PR_COORD" merge-sim feat/conflict 2>&1)"; rc=$?
assert_exit_code "conflict merge exits 1" 1 "$rc"
assert_contains "conflict reports conflicts" "Conflicts detected" "$output"
assert_contains "conflict lists file" "file.txt" "$output"

popd > /dev/null

# ── Test 3: Non-existent branch ──────────────────────────────────────────
echo ""
echo "── Non-existent Branch ──"

repo="$(setup_test_repo)"
pushd "$repo" > /dev/null

output="$(bash "$PR_COORD" merge-sim feat/does-not-exist 2>&1)"; rc=$?
assert_exit_code "non-existent branch exits 1" 1 "$rc"
assert_contains "non-existent branch error message" "does not exist" "$output"

popd > /dev/null

# ── Test 4: Custom --base flag ───────────────────────────────────────────
echo ""
echo "── Custom Base ──"

repo="$(setup_test_repo)"
pushd "$repo" > /dev/null

output="$(bash "$PR_COORD" merge-sim feat/clean --base=develop 2>&1)"; rc=$?
assert_exit_code "custom base exits 0" 0 "$rc"
assert_contains "custom base reports no conflicts" "No conflicts detected" "$output"
assert_contains "custom base mentions develop" "develop" "$output"

popd > /dev/null

# ── Test 5: Crash recovery — no MERGE_HEAD, original branch restored ────
echo ""
echo "── Crash Recovery ──"

repo="$(setup_test_repo)"
pushd "$repo" > /dev/null

# Record original branch
original_branch="$(git rev-parse --abbrev-ref HEAD)"

# Run a clean merge-sim
bash "$PR_COORD" merge-sim feat/clean 2>&1 > /dev/null; rc=$?

# Verify no MERGE_HEAD left behind
if [[ -f "$repo/.git/MERGE_HEAD" ]]; then
  FAIL=$((FAIL + 1)); echo "  FAIL: MERGE_HEAD exists after clean merge-sim"
else
  PASS=$((PASS + 1)); echo "  PASS: no MERGE_HEAD after clean merge-sim"
fi

# Verify original branch restored
current_branch="$(git rev-parse --abbrev-ref HEAD)"
assert_contains "original branch restored after clean" "$original_branch" "$current_branch"

# Run a conflict merge-sim
bash "$PR_COORD" merge-sim feat/conflict 2>&1 > /dev/null || true

# Verify no MERGE_HEAD left behind
if [[ -f "$repo/.git/MERGE_HEAD" ]]; then
  FAIL=$((FAIL + 1)); echo "  FAIL: MERGE_HEAD exists after conflict merge-sim"
else
  PASS=$((PASS + 1)); echo "  PASS: no MERGE_HEAD after conflict merge-sim"
fi

# Verify original branch restored
current_branch="$(git rev-parse --abbrev-ref HEAD)"
assert_contains "original branch restored after conflict" "$original_branch" "$current_branch"

popd > /dev/null

# ── Test 6: Invalid branch name (dispatcher validation) ─────────────────
echo ""
echo "── Invalid Branch Name ──"

repo="$(setup_test_repo)"
pushd "$repo" > /dev/null

output="$(bash "$PR_COORD" merge-sim ';rm -rf /' 2>&1)"; rc=$?
assert_exit_code "invalid branch name exits 2" 2 "$rc"

popd > /dev/null

# ── Test 7: Missing branch argument ─────────────────────────────────────
echo ""
echo "── Missing Argument ──"

repo="$(setup_test_repo)"
pushd "$repo" > /dev/null

output="$(bash "$PR_COORD" merge-sim 2>&1)"; rc=$?
assert_exit_code "no branch arg exits 1" 1 "$rc"
assert_contains "no branch arg shows usage" "Usage:" "$output"

popd > /dev/null

# ── Test 8: Unknown flag ────────────────────────────────────────────────
echo ""
echo "── Unknown Flag ──"

repo="$(setup_test_repo)"
pushd "$repo" > /dev/null

output="$(bash "$PR_COORD" merge-sim feat/clean --bogus 2>&1)"; rc=$?
assert_exit_code "unknown flag exits 1" 1 "$rc"
assert_contains "unknown flag error message" "unknown flag" "$output"

popd > /dev/null

# ── Test 9: Non-existent base branch ────────────────────────────────────
echo ""
echo "── Non-existent Base Branch ──"

repo="$(setup_test_repo)"
pushd "$repo" > /dev/null

output="$(bash "$PR_COORD" merge-sim feat/clean --base=nonexistent 2>&1)"; rc=$?
assert_exit_code "non-existent base exits 1" 1 "$rc"
assert_contains "non-existent base error" "does not exist" "$output"

popd > /dev/null

# ── Summary ─────────────────────────────────────────────────────────────
echo ""
echo "Results: $PASS passed, $FAIL failed"
[[ $FAIL -eq 0 ]] && exit 0 || exit 1
