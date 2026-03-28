#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# ── Setup temp dir for test isolation ────────────────────────────────────
TEST_TMP="$(mktemp -d)"
trap 'rm -rf "$TEST_TMP"' EXIT

# ── Create mock bd ───────────────────────────────────────────────────────
mock_dir="$(mktemp -d)"

cat > "$mock_dir/bd" << 'MOCK'
#!/usr/bin/env bash
case "$1 $2" in
  "show forge-epic1")
    cat << 'SHOW'
◐ forge-epic1 · Test Epic [● P2 · IN_PROGRESS]
Owner: devone

BLOCKS
  ← ✓ forge-child1: Child 1 (closed)
  ← ◐ forge-child2: Child 2 (in_progress)
  ← ○ forge-child3: Child 3 (open)
SHOW
    ;;
  "show forge-child1")
    echo "✓ forge-child1 · Child 1 [● P2 · CLOSED]"
    echo "Owner: devone"
    ;;
  "show forge-child2")
    echo "◐ forge-child2 · Child 2 [● P2 · IN_PROGRESS]"
    echo "Owner: devtwo"
    ;;
  "show forge-child3")
    echo "○ forge-child3 · Child 3 [● P3 · OPEN]"
    echo "Owner: devone"
    ;;
  "show forge-empty")
    cat << 'SHOW'
○ forge-empty · Empty Epic [● P2 · OPEN]
Owner: devone
SHOW
    ;;
  "show forge-blocked")
    cat << 'SHOW'
◐ forge-blocked · Blocked Epic [● P2 · IN_PROGRESS]
Owner: devone

BLOCKS
  ← ✓ forge-bchild1: Bchild 1 (closed)
  ← ◐ forge-bchild2: Bchild 2 (in_progress)
  ← ○ forge-bchild3: Bchild 3 (open)
SHOW
    ;;
  "show forge-bchild1")
    echo "✓ forge-bchild1 · Bchild 1 [● P2 · CLOSED]"
    echo "Owner: devone"
    ;;
  "show forge-bchild2")
    cat << 'SHOW'
◐ forge-bchild2 · Bchild 2 [● P2 · IN_PROGRESS]
Owner: devtwo

BLOCKED_BY
  → forge-bchild1: Bchild 1
SHOW
    ;;
  "show forge-bchild3")
    echo "○ forge-bchild3 · Bchild 3 [● P3 · OPEN]"
    echo "Owner: devone"
    ;;
esac
MOCK
chmod +x "$mock_dir/bd"

export BD_CMD="$mock_dir/bd"

# Source the library under test
source "$SCRIPT_DIR/lib/epic.sh"

PASS=0
FAIL=0

assert_eq() {
  local label="$1" expected="$2" actual="$3"
  if [[ "$actual" == "$expected" ]]; then
    PASS=$((PASS + 1)); echo "  PASS: $label"
  else
    FAIL=$((FAIL + 1)); echo "  FAIL: $label (expected '$expected', got '$actual')"
  fi
}

assert_contains() {
  local label="$1" expected="$2" actual="$3"
  if [[ "$actual" == *"$expected"* ]]; then
    PASS=$((PASS + 1)); echo "  PASS: $label"
  else
    FAIL=$((FAIL + 1)); echo "  FAIL: $label (expected to contain '$expected', got '$actual')"
  fi
}

assert_exit() {
  local label="$1" expected="$2" actual="$3"
  if [[ "$actual" -eq "$expected" ]]; then
    PASS=$((PASS + 1)); echo "  PASS: $label"
  else
    FAIL=$((FAIL + 1)); echo "  FAIL: $label (expected exit $expected, got $actual)"
  fi
}

# ── Test 1: Epic with mixed status children → correct progress count ─────
echo "── Test 1: Epic with mixed status children ──"
rc=0
output="$(cmd_epic "forge-epic1" 2>&1)" || rc=$?
assert_exit "exits 0" 0 "$rc"
assert_contains "shows epic id" "forge-epic1" "$output"
assert_contains "progress shows 1/3" "1/3" "$output"
assert_contains "shows closed child marker" "forge-child1" "$output"
assert_contains "shows in_progress child" "forge-child2" "$output"
assert_contains "shows open child" "forge-child3" "$output"

# ── Test 2: Per-developer breakdown correct ──────────────────────────────
echo ""
echo "── Test 2: Per-developer breakdown correct ──"
assert_contains "devone breakdown" "devone" "$output"
assert_contains "devtwo breakdown" "devtwo" "$output"

# ── Test 3: Completion percentage correct ────────────────────────────────
echo ""
echo "── Test 3: Completion percentage correct ──"
assert_contains "shows 33%" "33%" "$output"

# ── Test 4: Empty epic → No child issues ─────────────────────────────────
echo ""
echo "── Test 4: Empty epic ──"
rc=0
output_empty="$(cmd_epic "forge-empty" 2>&1)" || rc=$?
assert_exit "exits 0 for empty epic" 0 "$rc"
assert_contains "shows no child issues" "No child issues" "$output_empty"

# ── Test 5: --format=json → valid JSON with all fields ───────────────────
echo ""
echo "── Test 5: --format=json ──"
rc=0
output_json="$(cmd_epic "forge-epic1" "--format=json" 2>&1)" || rc=$?
assert_exit "json exits 0" 0 "$rc"
# Validate it's actual JSON (check for opening brace and key fields)
assert_contains "json has epic_id" "epic_id" "$output_json"
assert_contains "json has total" "total" "$output_json"
assert_contains "json has done" "done" "$output_json"
assert_contains "json has percentage" "percentage" "$output_json"
assert_contains "json has children" "children" "$output_json"
assert_contains "json has by_developer" "by_developer" "$output_json"

# ── Test 6: Missing issue-id → error ────────────────────────────────────
echo ""
echo "── Test 6: Missing issue-id ──"
rc=0
output_missing="$(cmd_epic 2>&1)" || rc=$?
assert_exit "missing id returns 1" 1 "$rc"
assert_contains "error about usage" "Usage" "$output_missing"

# ── Test 7: Blocked children shown ───────────────────────────────────────
echo ""
echo "── Test 7: Blocked children shown ──"
rc=0
output_blocked="$(cmd_epic "forge-blocked" 2>&1)" || rc=$?
assert_exit "blocked epic exits 0" 0 "$rc"
assert_contains "blocked section present" "Blocked" "$output_blocked"
assert_contains "blocked child mentioned" "forge-bchild2" "$output_blocked"

# ── Results ──────────────────────────────────────────────────────────────
echo ""
echo "Results: $PASS passed, $FAIL failed"
[[ $FAIL -eq 0 ]] && exit 0 || exit 1
