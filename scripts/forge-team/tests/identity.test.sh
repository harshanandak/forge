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
if [[ "$1" == "api" && "$2" == "user" ]]; then
  echo "testuser"
  exit 0
fi
echo "unknown" >&2; exit 1
MOCK
chmod +x "$mock_dir/gh"

# Create a failing mock gh
cat > "$mock_dir/gh-fail" << 'MOCK'
#!/usr/bin/env bash
echo "not logged in" >&2
exit 1
MOCK
chmod +x "$mock_dir/gh-fail"

# Source the library under test
source "$SCRIPT_DIR/lib/identity.sh"

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
    FAIL=$((FAIL + 1)); echo "  FAIL: $label (expected to contain '$expected')"
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

# ── Test 1: get_github_user with mock gh returning "testuser" ────────────
echo "── Test 1: get_github_user with mock gh ──"
unset _GITHUB_USER_CACHE
export GH_CMD="$mock_dir/gh"
result="$(get_github_user)"
rc=$?
assert_eq "returns testuser" "testuser" "$result"
assert_exit "exit code 0" 0 "$rc"

# ── Test 2: get_github_user with mock gh failing ────────────────────────
echo ""
echo "── Test 2: get_github_user with failing gh ──"
unset _GITHUB_USER_CACHE
export GH_CMD="$mock_dir/gh-fail"
result="$(get_github_user 2>/dev/null)" || true
rc=0
get_github_user >/dev/null 2>/dev/null || rc=$?
assert_exit "returns exit 1 on failure" 1 "$rc"

# ── Test 3: team_map_add creates JSONL entry ────────────────────────────
echo ""
echo "── Test 3: team_map_add creates parseable JSONL ──"
export GH_CMD="$mock_dir/gh"
unset _GITHUB_USER_CACHE
team_map_add "testuser" "Test User"
mapfile="$TEAM_MAP_ROOT/.beads/team-map.jsonl"
# Entry should be parseable JSON
last_line="$(tail -1 "$mapfile")"
parsed="$(echo "$last_line" | jq -r '.github')"
assert_eq "github field is testuser" "testuser" "$parsed"
display="$(echo "$last_line" | jq -r '.display_name')"
assert_eq "display_name is Test User" "Test User" "$display"
is_bot_val="$(echo "$last_line" | jq -r '.is_bot')"
assert_eq "is_bot is false" "false" "$is_bot_val"
updated="$(echo "$last_line" | jq -r '.updated_at')"
assert_contains "updated_at has timestamp" "20" "$updated"

# ── Test 4: team_map_read with LWW resolution ──────────────────────────
echo ""
echo "── Test 4: team_map_read with LWW resolution ──"
# Add a second entry for same user with different display name
sleep 1  # ensure different timestamp
team_map_add "testuser" "Updated User"
# Add another user
team_map_add "otheruser" "Other"
result="$(team_map_read)"
# Should have 2 unique users, with testuser having "Updated User"
count="$(echo "$result" | jq 'length')"
assert_eq "2 unique users" "2" "$count"
testuser_display="$(echo "$result" | jq -r '.[] | select(.github=="testuser") | .display_name')"
assert_eq "LWW: last entry wins" "Updated User" "$testuser_display"

# ── Test 5: team_map_get "testuser" ─────────────────────────────────────
echo ""
echo "── Test 5: team_map_get testuser ──"
result="$(team_map_get "testuser")"
gh_val="$(echo "$result" | jq -r '.github')"
assert_eq "returns correct github" "testuser" "$gh_val"

# ── Test 6: team_map_get "nonexistent" ──────────────────────────────────
echo ""
echo "── Test 6: team_map_get nonexistent ──"
result="$(team_map_get "nonexistent")"
assert_eq "returns null" "null" "$result"

# ── Test 7: is_bot "dependabot[bot]" ────────────────────────────────────
echo ""
echo "── Test 7: is_bot dependabot[bot] ──"
is_bot "dependabot[bot]"
rc=$?
assert_exit "bot detected" 0 "$rc"

# ── Test 8: is_bot "harshanandak" ───────────────────────────────────────
echo ""
echo "── Test 8: is_bot harshanandak ──"
rc=0
is_bot "harshanandak" || rc=$?
assert_exit "not a bot" 1 "$rc"

# ── Test 9: auto_detect_identity with mock gh ───────────────────────────
echo ""
echo "── Test 9: auto_detect_identity ──"
# Clean state
rm -rf "$TEAM_MAP_ROOT/.beads"
unset _GITHUB_USER_CACHE
export GH_CMD="$mock_dir/gh"
auto_detect_identity
rc=$?
assert_exit "silent success" 0 "$rc"
# Verify entry was added
result="$(team_map_get "testuser")"
gh_val="$(echo "$result" | jq -r '.github')"
assert_eq "entry created in JSONL" "testuser" "$gh_val"

# ── Test 10: Invalid username with special chars ────────────────────────
echo ""
echo "── Test 10: Invalid username rejected ──"
rc=0
team_map_add "bad user!" "Bad" 2>/dev/null || rc=$?
assert_exit "rejects invalid username" 1 "$rc"
rc=0
team_map_add "-startdash" "Bad" 2>/dev/null || rc=$?
assert_exit "rejects leading hyphen" 1 "$rc"
rc=0
team_map_add "has spaces" "Bad" 2>/dev/null || rc=$?
assert_exit "rejects spaces" 1 "$rc"

# ── Results ──────────────────────────────────────────────────────────────
echo ""
echo "Results: $PASS passed, $FAIL failed"
[[ $FAIL -eq 0 ]] && exit 0 || exit 1
