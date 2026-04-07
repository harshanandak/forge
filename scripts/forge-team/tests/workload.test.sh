#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# ── Setup temp dir for test isolation ────────────────────────────────────
TEST_TMP="$(mktemp -d)"
trap 'rm -rf "$TEST_TMP"' EXIT

# Override TEAM_MAP_ROOT so tests don't touch real .beads/
export TEAM_MAP_ROOT="$TEST_TMP"

# Fix "now" so stale detection is deterministic
# forge-bbb updated 2026-03-25T10:00:00Z → 50h ago at this fixed time
export WORKLOAD_NOW="2026-03-27T12:00:00Z"

# ── Create mock gh ───────────────────────────────────────────────────────
mock_dir="$(mktemp -d)"

cat > "$mock_dir/gh" << 'MOCK'
#!/usr/bin/env bash
case "$1 $2" in
  "api user")
    echo "devone"
    ;;
esac
MOCK
chmod +x "$mock_dir/gh"

# ── Create mock bd ───────────────────────────────────────────────────────
cat > "$mock_dir/bd" << 'MOCK'
#!/usr/bin/env bash
case "$1 $2" in
  "list --status=open,in_progress")
    echo "◐ forge-aaa · Feature A"
    echo "○ forge-bbb · Feature B"
    echo "◐ forge-ccc · Feature C"
    echo "◐ forge-m1n8.6 · Sub-feature X (dotted ID)"
    ;;
  "show forge-aaa")
    echo "◐ forge-aaa · Feature A [● P2 · IN_PROGRESS]"
    echo "Owner: devone"
    echo "Updated: 2026-03-27T10:00:00Z"
    ;;
  "show forge-bbb")
    echo "○ forge-bbb · Feature B [● P2 · OPEN]"
    echo "Owner: devtwo"
    echo "Updated: 2026-03-25T10:00:00Z"
    ;;
  "show forge-ccc")
    echo "◐ forge-ccc · Feature C [● P1 · IN_PROGRESS]"
    echo "Owner: devone"
    echo "Updated: 2026-03-27T09:00:00Z"
    echo ""
    echo "DEPENDS ON"
    echo "  → forge-aaa: Feature A"
    ;;
  "show forge-m1n8.6")
    # Dotted sub-ID — bd show must receive the full ID including .6
    echo "◐ forge-m1n8.6 · Sub-feature X [● P2 · IN_PROGRESS]"
    echo "Owner: devthree"
    echo "Updated: 2026-03-27T08:00:00Z"
    ;;
  "show forge-m1n8")
    # Parent epic — if a buggy parser truncates forge-m1n8.6 to forge-m1n8,
    # the workload would get this WRONG owner and trigger the guard below.
    echo "◐ forge-m1n8 · PARENT EPIC (WRONG — dotted ID was truncated)"
    echo "Owner: WRONG_OWNER_DO_NOT_USE"
    echo "Updated: 2026-03-20T10:00:00Z"
    ;;
esac
MOCK
chmod +x "$mock_dir/bd"

# ── Create mock bd with no issues ────────────────────────────────────────
cat > "$mock_dir/bd-empty" << 'MOCK'
#!/usr/bin/env bash
case "$1 $2" in
  "list --status=open,in_progress")
    echo ""
    ;;
esac
MOCK
chmod +x "$mock_dir/bd-empty"

export GH_CMD="$mock_dir/gh"
export BD_CMD="$mock_dir/bd"

# Source the library under test
source "$SCRIPT_DIR/lib/workload.sh"

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

assert_not_contains() {
  local label="$1" unexpected="$2" actual="$3"
  if [[ "$actual" != *"$unexpected"* ]]; then
    PASS=$((PASS + 1)); echo "  PASS: $label"
  else
    FAIL=$((FAIL + 1)); echo "  FAIL: $label (expected NOT to contain '$unexpected', got '$actual')"
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

# ── Test 1: All developers shown with grouped issues ─────────────────────
echo "── Test 1: All developers shown with grouped issues ──"
unset _GITHUB_USER_CACHE
rc=0
output="$(cmd_workload 2>/dev/null)" || rc=$?
assert_exit "exits 0" 0 "$rc"
assert_contains "shows devone header" "Developer: devone" "$output"
assert_contains "shows devtwo header" "Developer: devtwo" "$output"
assert_contains "shows forge-aaa" "forge-aaa" "$output"
assert_contains "shows forge-bbb" "forge-bbb" "$output"
assert_contains "shows forge-ccc" "forge-ccc" "$output"
# Dotted ID regression (forge-hpev): the full forge-m1n8.6 must be extracted,
# not truncated to forge-m1n8. devthree owns the sub-issue, not WRONG_OWNER.
assert_contains "shows devthree (dotted ID owner)" "Developer: devthree" "$output"
assert_contains "shows dotted ID forge-m1n8.6 in full" "forge-m1n8.6" "$output"
assert_not_contains "does NOT attribute to WRONG_OWNER (parent epic)" "WRONG_OWNER" "$output"

# ── Test 2: --developer=devone filters correctly ─────────────────────────
echo ""
echo "── Test 2: --developer=devone filters correctly ──"
unset _GITHUB_USER_CACHE
rc=0
output="$(cmd_workload --developer=devone 2>/dev/null)" || rc=$?
assert_exit "exits 0" 0 "$rc"
assert_contains "shows devone" "Developer: devone" "$output"
assert_not_contains "excludes devtwo" "Developer: devtwo" "$output"
assert_contains "shows forge-aaa" "forge-aaa" "$output"
assert_contains "shows forge-ccc" "forge-ccc" "$output"
assert_not_contains "excludes forge-bbb" "forge-bbb" "$output"

# ── Test 3: --me uses get_github_user() to filter ────────────────────────
echo ""
echo "── Test 3: --me uses get_github_user() to filter ──"
unset _GITHUB_USER_CACHE
rc=0
output="$(cmd_workload --me 2>/dev/null)" || rc=$?
assert_exit "exits 0" 0 "$rc"
assert_contains "shows devone (current user)" "Developer: devone" "$output"
assert_not_contains "excludes devtwo" "Developer: devtwo" "$output"

# ── Test 4: No issues → "No active work" ─────────────────────────────────
echo ""
echo "── Test 4: No issues → No active work ──"
unset _GITHUB_USER_CACHE
export BD_CMD="$mock_dir/bd-empty"
rc=0
output="$(cmd_workload 2>/dev/null)" || rc=$?
assert_exit "exits 0" 0 "$rc"
assert_contains "shows no active work message" "No active work" "$output"
export BD_CMD="$mock_dir/bd"

# ── Test 5: Stale assignment flagged (>48h) ──────────────────────────────
echo ""
echo "── Test 5: Stale assignment flagged (>48h) ──"
unset _GITHUB_USER_CACHE
rc=0
output="$(cmd_workload 2>/dev/null)" || rc=$?
assert_exit "exits 0" 0 "$rc"
# forge-bbb was updated 2026-03-25T10:00:00Z, which is >48h ago from "now"
assert_contains "stale flag on forge-bbb" "stale:" "$output"

# ── Test 6: --format=json returns valid JSON ─────────────────────────────
echo ""
echo "── Test 6: --format=json returns valid JSON ──"
unset _GITHUB_USER_CACHE
rc=0
output="$(cmd_workload --format=json 2>/dev/null)" || rc=$?
assert_exit "exits 0" 0 "$rc"
# Validate it's parseable JSON
if echo "$output" | jq . >/dev/null 2>&1; then
  PASS=$((PASS + 1)); echo "  PASS: output is valid JSON"
else
  FAIL=$((FAIL + 1)); echo "  FAIL: output is not valid JSON: $output"
fi
# Check JSON has developer keys
if echo "$output" | jq -e '.devone' >/dev/null 2>&1; then
  PASS=$((PASS + 1)); echo "  PASS: JSON contains devone key"
else
  FAIL=$((FAIL + 1)); echo "  FAIL: JSON missing devone key"
fi
if echo "$output" | jq -e '.devtwo' >/dev/null 2>&1; then
  PASS=$((PASS + 1)); echo "  PASS: JSON contains devtwo key"
else
  FAIL=$((FAIL + 1)); echo "  FAIL: JSON missing devtwo key"
fi

# ── Test 7: Blocked issue flagged ─────────────────────────────────────────
echo ""
echo "── Test 7: Blocked issue flagged ──"
unset _GITHUB_USER_CACHE
rc=0
output="$(cmd_workload 2>/dev/null)" || rc=$?
assert_contains "blocked flag on forge-ccc" "blocked by forge-aaa" "$output"

# ── Results ──────────────────────────────────────────────────────────────
echo ""
echo "Results: $PASS passed, $FAIL failed"
[[ $FAIL -eq 0 ]] && exit 0 || exit 1
