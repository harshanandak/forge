#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# ── Setup temp dir for test isolation ────────────────────────────────────
TEST_TMP="$(mktemp -d)"
trap 'rm -rf "$TEST_TMP"' EXIT

# Override TEAM_MAP_ROOT so tests don't touch real .beads/
export TEAM_MAP_ROOT="$TEST_TMP"

# ── Create mock directories ────────────────────────────────────────────
mock_dir="$(mktemp -d)"

# ── Mock gh (authenticated, returns user "testuser") ───────────────────
cat > "$mock_dir/gh" << 'MOCK'
#!/usr/bin/env bash
case "$1" in
  auth)
    if [[ "${2:-}" == "status" ]]; then
      echo "github.com"
      echo "  ✓ Logged in to github.com account harshanandak"
      exit 0
    fi
    ;;
  api)
    if [[ "${2:-}" == "user" ]]; then
      echo "testuser"
      exit 0
    fi
    ;;
  issue)
    if [[ "${2:-}" == "list" ]]; then
      # Return JSON array of open issues
      if [[ -n "${GH_MOCK_ISSUES:-}" ]]; then
        echo "$GH_MOCK_ISSUES"
      else
        echo "[]"
      fi
      exit 0
    fi
    ;;
esac
echo "unknown gh call: $*" >&2
exit 1
MOCK
chmod +x "$mock_dir/gh"

# ── Mock gh (not authenticated) ────────────────────────────────────────
cat > "$mock_dir/gh-noauth" << 'MOCK'
#!/usr/bin/env bash
case "$1" in
  auth)
    if [[ "${2:-}" == "status" ]]; then
      echo "You are not logged into any GitHub hosts." >&2
      exit 1
    fi
    ;;
  api)
    echo "not logged in" >&2
    exit 1
    ;;
esac
exit 1
MOCK
chmod +x "$mock_dir/gh-noauth"

# ── Mock bd ────────────────────────────────────────────────────────────
cat > "$mock_dir/bd" << 'MOCK'
#!/usr/bin/env bash
case "$1" in
  list)
    if [[ -n "${BD_MOCK_OUTPUT:-}" ]]; then
      echo "$BD_MOCK_OUTPUT"
    fi
    exit 0
    ;;
  show)
    case "${2:-}" in
      forge-aaa)
        echo "◐ forge-aaa · Feature A [● P2 · IN_PROGRESS]"
        echo "Owner: devone"
        if [[ -z "${BD_MOCK_NO_GITHUB_AAA:-}" ]]; then
          echo "State: github_issue:10"
        fi
        ;;
      forge-bbb)
        echo "○ forge-bbb · Feature B [● P2 · OPEN]"
        echo "Owner: devtwo"
        if [[ -z "${BD_MOCK_NO_GITHUB_BBB:-}" ]]; then
          echo "State: github_issue:20"
        fi
        ;;
      forge-ccc)
        echo "◐ forge-ccc · Feature C [● P1 · IN_PROGRESS]"
        echo "Owner: devone"
        # forge-ccc never has github_issue (for orphan tests)
        ;;
    esac
    exit 0
    ;;
esac
exit 0
MOCK
chmod +x "$mock_dir/bd"

export GH_CMD="$mock_dir/gh"
export BD_CMD="$mock_dir/bd"

# Source the library under test
source "$SCRIPT_DIR/lib/agent-prompt.sh"
source "$SCRIPT_DIR/lib/identity.sh"
source "$SCRIPT_DIR/lib/verify.sh"

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
    FAIL=$((FAIL + 1)); echo "  FAIL: $label (expected NOT to contain '$unexpected')"
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

# ── Test 1: All clean → exit 0, all checks pass ─────────────────────────
echo "── Test 1: All clean → exit 0 ──"

# Setup: identity exists in team map
unset _GITHUB_USER_CACHE
export GH_CMD="$mock_dir/gh"
export BD_CMD="$mock_dir/bd"
team_map_add "testuser" "Test User"

# No beads issues, no github issues
export BD_MOCK_OUTPUT=""
export GH_MOCK_ISSUES="[]"

# Create empty mapping file
mkdir -p "$TEST_TMP/.github"
echo '{}' > "$TEST_TMP/.github/beads-mapping.json"

rc=0
output="$(cmd_verify 2>&1)" || rc=$?
assert_exit "all clean exits 0" 0 "$rc"
assert_contains "shows github cli check" "GitHub CLI" "$output"
assert_contains "shows identity check" "Identity" "$output"

# ── Test 2: gh not authenticated → exit 1, error message ────────────────
echo ""
echo "── Test 2: gh not authenticated → exit 1 ──"

unset _GITHUB_USER_CACHE
export GH_CMD="$mock_dir/gh-noauth"

rc=0
output="$(cmd_verify 2>&1)" || rc=$?
assert_exit "no auth exits 1" 1 "$rc"
assert_contains "error about auth" "not authenticated" "$output"
assert_contains "error has agent prefix" "FORGE_AGENT_7f3a:ERROR" "$output"

# ── Test 3: Orphan Beads issue (no github_issue state) → detected ───────
echo ""
echo "── Test 3: Orphan Beads issue detected ──"

unset _GITHUB_USER_CACHE
export GH_CMD="$mock_dir/gh"
export BD_MOCK_OUTPUT="◐ forge-ccc · Feature C"
export GH_MOCK_ISSUES="[]"

# forge-ccc has no github_issue state (see mock bd above)
rc=0
output="$(cmd_verify 2>&1)" || rc=$?
assert_exit "orphan beads exits 1" 1 "$rc"
assert_contains "orphan beads detected" "forge-ccc" "$output"
assert_contains "prompt for sync" "forge team sync-issue" "$output"

# ── Test 4: Orphan GitHub issue (not in mapping) → detected ─────────────
echo ""
echo "── Test 4: Orphan GitHub issue detected ──"

unset _GITHUB_USER_CACHE
export GH_CMD="$mock_dir/gh"
export BD_MOCK_OUTPUT=""
export GH_MOCK_ISSUES='[{"number":42,"title":"Some feature"},{"number":45,"title":"Another feature"}]'

# Mapping file has neither #42 nor #45
echo '{}' > "$TEST_TMP/.github/beads-mapping.json"

rc=0
output="$(cmd_verify 2>&1)" || rc=$?
assert_exit "orphan github exits 1" 1 "$rc"
assert_contains "orphan github #42 detected" "#42" "$output"
assert_contains "orphan github #45 detected" "#45" "$output"
assert_contains "prompt for import" "forge team import" "$output"

# ── Test 5: Assignee mismatch → info message ────────────────────────────
echo ""
echo "── Test 5: Assignee mismatch → info message ──"

unset _GITHUB_USER_CACHE
export GH_CMD="$mock_dir/gh"

# Setup: forge-aaa has github_issue:10, forge-bbb has github_issue:20
export BD_MOCK_OUTPUT="◐ forge-aaa · Feature A
○ forge-bbb · Feature B"

# Create mapping with both issues
cat > "$TEST_TMP/.github/beads-mapping.json" << 'EOF'
{
  "10": {"beads_id": "forge-aaa", "assignee": "devone"},
  "20": {"beads_id": "forge-bbb", "assignee": "devtwo"},
  "42": {"beads_id": "forge-ddd", "assignee": "devone"}
}
EOF

# Override gh to return mismatched assignees from github
cat > "$mock_dir/gh-mismatch" << 'MOCK'
#!/usr/bin/env bash
case "$1" in
  auth)
    if [[ "${2:-}" == "status" ]]; then
      echo "  ✓ Logged in to github.com account harshanandak"
      exit 0
    fi
    ;;
  api)
    if [[ "${2:-}" == "user" ]]; then
      echo "testuser"
      exit 0
    fi
    ;;
  issue)
    if [[ "${2:-}" == "list" ]]; then
      echo '[{"number":10,"title":"Feature A"},{"number":20,"title":"Feature B"},{"number":42,"title":"Feature D"}]'
      exit 0
    fi
    # view --json assignees
    if [[ "${2:-}" == "view" ]]; then
      case "${3:-}" in
        10)
          echo '{"assignees":[{"login":"devone"}]}'
          ;;
        20)
          echo '{"assignees":[{"login":"devthree"}]}'
          ;;
        42)
          echo '{"assignees":[{"login":"devone"}]}'
          ;;
      esac
      exit 0
    fi
    ;;
esac
echo "unknown gh call: $*" >&2
exit 1
MOCK
chmod +x "$mock_dir/gh-mismatch"
export GH_CMD="$mock_dir/gh-mismatch"

rc=0
output="$(cmd_verify 2>&1)" || rc=$?
assert_exit "assignee mismatch exits 1" 1 "$rc"
assert_contains "mismatch info message" "mismatch" "$output"
assert_contains "mismatch shows forge-bbb" "forge-bbb" "$output"
assert_contains "mismatch shows devtwo vs devthree" "devtwo" "$output"

# ── Test 6: No issues at all (no beads, no github) → exit 0 ─────────────
echo ""
echo "── Test 6: No issues at all → exit 0 ──"

unset _GITHUB_USER_CACHE
export GH_CMD="$mock_dir/gh"
export BD_MOCK_OUTPUT=""
export GH_MOCK_ISSUES="[]"
echo '{}' > "$TEST_TMP/.github/beads-mapping.json"

rc=0
output="$(cmd_verify 2>&1)" || rc=$?
assert_exit "no issues exits 0" 0 "$rc"

# ── Results ──────────────────────────────────────────────────────────────
echo ""
echo "Results: $PASS passed, $FAIL failed"
[[ $FAIL -eq 0 ]] && exit 0 || exit 1
