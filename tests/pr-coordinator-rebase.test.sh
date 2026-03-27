#!/usr/bin/env bash
# Tests for pr-coordinator.sh rebase-check subcommand
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
PR_COORD="$PROJECT_DIR/scripts/pr-coordinator.sh"

PASS=0
FAIL=0
ERRORS=""

assert_contains() {
  local label="$1" output="$2" expected="$3"
  if printf '%s' "$output" | grep -qF "$expected"; then
    PASS=$((PASS + 1))
  else
    FAIL=$((FAIL + 1))
    ERRORS="${ERRORS}\nFAIL: ${label}\n  Expected to contain: ${expected}\n  Got: ${output}\n"
  fi
}

assert_not_contains() {
  local label="$1" output="$2" unexpected="$3"
  if printf '%s' "$output" | grep -qF "$unexpected"; then
    FAIL=$((FAIL + 1))
    ERRORS="${ERRORS}\nFAIL: ${label}\n  Expected NOT to contain: ${unexpected}\n  Got: ${output}\n"
  else
    PASS=$((PASS + 1))
  fi
}

# ── Setup helper: create a test repo with controlled topology ──────────

setup_test_repo() {
  local repo
  repo="$(mktemp -d)"
  git -C "$repo" init -b master --quiet
  git -C "$repo" config user.email "test@test.com"
  git -C "$repo" config user.name "Test"

  # Initial commit with two files
  echo "base" > "$repo/file-a.txt"
  echo "base" > "$repo/file-b.txt"
  echo "base" > "$repo/file-c.txt"
  git -C "$repo" add -A
  git -C "$repo" commit -m "initial" --quiet

  # Branch with overlap: modifies file-a.txt (master will also modify it)
  git -C "$repo" checkout -b feat/overlap --quiet
  echo "branch change" > "$repo/file-a.txt"
  git -C "$repo" add -A
  git -C "$repo" commit -m "branch: modify file-a" --quiet
  git -C "$repo" checkout master --quiet

  # Branch with no overlap: modifies file-b.txt (master modifies file-a.txt)
  git -C "$repo" checkout -b feat/clean --quiet
  echo "branch change" > "$repo/file-b.txt"
  git -C "$repo" add -A
  git -C "$repo" commit -m "branch: modify file-b" --quiet
  git -C "$repo" checkout master --quiet

  # Up-to-date branch: created AFTER master advances, so not behind
  # (we'll create this after advancing master)

  # Advance master (modifies file-a.txt)
  echo "master change" > "$repo/file-a.txt"
  git -C "$repo" add -A
  git -C "$repo" commit -m "master: modify file-a" --quiet

  # Up-to-date branch: branched from latest master
  git -C "$repo" checkout -b feat/uptodate --quiet
  echo "new feature" > "$repo/file-c.txt"
  git -C "$repo" add -A
  git -C "$repo" commit -m "branch: modify file-c" --quiet
  git -C "$repo" checkout master --quiet

  printf '%s' "$repo"
}

# ── Test 1: Branch behind with overlapping files → CONFLICT REBASE ─────

test_conflict_rebase() {
  local repo
  repo="$(setup_test_repo)"

  local output
  output="$(cd "$repo" && bash "$PR_COORD" rebase-check 2>&1)" || true

  assert_contains "conflict rebase listed" "$output" "CONFLICT REBASE: feat/overlap"
  assert_contains "overlap file shown" "$output" "file-a.txt"

  rm -rf "$repo"
}

# ── Test 2: Branch behind with no overlap → CLEAN REBASE ──────────────

test_clean_rebase() {
  local repo
  repo="$(setup_test_repo)"

  local output
  output="$(cd "$repo" && bash "$PR_COORD" rebase-check 2>&1)" || true

  assert_contains "clean rebase listed" "$output" "CLEAN REBASE: feat/clean"
  assert_not_contains "clean branch not conflict" "$output" "CONFLICT REBASE: feat/clean"

  rm -rf "$repo"
}

# ── Test 3: Up-to-date branch → not listed ────────────────────────────

test_uptodate_not_listed() {
  local repo
  repo="$(setup_test_repo)"

  local output
  output="$(cd "$repo" && bash "$PR_COORD" rebase-check 2>&1)" || true

  assert_not_contains "uptodate not listed" "$output" "feat/uptodate"

  rm -rf "$repo"
}

# ── Test 4: --after-merge flag filters to specific branch changes ──────

test_after_merge_flag() {
  local repo
  repo="$(mktemp -d)"
  git -C "$repo" init -b master --quiet
  git -C "$repo" config user.email "test@test.com"
  git -C "$repo" config user.name "Test"

  # Initial commit
  echo "base" > "$repo/file-a.txt"
  echo "base" > "$repo/file-b.txt"
  echo "base" > "$repo/file-c.txt"
  git -C "$repo" add -A
  git -C "$repo" commit -m "initial" --quiet

  # Feature branch that touches file-a.txt
  git -C "$repo" checkout -b feat/branch-a --quiet
  echo "branch-a change" > "$repo/file-a.txt"
  git -C "$repo" add -A
  git -C "$repo" commit -m "branch-a: modify file-a" --quiet
  git -C "$repo" checkout master --quiet

  # Feature branch that touches file-b.txt
  git -C "$repo" checkout -b feat/branch-b --quiet
  echo "branch-b change" > "$repo/file-b.txt"
  git -C "$repo" add -A
  git -C "$repo" commit -m "branch-b: modify file-b" --quiet
  git -C "$repo" checkout master --quiet

  # Simulate merging a branch that only touched file-a.txt
  # Create the "merged" branch ref on master
  git -C "$repo" checkout -b feat/just-merged --quiet
  echo "merged change" > "$repo/file-a.txt"
  git -C "$repo" add -A
  git -C "$repo" commit -m "just-merged: modify file-a" --quiet
  git -C "$repo" checkout master --quiet

  # Merge feat/just-merged into master
  git -C "$repo" merge feat/just-merged --no-ff -m "merge just-merged" --quiet

  local output
  output="$(cd "$repo" && bash "$PR_COORD" rebase-check --after-merge=feat/just-merged 2>&1)" || true

  # feat/branch-a overlaps with just-merged (both touch file-a.txt)
  assert_contains "after-merge shows overlap" "$output" "CONFLICT REBASE: feat/branch-a"
  assert_contains "after-merge overlap file" "$output" "file-a.txt"

  # feat/branch-b does NOT overlap with just-merged (branch-b touches file-b, just-merged touches file-a)
  assert_not_contains "after-merge no false conflict" "$output" "CONFLICT REBASE: feat/branch-b"

  rm -rf "$repo"
}

# ── Test 5: No branches need rebasing → message ───────────────────────

test_no_branches() {
  local repo
  repo="$(mktemp -d)"
  git -C "$repo" init -b master --quiet
  git -C "$repo" config user.email "test@test.com"
  git -C "$repo" config user.name "Test"

  echo "base" > "$repo/file-a.txt"
  git -C "$repo" add -A
  git -C "$repo" commit -m "initial" --quiet

  local output
  output="$(cd "$repo" && bash "$PR_COORD" rebase-check 2>&1)" || true

  assert_contains "no branches message" "$output" "No branches need rebasing"

  rm -rf "$repo"
}

# ── Run all tests ──────────────────────────────────────────────────────

echo "=== pr-coordinator rebase-check tests ==="

test_conflict_rebase
test_clean_rebase
test_uptodate_not_listed
test_after_merge_flag
test_no_branches

echo ""
echo "Results: $PASS passed, $FAIL failed"
if [[ $FAIL -gt 0 ]]; then
  printf '%b' "$ERRORS"
  exit 1
fi
echo "All tests passed!"
exit 0
