#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# ── Setup temp dir for test isolation ────────────────────────────────────
TEST_TMP="$(mktemp -d)"
trap 'rm -rf "$TEST_TMP"' EXIT

# ── Create mock gh (authenticated) ──────────────────────────────────────
mock_dir="$(mktemp -d)"

cat > "$mock_dir/gh" << 'MOCK'
#!/usr/bin/env bash
case "$*" in
  "auth status")
    echo "Logged in to github.com as devone"
    exit 0
    ;;
  "issue edit"*)
    # Accept any issue edit (sync_issue_status)
    exit 0
    ;;
esac
MOCK
chmod +x "$mock_dir/gh"

# ── Create mock gh (not authenticated) ──────────────────────────────────
cat > "$mock_dir/gh-noauth" << 'MOCK'
#!/usr/bin/env bash
case "$*" in
  "auth status")
    echo "You are not logged in" >&2
    exit 1
    ;;
esac
MOCK
chmod +x "$mock_dir/gh-noauth"

# ── Create mock bd (with in_progress issues having github_issue state) ──
cat > "$mock_dir/bd" << 'MOCK'
#!/usr/bin/env bash
case "$1 $2" in
  "list --status=in_progress")
    echo "◐ forge-aaa · Feature A"
    echo "◐ forge-bbb · Feature B"
    ;;
  "show forge-aaa")
    echo "◐ forge-aaa · Feature A [● P2 · IN_PROGRESS]"
    echo "Owner: devone"
    echo "Updated: 2026-03-27T10:00:00Z"
    echo ""
    echo "STATE"
    echo "  github_issue:42"
    ;;
  "show forge-bbb")
    echo "◐ forge-bbb · Feature B [● P2 · IN_PROGRESS]"
    echo "Owner: devtwo"
    echo "Updated: 2026-03-27T09:00:00Z"
    echo ""
    echo "STATE"
    echo "  github_issue:55"
    ;;
esac
MOCK
chmod +x "$mock_dir/bd"

# ── Create mock bd (no in_progress issues) ──────────────────────────────
cat > "$mock_dir/bd-empty" << 'MOCK'
#!/usr/bin/env bash
case "$1 $2" in
  "list --status=in_progress")
    echo ""
    ;;
esac
MOCK
chmod +x "$mock_dir/bd-empty"

# ── Create mock bd (issue without github_issue state) ───────────────────
cat > "$mock_dir/bd-no-gh" << 'MOCK'
#!/usr/bin/env bash
case "$1 $2" in
  "list --status=in_progress")
    echo "◐ forge-xxx · Feature X"
    ;;
  "show forge-xxx")
    echo "◐ forge-xxx · Feature X [● P2 · IN_PROGRESS]"
    echo "Owner: devone"
    echo "Updated: 2026-03-27T10:00:00Z"
    ;;
esac
MOCK
chmod +x "$mock_dir/bd-no-gh"

# ── Create .beads/config.yaml for auto-sync tests ──────────────────────
mkdir -p "$TEST_TMP/.beads"
cat > "$TEST_TMP/.beads/config.yaml" << 'YAML'
team:
  auto-sync: true
YAML

export GH_CMD="$mock_dir/gh"
export BD_CMD="$mock_dir/bd"
export BEADS_ROOT="$TEST_TMP"

# Source the library under test
source "$SCRIPT_DIR/lib/hooks.sh"

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

# ── Test 1: forge_team_sync with mock gh + bd → syncs in_progress issues ──
echo "── Test 1: forge_team_sync syncs in_progress issues ──"
export GH_CMD="$mock_dir/gh"
export BD_CMD="$mock_dir/bd"
rc=0
output="$(forge_team_sync 2>&1)" || rc=$?
assert_exit "exits 0" 0 "$rc"
assert_contains "reports synced issues" "Synced 2 issues" "$output"

# ── Test 2: forge_team_sync with gh not authenticated → error, exit 1 ──
echo ""
echo "── Test 2: forge_team_sync with gh not authenticated → error, exit 1 ──"
export GH_CMD="$mock_dir/gh-noauth"
export BD_CMD="$mock_dir/bd"
rc=0
output="$(forge_team_sync 2>&1)" || rc=$?
assert_exit "exits 1" 1 "$rc"
assert_contains "error message" "FORGE_AGENT_7f3a:ERROR:" "$output"

# ── Test 3: forge_team_sync with auto-sync: false → skip, exit 0 ────────
echo ""
echo "── Test 3: forge_team_sync with auto-sync: false → skip, exit 0 ──"
export GH_CMD="$mock_dir/gh"
export BD_CMD="$mock_dir/bd"
cat > "$TEST_TMP/.beads/config.yaml" << 'YAML'
team:
  auto-sync: false
YAML
rc=0
output="$(forge_team_sync 2>&1)" || rc=$?
assert_exit "exits 0" 0 "$rc"
assert_not_contains "does not sync" "Synced" "$output"
# Restore config
cat > "$TEST_TMP/.beads/config.yaml" << 'YAML'
team:
  auto-sync: true
YAML

# ── Test 4: forge_team_sync with no in_progress issues → nothing to sync ──
echo ""
echo "── Test 4: forge_team_sync with no in_progress issues → nothing to sync ──"
export GH_CMD="$mock_dir/gh"
export BD_CMD="$mock_dir/bd-empty"
rc=0
output="$(forge_team_sync 2>&1)" || rc=$?
assert_exit "exits 0" 0 "$rc"
assert_contains "nothing to sync message" "Nothing to sync" "$output"

# ── Test 5: forge_team_sync --quiet → no output on success ──────────────
echo ""
echo "── Test 5: forge_team_sync --quiet → no output on success ──"
export GH_CMD="$mock_dir/gh"
export BD_CMD="$mock_dir/bd"
rc=0
output="$(forge_team_sync --quiet 2>&1)" || rc=$?
assert_exit "exits 0" 0 "$rc"
assert_eq "no output" "" "$output"

# ── Test 6: forge_team_sync_on_stage triggers correct status sync ────────
echo ""
echo "── Test 6: forge_team_sync_on_stage triggers correct status sync per stage ──"
export GH_CMD="$mock_dir/gh"
export BD_CMD="$mock_dir/bd"
# dev transition → in_progress
rc=0
output="$(forge_team_sync_on_stage forge-aaa plan dev 2>&1)" || rc=$?
assert_exit "dev transition exits 0" 0 "$rc"
# ship transition → in_progress (still active)
rc=0
output="$(forge_team_sync_on_stage forge-aaa dev ship 2>&1)" || rc=$?
assert_exit "ship transition exits 0" 0 "$rc"
# verify transition → skip (closed by /verify)
rc=0
output="$(forge_team_sync_on_stage forge-aaa ship verify 2>&1)" || rc=$?
assert_exit "verify transition exits 0" 0 "$rc"
assert_contains "verify skips sync" "skipped" "$output"

# ── Test 7: Sync failure doesn't block (non-fatal) ──────────────────────
echo ""
echo "── Test 7: Sync failure doesn't block (non-fatal warning) ──"
export GH_CMD="$mock_dir/gh"
export BD_CMD="$mock_dir/bd-no-gh"
rc=0
output="$(forge_team_sync 2>&1)" || rc=$?
# Should still exit 0 even with sync failures (non-blocking)
assert_exit "exits 0 despite sync failure" 0 "$rc"
assert_contains "warns about failure" "warn" "$output"

# ── Results ──────────────────────────────────────────────────────────────
echo ""
echo "Results: $PASS passed, $FAIL failed"
[[ $FAIL -eq 0 ]] && exit 0 || exit 1
