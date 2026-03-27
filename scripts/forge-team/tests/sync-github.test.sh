#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# ── Setup temp dir for test isolation ────────────────────────────────────
TEST_TMP="$(mktemp -d)"
trap 'rm -rf "$TEST_TMP" "$mock_dir"' EXIT

# ── Create mock dir and log file ─────────────────────────────────────────
mock_dir="$(mktemp -d /c/tmp/forge-sync-test.XXXXXX)"
log_file="$mock_dir/calls.log"
touch "$log_file"

# ── Mock gh ──────────────────────────────────────────────────────────────
cat > "$mock_dir/gh" << 'MOCK'
#!/usr/bin/env bash
echo "$*" >> "$LOG_FILE"
case "$1 $2" in
  "issue create") echo "https://github.com/test/repo/issues/42"; exit 0 ;;
  "issue edit") echo ""; exit 0 ;;
  "issue close") echo ""; exit 0 ;;
  "issue comment") echo ""; exit 0 ;;
  "api user") echo "testuser"; exit 0 ;;
esac
echo "unknown gh command: $*" >&2; exit 1
MOCK
chmod +x "$mock_dir/gh"

# ── Mock bd ──────────────────────────────────────────────────────────────
cat > "$mock_dir/bd" << 'MOCK'
#!/usr/bin/env bash
echo "$*" >> "$LOG_FILE"
case "$1" in
  show)
    echo "○ $2 · Test Issue [github_issue:42]"
    echo "Title: Test Issue"
    ;;
  set-state) echo "State set" ;;
esac
MOCK
chmod +x "$mock_dir/bd"

# ── Mock bd that returns NO github_issue ─────────────────────────────────
cat > "$mock_dir/bd-no-gh" << 'MOCK'
#!/usr/bin/env bash
echo "$*" >> "$LOG_FILE"
case "$1" in
  show)
    echo "○ $2 · Test Issue"
    echo "Title: Test Issue"
    ;;
  set-state) echo "State set" ;;
esac
MOCK
chmod +x "$mock_dir/bd-no-gh"

# Export env for mocks
export LOG_FILE="$log_file"
export GH_CMD="$mock_dir/gh"
export BD_CMD="$mock_dir/bd"
export TEAM_MAP_ROOT="$TEST_TMP"

# Source the library under test
source "$SCRIPT_DIR/lib/sync-github.sh"

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

# ── Test 1: sync_issue_create — creates GitHub issue, calls bd set-state ─
echo "── Test 1: sync_issue_create ──"
> "$log_file"  # clear log
rc=0
sync_issue_create "beads-001" || rc=$?
assert_exit "exit code 0" 0 "$rc"
# Check gh was called with issue create
log_contents="$(cat "$log_file")"
assert_contains "gh issue create called" "issue create" "$log_contents"
assert_contains "title includes Test Issue" "Test Issue" "$log_contents"
assert_contains "body includes beads-001" "beads-001" "$log_contents"
# Check bd set-state was called with github_issue=42
assert_contains "bd set-state called" "set-state" "$log_contents"
assert_contains "github_issue=42 set" "github_issue=42" "$log_contents"

# ── Test 2: sync_issue_claim — updates GitHub assignee ───────────────────
echo ""
echo "── Test 2: sync_issue_claim ──"
> "$log_file"
unset _GITHUB_USER_CACHE
rc=0
sync_issue_claim "beads-001" || rc=$?
assert_exit "exit code 0" 0 "$rc"
log_contents="$(cat "$log_file")"
assert_contains "gh issue edit called" "issue edit" "$log_contents"
assert_contains "add-assignee used" "--add-assignee" "$log_contents"
assert_contains "assignee is testuser" "testuser" "$log_contents"

# ── Test 3: sync_issue_status — removes old labels, adds new one ─────────
echo ""
echo "── Test 3: sync_issue_status ──"
> "$log_file"
rc=0
sync_issue_status "beads-001" "in_progress" || rc=$?
assert_exit "exit code 0" 0 "$rc"
log_contents="$(cat "$log_file")"
assert_contains "gh issue edit called" "issue edit" "$log_contents"
assert_contains "removes status/open" "--remove-label status/open" "$log_contents"
assert_contains "adds status/in-progress" "--add-label status/in-progress" "$log_contents"

# ── Test 4: sync_issue_close — closes GitHub issue ───────────────────────
echo ""
echo "── Test 4: sync_issue_close ──"
> "$log_file"
rc=0
sync_issue_close "beads-001" || rc=$?
assert_exit "exit code 0" 0 "$rc"
log_contents="$(cat "$log_file")"
assert_contains "gh issue close called" "issue close" "$log_contents"
assert_contains "closes issue 42" " 42" "$log_contents"

# ── Test 5: sync_issue_deps — adds comment on GitHub issue ───────────────
echo ""
echo "── Test 5: sync_issue_deps ──"
> "$log_file"
rc=0
sync_issue_deps "beads-001" "beads-002" || rc=$?
assert_exit "exit code 0" 0 "$rc"
log_contents="$(cat "$log_file")"
assert_contains "gh issue comment called" "issue comment" "$log_contents"
assert_contains "Blocked by referenced" "Blocked by #42" "$log_contents"

# ── Test 6: _get_github_issue_number — extracts number from bd show ──────
echo ""
echo "── Test 6: _get_github_issue_number ──"
result="$(_get_github_issue_number "beads-001")"
assert_eq "extracts issue number 42" "42" "$result"

# ── Test 7: Missing GitHub issue number → returns error ──────────────────
echo ""
echo "── Test 7: Missing GitHub issue number ──"
export BD_CMD="$mock_dir/bd-no-gh"
rc=0
result="$(_get_github_issue_number "beads-999" 2>/dev/null)" || rc=$?
assert_exit "returns error when no github_issue" 1 "$rc"
# Restore normal bd mock
export BD_CMD="$mock_dir/bd"

# ── Test 8: Injection in issue title → sanitized before gh call ──────────
echo ""
echo "── Test 8: Injection in title sanitized ──"
# Create a bd mock that returns injection-laden title
cat > "$mock_dir/bd-inject" << 'MOCK'
#!/usr/bin/env bash
echo "$*" >> "$LOG_FILE"
case "$1" in
  show)
    echo '○ beads-inject · Evil $(rm -rf /) Issue [github_issue:99]'
    echo 'Title: Evil $(rm -rf /) Issue'
    ;;
  set-state) echo "State set" ;;
esac
MOCK
chmod +x "$mock_dir/bd-inject"
export BD_CMD="$mock_dir/bd-inject"
> "$log_file"
rc=0
sync_issue_create "beads-inject" || rc=$?
assert_exit "exit code 0 with injection" 0 "$rc"
log_contents="$(cat "$log_file")"
# The $(...) pattern must NOT appear in the gh call
if [[ "$log_contents" == *'$(rm'* ]]; then
  FAIL=$((FAIL + 1)); echo "  FAIL: injection NOT sanitized — \$(rm found in gh call"
else
  PASS=$((PASS + 1)); echo "  PASS: injection sanitized — no \$(rm in gh call"
fi
# Restore normal bd mock
export BD_CMD="$mock_dir/bd"

# ── Results ──────────────────────────────────────────────────────────────
echo ""
echo "Results: $PASS passed, $FAIL failed"
[[ $FAIL -eq 0 ]] && exit 0 || exit 1
