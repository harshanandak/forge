#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# ── Setup temp dir for test isolation ────────────────────────────────────
TEST_TMP="$(mktemp -d)"
trap 'rm -rf "$TEST_TMP"' EXIT

# Override TEAM_MAP_ROOT so tests don't touch real .beads/
export TEAM_MAP_ROOT="$TEST_TMP"

# ── Create mock gh ───────────────────────────────────────────────────────
mock_dir="$(mktemp -d)"

cat > "$mock_dir/gh" << 'MOCK'
#!/usr/bin/env bash
case "$1 $2" in
  "issue view")
    # Determine issue number from args
    issue_num=""
    for arg in "$@"; do
      if [[ "$arg" =~ ^[0-9]+$ ]]; then
        issue_num="$arg"
        break
      fi
    done
    if echo "$*" | grep -q "assignees"; then
      case "$issue_num" in
        42) echo "otherdev" ;;
        43) echo "" ;;
        44) echo "testuser" ;;
        *) echo "" ;;
      esac
    fi
    ;;
  "issue edit")
    echo "edited"
    ;;
  "api user")
    echo "testuser"
    ;;
esac
MOCK
chmod +x "$mock_dir/gh"

# Mock gh that fails (not authenticated)
cat > "$mock_dir/gh-fail" << 'MOCK'
#!/usr/bin/env bash
echo "not logged in" >&2
exit 1
MOCK
chmod +x "$mock_dir/gh-fail"

# ── Create mock bd ───────────────────────────────────────────────────────
cat > "$mock_dir/bd" << 'MOCK'
#!/usr/bin/env bash
case "$1" in
  show)
    case "$2" in
      forge-assigned) echo "forge-assigned  Assigned Issue [github_issue:42]" ;;
      forge-unassigned) echo "forge-unassigned  Unassigned Issue [github_issue:43]" ;;
      forge-mine) echo "forge-mine  My Issue [github_issue:44]" ;;
      forge-nogithub) echo "forge-nogithub  No GitHub Issue" ;;
      *) echo "unknown issue" ;;
    esac ;;
  update) echo "Updated" ;;
  comments) echo "Comment added" ;;
esac
MOCK
chmod +x "$mock_dir/bd"

export GH_CMD="$mock_dir/gh"
export BD_CMD="$mock_dir/bd"

# Source the library under test
source "$SCRIPT_DIR/lib/claim.sh"

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

# ── Test 1: Pre-claim on unassigned issue → returns 0 ───────────────────
echo "── Test 1: Pre-claim on unassigned issue ──"
unset _GITHUB_USER_CACHE
mkdir -p "$TEST_TMP/.beads"
rc=0
pre_claim_check "forge-unassigned" 2>/dev/null || rc=$?
assert_exit "unassigned issue returns 0" 0 "$rc"

# ── Test 2: Pre-claim on issue assigned to someone else → returns 1 ─────
echo ""
echo "── Test 2: Pre-claim on issue assigned to someone else ──"
unset _GITHUB_USER_CACHE
rc=0
output="$(pre_claim_check "forge-assigned" 2>&1)" || rc=$?
assert_exit "assigned to other returns 1" 1 "$rc"
assert_contains "output mentions claimed" "claimed by" "$output"
assert_contains "output mentions PROMPT prefix" "FORGE_AGENT_7f3a:PROMPT:" "$output"

# ── Test 3: Pre-claim on issue assigned to current user → returns 0 ─────
echo ""
echo "── Test 3: Pre-claim on issue assigned to current user ──"
unset _GITHUB_USER_CACHE
rc=0
pre_claim_check "forge-mine" 2>/dev/null || rc=$?
assert_exit "assigned to self returns 0" 0 "$rc"

# ── Test 4: --force overrides pre-claim check, logs override ────────────
echo ""
echo "── Test 4: --force overrides pre-claim check ──"
unset _GITHUB_USER_CACHE
mkdir -p "$TEST_TMP/.beads"
rc=0
output="$(forge_team_claim "forge-assigned" "--force" 2>&1)" || rc=$?
assert_exit "force claim succeeds" 0 "$rc"
assert_contains "confirmation output" "claimed" "$output"

# ── Test 5: Claim with lock succeeds → bd update --claim AND gh issue edit both called ──
echo ""
echo "── Test 5: Claim with lock succeeds ──"
unset _GITHUB_USER_CACHE
mkdir -p "$TEST_TMP/.beads"
# Use the unassigned issue so pre-claim passes
rc=0
output="$(forge_team_claim "forge-unassigned" 2>&1)" || rc=$?
assert_exit "claim succeeds" 0 "$rc"
assert_contains "confirmation output" "claimed" "$output"

# ── Test 6: Missing GitHub issue number → error ─────────────────────────
echo ""
echo "── Test 6: Missing GitHub issue number ──"
unset _GITHUB_USER_CACHE
rc=0
output="$(pre_claim_check "forge-nogithub" 2>&1)" || rc=$?
assert_exit "missing issue number returns 1" 1 "$rc"
assert_contains "error about missing issue" "github_issue" "$output"

# ── Test 7: gh not authenticated → error ─────────────────────────────────
echo ""
echo "── Test 7: gh not authenticated ──"
unset _GITHUB_USER_CACHE
export GH_CMD="$mock_dir/gh-fail"
rc=0
output="$(pre_claim_check "forge-unassigned" 2>&1)" || rc=$?
assert_exit "unauthenticated returns 1" 1 "$rc"
# Restore working mock
export GH_CMD="$mock_dir/gh"

# ── Results ──────────────────────────────────────────────────────────────
echo ""
echo "Results: $PASS passed, $FAIL failed"
[[ $FAIL -eq 0 ]] && exit 0 || exit 1
