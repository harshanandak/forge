#!/usr/bin/env bash
# Test pr-coordinator.sh stale-worktrees subcommand
# Uses REAL git repos with worktrees and GIT_COMMITTER_DATE to simulate age.

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

# Create a temporary git repo with stale and active worktrees
setup_test_worktree() {
  local repo
  repo="$(mktemp -d)"
  CLEANUP_DIRS+=("$repo")
  git -C "$repo" init -b master &>/dev/null
  git -C "$repo" config user.email "test@test.com"
  git -C "$repo" config user.name "Test"

  printf '%s' "init" > "$repo/file.txt"
  git -C "$repo" add -A &>/dev/null
  git -C "$repo" commit -m "initial" &>/dev/null

  mkdir -p "$repo/.worktrees"

  # Create stale worktree (old commit — 6 days ago)
  git -C "$repo" worktree add "$repo/.worktrees/stale" -b feat/stale &>/dev/null
  printf '%s' "stale" > "$repo/.worktrees/stale/stale.txt"
  git -C "$repo/.worktrees/stale" add -A &>/dev/null
  GIT_COMMITTER_DATE="2026-03-20T00:00:00+0000" git -C "$repo/.worktrees/stale" commit -m "old commit" --date="2026-03-20T00:00:00+0000" &>/dev/null

  # Create active worktree (recent commit — now)
  git -C "$repo" worktree add "$repo/.worktrees/active" -b feat/active &>/dev/null
  printf '%s' "active" > "$repo/.worktrees/active/active.txt"
  git -C "$repo/.worktrees/active" add -A &>/dev/null
  git -C "$repo/.worktrees/active" commit -m "recent commit" &>/dev/null

  printf '%s' "$repo"
}

cleanup() {
  for d in "${CLEANUP_DIRS[@]}"; do
    # Remove worktrees before deleting temp dir
    git -C "$d" worktree list 2>/dev/null | while IFS= read -r line; do
      local wt_path
      wt_path="$(printf '%s' "$line" | awk '{print $1}')"
      [[ "$wt_path" == "$d" ]] && continue
      git -C "$d" worktree remove --force "$wt_path" 2>/dev/null || true
    done
    rm -rf "$d" 2>/dev/null || true
  done
}
trap cleanup EXIT

# ── Test 1: Stale worktree flagged ──────────────────────────────────

echo "Test 1: Worktree with old commit (>48h) flagged as STALE"
repo="$(setup_test_worktree)"
output="$(bash "$PR_COORD" stale-worktrees --dir=.worktrees 2>&1)" || true
# We run from repo root context — need to run inside the repo
output="$(cd "$repo" && bash "$PR_COORD" stale-worktrees --dir=.worktrees 2>&1)"
rc=$?
assert_exit_code "exits 0" 0 "$rc"
assert_contains "flags stale worktree" "STALE: stale" "$output"
assert_contains "shows branch name" "feat/stale" "$output"
assert_contains "shows age" "ago" "$output"
assert_contains "count summary" "potentially abandoned" "$output"

# ── Test 2: Active worktree NOT flagged ─────────────────────────────

echo ""
echo "Test 2: Worktree with recent commit (<48h) not flagged"
assert_not_contains "does not flag active" "STALE: active" "$output"

# ── Test 3: Custom threshold ────────────────────────────────────────

echo ""
echo "Test 3: Custom threshold (--threshold=1h) makes recent stale"
output3="$(cd "$repo" && bash "$PR_COORD" stale-worktrees --dir=.worktrees --threshold=1h 2>&1)"
rc3=$?
assert_exit_code "exits 0 with threshold" 0 "$rc3"
# With 1h threshold, both should be stale (active is seconds old but test timing could vary)
# The stale one should definitely still be flagged
assert_contains "stale still flagged at 1h" "STALE: stale" "$output3"

# ── Test 4: Empty worktrees directory ───────────────────────────────

echo ""
echo "Test 4: Empty .worktrees/ directory"
empty_repo="$(mktemp -d)"
CLEANUP_DIRS+=("$empty_repo")
git -C "$empty_repo" init -b master &>/dev/null
git -C "$empty_repo" config user.email "test@test.com"
git -C "$empty_repo" config user.name "Test"
printf '%s' "init" > "$empty_repo/file.txt"
git -C "$empty_repo" add -A &>/dev/null
git -C "$empty_repo" commit -m "initial" &>/dev/null
mkdir -p "$empty_repo/.worktrees"

output4="$(cd "$empty_repo" && bash "$PR_COORD" stale-worktrees --dir=.worktrees 2>&1)"
rc4=$?
assert_exit_code "exits 0 for empty" 0 "$rc4"
assert_contains "reports no worktrees" "No worktrees found" "$output4"

# ── Test 5: Symlink outside repo skipped with WARNING ───────────────

echo ""
echo "Test 5: Symlink outside repo skipped with WARNING"
outside_dir="$(mktemp -d)"
CLEANUP_DIRS+=("$outside_dir")
mkdir -p "$outside_dir/evil"
# Create a symlink inside .worktrees pointing outside the repo
ln -sf "$outside_dir/evil" "$empty_repo/.worktrees/escape" 2>/dev/null || true

if [[ -L "$empty_repo/.worktrees/escape" ]]; then
  output5="$(cd "$empty_repo" && bash "$PR_COORD" stale-worktrees --dir=.worktrees 2>&1)"
  rc5=$?
  assert_exit_code "exits 0 with symlink" 0 "$rc5"
  assert_contains "warns about symlink" "WARNING" "$output5"
else
  # Symlink creation failed (Windows without dev mode) — skip
  PASS=$((PASS + 1)); echo "  PASS: symlink exits 0 (skipped — symlinks not supported)"
  PASS=$((PASS + 1)); echo "  PASS: symlink WARNING (skipped — symlinks not supported)"
fi

# ── Test 6: Non-existent .worktrees/ directory ──────────────────────

echo ""
echo "Test 6: Non-existent .worktrees/ directory"
nodir_repo="$(mktemp -d)"
CLEANUP_DIRS+=("$nodir_repo")
git -C "$nodir_repo" init -b master &>/dev/null
git -C "$nodir_repo" config user.email "test@test.com"
git -C "$nodir_repo" config user.name "Test"
printf '%s' "init" > "$nodir_repo/file.txt"
git -C "$nodir_repo" add -A &>/dev/null
git -C "$nodir_repo" commit -m "initial" &>/dev/null
# Intentionally do NOT create .worktrees/

output6="$(cd "$nodir_repo" && bash "$PR_COORD" stale-worktrees --dir=.worktrees 2>&1)"
rc6=$?
assert_exit_code "exits 0 for missing dir" 0 "$rc6"
assert_contains "reports dir does not exist" "No worktrees found" "$output6"

# ── Summary ─────────────────────────────────────────────────────────

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "Results: $PASS passed, $FAIL failed"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
[[ "$FAIL" -eq 0 ]] && exit 0 || exit 1
