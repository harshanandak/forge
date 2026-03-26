#!/usr/bin/env bash
# Integration tests for pr-coordinator.sh
# Tests end-to-end workflows and edge cases from the design doc

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PR_COORD="$SCRIPT_DIR/scripts/pr-coordinator.sh"
PASS=0
FAIL=0
TEST_TMP=""

setup() {
  TEST_TMP="$(mktemp -d)"
  mkdir -p "$TEST_TMP/mock"
}

teardown() {
  rm -rf "$TEST_TMP"
}

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
    FAIL=$((FAIL + 1)); echo "  FAIL: $label (expected to contain '$expected')"
  fi
}

assert_not_contains() {
  local label="$1" unexpected="$2" actual="$3"
  if [[ "$actual" != *"$unexpected"* ]]; then
    PASS=$((PASS + 1)); echo "  PASS: $label"
  else
    FAIL=$((FAIL + 1)); echo "  FAIL: $label (should NOT contain '$unexpected')"
  fi
}

# ── Integration 1: Full dep workflow ──
test_full_dep_workflow() {
  echo "Test: Full dependency workflow (add → merge-order)"
  setup

  # Mock bd with two issues: forge-a depends on forge-b
  cat > "$TEST_TMP/mock/bd" << 'MOCK'
#!/usr/bin/env bash
case "$1 $2" in
  "dep add") echo "Dependency added" ;;
  "dep remove") echo "Dependency removed" ;;
  "dep cycles") echo "No cycles found" ;;
  "list --status=open,in_progress")
    echo "○ forge-a · Issue A"
    echo "○ forge-b · Issue B" ;;
  "show forge-a")
    echo "DEPENDS ON"
    echo "  → forge-b: Issue B" ;;
  "show forge-b")
    echo "No dependencies" ;;
esac
MOCK
  chmod +x "$TEST_TMP/mock/bd"

  # Add dependency
  local output
  output="$(BD_CMD="$TEST_TMP/mock/bd" bash "$PR_COORD" dep add forge-a forge-b 2>&1)"; local rc=$?
  assert_exit_code "dep add succeeds" 0 "$rc"
  assert_contains "dep add confirms" "Dependency added" "$output"

  # Check merge order
  output="$(BD_CMD="$TEST_TMP/mock/bd" bash "$PR_COORD" merge-order 2>&1)"; rc=$?
  assert_exit_code "merge-order succeeds" 0 "$rc"
  # forge-b should come before forge-a (b has no deps, a depends on b)
  assert_contains "merge-order lists forge-b" "forge-b" "$output"
  assert_contains "merge-order lists forge-a" "forge-a" "$output"

  teardown
}

# ── Integration 2: Merge sim + rebase check ──
test_merge_sim_rebase_flow() {
  echo "Test: Merge sim detects conflict, rebase-check flags branch"
  setup

  # Create test git repo
  local repo="$TEST_TMP/repo"
  mkdir -p "$repo"
  git -C "$repo" init
  git -C "$repo" config user.email "test@test.com"
  git -C "$repo" config user.name "Test"

  echo "base" > "$repo/shared.txt"
  git -C "$repo" add -A && git -C "$repo" commit -m "initial"

  # Branch A modifies shared.txt
  git -C "$repo" checkout -b feat/branch-a
  echo "branch-a change" > "$repo/shared.txt"
  git -C "$repo" add -A && git -C "$repo" commit -m "branch-a changes"
  git -C "$repo" checkout master

  # Master also modifies shared.txt
  echo "master change" > "$repo/shared.txt"
  git -C "$repo" add -A && git -C "$repo" commit -m "master changes"

  # Merge sim should detect conflict (run from inside the test repo)
  local output
  output="$(cd "$repo" && bash "$PR_COORD" merge-sim feat/branch-a --base=master 2>&1)"; local rc=$?
  assert_exit_code "merge-sim detects conflict" 1 "$rc"
  assert_contains "reports shared.txt" "shared.txt" "$output"

  # Rebase check should flag branch-a
  output="$(cd "$repo" && bash "$PR_COORD" rebase-check --base=master 2>&1)"; rc=$?
  assert_contains "rebase-check flags branch-a" "feat/branch-a" "$output"
  assert_contains "reports conflict rebase" "CONFLICT REBASE" "$output"

  teardown
}

# ── Edge A: Circular dep rejection ──
test_edge_a_circular_dep() {
  echo "Test: Edge A — circular dependency rejected and rolled back"
  setup

  cat > "$TEST_TMP/mock/bd" << 'MOCK'
#!/usr/bin/env bash
case "$1 $2" in
  "dep add") echo "Dependency added" ;;
  "dep remove") echo "Dependency removed" ;;
  "dep cycles") echo "Cycle detected: forge-a -> forge-b -> forge-a" ;;
esac
MOCK
  chmod +x "$TEST_TMP/mock/bd"

  local output
  output="$(BD_CMD="$TEST_TMP/mock/bd" bash "$PR_COORD" dep add forge-a forge-b 2>&1)"; local rc=$?
  assert_exit_code "circular dep exits 1" 1 "$rc"
  assert_contains "reports circular" "circular dependency" "$output"

  teardown
}

# ── Edge E: Two PRs same files ──
test_edge_e_same_files_no_dep() {
  echo "Test: Edge E — two branches modify same file, merge-sim both conflict"
  setup

  local repo="$TEST_TMP/repo2"
  mkdir -p "$repo"
  git -C "$repo" init
  git -C "$repo" config user.email "test@test.com"
  git -C "$repo" config user.name "Test"

  echo "base" > "$repo/shared.txt"
  git -C "$repo" add -A && git -C "$repo" commit -m "initial"

  # Branch 1
  git -C "$repo" checkout -b feat/pr-1
  echo "pr-1 change" > "$repo/shared.txt"
  git -C "$repo" add -A && git -C "$repo" commit -m "pr-1"
  git -C "$repo" checkout master

  # Branch 2
  git -C "$repo" checkout -b feat/pr-2
  echo "pr-2 change" > "$repo/shared.txt"
  git -C "$repo" add -A && git -C "$repo" commit -m "pr-2"
  git -C "$repo" checkout master

  # Advance master
  echo "master change" > "$repo/shared.txt"
  git -C "$repo" add -A && git -C "$repo" commit -m "master"

  # Both should show conflicts
  local output1 output2
  output1="$(cd "$repo" && bash "$PR_COORD" merge-sim feat/pr-1 --base=master 2>&1)"; local rc1=$?
  output2="$(cd "$repo" && bash "$PR_COORD" merge-sim feat/pr-2 --base=master 2>&1)"; local rc2=$?

  assert_exit_code "pr-1 has conflicts" 1 "$rc1"
  assert_exit_code "pr-2 has conflicts" 1 "$rc2"
  assert_contains "pr-1 reports shared.txt" "shared.txt" "$output1"
  assert_contains "pr-2 reports shared.txt" "shared.txt" "$output2"

  teardown
}

# ── Edge H: Multiple PRs per issue ──
test_edge_h_multiple_prs() {
  echo "Test: Edge H — set-pr updates PR number (last one wins)"
  setup

  cat > "$TEST_TMP/mock/bd" << 'MOCK'
#!/usr/bin/env bash
case "$1" in
  set-state) echo "State set: $*" ;;
esac
MOCK
  chmod +x "$TEST_TMP/mock/bd"

  local output1 output2
  output1="$(BD_CMD="$TEST_TMP/mock/bd" bash "$PR_COORD" dep set-pr forge-test 42 2>&1)"; local rc1=$?
  output2="$(BD_CMD="$TEST_TMP/mock/bd" bash "$PR_COORD" dep set-pr forge-test 99 2>&1)"; local rc2=$?

  assert_exit_code "first set-pr succeeds" 0 "$rc1"
  assert_exit_code "second set-pr succeeds" 0 "$rc2"
  assert_contains "first links PR 42" "42" "$output1"
  assert_contains "second links PR 99" "99" "$output2"

  teardown
}

# ── Edge I: Independent PRs ──
test_edge_i_independent() {
  echo "Test: Edge I — independent PRs can merge in any order"
  setup

  cat > "$TEST_TMP/mock/bd" << 'MOCK'
#!/usr/bin/env bash
case "$1 $2" in
  "dep cycles") echo "No cycles found" ;;
  "list --status=open,in_progress")
    echo "○ forge-x · Issue X"
    echo "○ forge-y · Issue Y" ;;
  "show forge-x") echo "No dependencies" ;;
  "show forge-y") echo "No dependencies" ;;
esac
MOCK
  chmod +x "$TEST_TMP/mock/bd"

  local output
  output="$(BD_CMD="$TEST_TMP/mock/bd" bash "$PR_COORD" merge-order 2>&1)"; local rc=$?
  assert_exit_code "merge-order succeeds" 0 "$rc"
  assert_contains "any order" "any order" "$output"

  teardown
}

# ── Run all tests ──
echo "=== PR Coordinator Integration Tests ==="
test_full_dep_workflow
echo ""
test_merge_sim_rebase_flow
echo ""
test_edge_a_circular_dep
echo ""
test_edge_e_same_files_no_dep
echo ""
test_edge_h_multiple_prs
echo ""
test_edge_i_independent

echo ""
echo "Results: $PASS passed, $FAIL failed"
[[ $FAIL -eq 0 ]] && exit 0 || exit 1
