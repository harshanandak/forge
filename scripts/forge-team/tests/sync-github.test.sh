#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

TEST_TMP="$(mktemp -d)"
trap 'rm -rf "$TEST_TMP" "$mock_dir"' EXIT

mock_dir="$(mktemp -d)"
portable_bin="$(mktemp -d)"
log_file="$mock_dir/calls.log"
touch "$log_file"
REAL_GREP="$(command -v grep)"
ORIGINAL_PATH="$PATH"
export REAL_GREP

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
echo "unknown gh command: $*" >&2
exit 1
MOCK
chmod +x "$mock_dir/gh"

# Mock forge: `issue show --json` carries the github_issue:<n> association as a
# label; `issue update --label` records it. Args are logged for assertions.
cat > "$mock_dir/forge" << 'MOCK'
#!/usr/bin/env bash
echo "$*" >> "$LOG_FILE"
case "$1 $2" in
  "issue show")
    printf '{"data":{"issue":{"id":"beads-001","title":"Test Issue","labels":["github_issue:42"]}}}\n'
    ;;
  "issue update") echo "Updated" ;;
esac
MOCK
chmod +x "$mock_dir/forge"

cat > "$mock_dir/forge-no-gh" << 'MOCK'
#!/usr/bin/env bash
echo "$*" >> "$LOG_FILE"
case "$1 $2" in
  "issue show")
    printf '{"data":{"issue":{"id":"beads-999","title":"Test Issue","labels":[]}}}\n'
    ;;
  "issue update") echo "Updated" ;;
esac
MOCK
chmod +x "$mock_dir/forge-no-gh"

cat > "$portable_bin/grep" << 'MOCK'
#!/usr/bin/env bash
for arg in "$@"; do
  case "$arg" in
    -P|--perl-regexp|-*P*)
      echo "grep: PCRE support disabled for test" >&2
      exit 2
      ;;
  esac
done
exec "$REAL_GREP" "$@"
MOCK
chmod +x "$portable_bin/grep"

export LOG_FILE="$log_file"
export GH_CMD="$mock_dir/gh"
export FORGE_CMD="$mock_dir/forge"
export TEAM_MAP_ROOT="$TEST_TMP"
mapping_file="$TEAM_MAP_ROOT/.github/beads-mapping.json"

source "$SCRIPT_DIR/lib/sync-github.sh"

PASS=0
FAIL=0

assert_eq() {
  local label="$1" expected="$2" actual="$3"
  if [[ "$actual" == "$expected" ]]; then
    PASS=$((PASS + 1))
    echo "  PASS: $label"
  else
    FAIL=$((FAIL + 1))
    echo "  FAIL: $label (expected '$expected', got '$actual')"
  fi
}

assert_contains() {
  local label="$1" expected="$2" actual="$3"
  if [[ "$actual" == *"$expected"* ]]; then
    PASS=$((PASS + 1))
    echo "  PASS: $label"
  else
    FAIL=$((FAIL + 1))
    echo "  FAIL: $label (expected to contain '$expected', got '$actual')"
  fi
}

assert_not_contains() {
  local label="$1" unexpected="$2" actual="$3"
  if [[ "$actual" == *"$unexpected"* ]]; then
    FAIL=$((FAIL + 1))
    echo "  FAIL: $label (did not expect '$unexpected', got '$actual')"
  else
    PASS=$((PASS + 1))
    echo "  PASS: $label"
  fi
}

assert_exit() {
  local label="$1" expected="$2" actual="$3"
  if [[ "$actual" -eq "$expected" ]]; then
    PASS=$((PASS + 1))
    echo "  PASS: $label"
  else
    FAIL=$((FAIL + 1))
    echo "  FAIL: $label (expected exit $expected, got $actual)"
  fi
}

echo "== Test 1: sync_issue_create =="
> "$log_file"
rc=0
sync_issue_create "beads-001" || rc=$?
assert_exit "exit code 0" 0 "$rc"
log_contents="$(cat "$log_file")"
assert_contains "gh issue create called" "issue create" "$log_contents"
assert_contains "title includes Test Issue" "Test Issue" "$log_contents"
assert_contains "body includes beads-001" "beads-001" "$log_contents"
assert_contains "sync create writes github_issue label" "github_issue:42" "$log_contents"
assert_contains "sync create calls issue update for the label" "issue update" "$log_contents"
assert_contains "sync create persists mapping entry" '"42": "beads-001"' "$(cat "$mapping_file")"

echo
echo "== Test 2: sync_issue_claim =="
> "$log_file"
unset _GITHUB_USER_CACHE
rc=0
sync_issue_claim "beads-001" || rc=$?
assert_exit "exit code 0" 0 "$rc"
log_contents="$(cat "$log_file")"
assert_contains "canonical lookup uses --json" "--json" "$log_contents"
assert_contains "gh issue edit called" "issue edit" "$log_contents"
assert_contains "add-assignee used" "--add-assignee" "$log_contents"
assert_contains "assignee is testuser" "testuser" "$log_contents"

echo
echo "== Test 3: sync_issue_status =="
> "$log_file"
rc=0
sync_issue_status "beads-001" "in_progress" || rc=$?
assert_exit "exit code 0" 0 "$rc"
log_contents="$(cat "$log_file")"
assert_contains "canonical lookup uses --json" "--json" "$log_contents"
assert_contains "gh issue edit called" "issue edit" "$log_contents"
assert_contains "removes status/open" "--remove-label status/open" "$log_contents"
assert_contains "adds status/in-progress" "--add-label status/in-progress" "$log_contents"

echo
echo "== Test 4: sync_issue_close =="
> "$log_file"
rc=0
sync_issue_close "beads-001" || rc=$?
assert_exit "exit code 0" 0 "$rc"
log_contents="$(cat "$log_file")"
assert_contains "canonical lookup uses --json" "--json" "$log_contents"
assert_contains "gh issue close called" "issue close" "$log_contents"
assert_contains "closes issue 42" " 42" "$log_contents"

echo
echo "== Test 5: sync_issue_deps =="
> "$log_file"
rc=0
sync_issue_deps "beads-001" "beads-002" || rc=$?
assert_exit "exit code 0" 0 "$rc"
log_contents="$(cat "$log_file")"
assert_contains "canonical lookup uses --json" "--json" "$log_contents"
assert_contains "gh issue comment called" "issue comment" "$log_contents"
assert_contains "Blocked by referenced" "Blocked by #42" "$log_contents"

echo
echo "== Test 6: _get_github_issue_number =="
result="$(_get_github_issue_number "beads-001")"
assert_eq "extracts issue number 42" "42" "$result"
log_contents="$(cat "$log_file")"
assert_contains "_get_github_issue_number uses JSON" "--json" "$log_contents"

echo
echo "== Test 7: Mapping fallback when canonical GitHub number missing =="
mkdir -p "$(dirname "$mapping_file")"
cat > "$mapping_file" << 'JSON'
{
  "77": "beads-999"
}
JSON
export FORGE_CMD="$mock_dir/forge-no-gh"
result="$(_get_github_issue_number "beads-999")"
assert_eq "mapping fallback returns issue number 77" "77" "$result"
export FORGE_CMD="$mock_dir/forge"

echo
echo "== Test 8: Mapping fallback returns newest issue number =="
cat > "$mapping_file" << 'JSON'
{
  "77": "beads-999",
  "91": "beads-999",
  "88": "beads-other"
}
JSON
export FORGE_CMD="$mock_dir/forge-no-gh"
result="$(_get_github_issue_number "beads-999")"
assert_eq "mapping fallback returns newest matching issue number" "91" "$result"
export FORGE_CMD="$mock_dir/forge"

echo
echo "== Test 9: Missing canonical GitHub number =="
rm -f "$mapping_file"
export FORGE_CMD="$mock_dir/forge-no-gh"
rc=0
result="$(_get_github_issue_number "beads-999" 2>/dev/null)" || rc=$?
assert_exit "returns error when no canonical github number" 1 "$rc"
export FORGE_CMD="$mock_dir/forge"

echo
echo "== Test 10: github_issue label lookup =="
cat > "$mock_dir/forge-legacy" << 'MOCK'
#!/usr/bin/env bash
echo "$*" >> "$LOG_FILE"
case "$1 $2" in
  "issue show")
    printf '{"data":{"issue":{"id":"beads-legacy","title":"Legacy Issue","labels":["github_issue:43"]}}}\n'
    ;;
  "issue update") echo "Updated" ;;
esac
MOCK
chmod +x "$mock_dir/forge-legacy"
export FORGE_CMD="$mock_dir/forge-legacy"
rc=0
result="$(_get_github_issue_number "beads-legacy" 2>/dev/null)" || rc=$?
assert_exit "legacy github_issue exits successfully" 0 "$rc"
assert_eq "legacy github_issue returns number" "43" "$result"
export FORGE_CMD="$mock_dir/forge"

echo
echo "== Test 11: Injection in title sanitized =="
cat > "$mock_dir/forge-inject" << 'MOCK'
#!/usr/bin/env bash
echo "$*" >> "$LOG_FILE"
case "$1 $2" in
  "issue show")
    printf '{"data":{"issue":{"id":"beads-inject","title":"Evil $(rm -rf /) Issue","labels":["github_issue:99"]}}}\n'
    ;;
  "issue update") echo "Updated" ;;
esac
MOCK
chmod +x "$mock_dir/forge-inject"
export FORGE_CMD="$mock_dir/forge-inject"
> "$log_file"
rc=0
sync_issue_create "beads-inject" || rc=$?
assert_exit "exit code 0 with injection" 0 "$rc"
log_contents="$(cat "$log_file")"
if [[ "$log_contents" == *'$(rm'* ]]; then
  FAIL=$((FAIL + 1))
  echo "  FAIL: injection NOT sanitized - \$\(rm found in gh call"
else
  PASS=$((PASS + 1))
  echo "  PASS: injection sanitized - no \$\(rm in gh call"
fi
export FORGE_CMD="$mock_dir/forge"

echo
echo "== Test 11: sync_issue_create without grep -P =="
export PATH="$portable_bin:$ORIGINAL_PATH"
> "$log_file"
rc=0
sync_issue_create "beads-001" || rc=$?
assert_exit "sync_issue_create works when grep -P is unavailable" 0 "$rc"
log_contents="$(cat "$log_file")"
assert_contains "gh issue create called without PCRE grep" "issue create" "$log_contents"
export PATH="$ORIGINAL_PATH"

echo
echo "== Test 12: sync_issue_create reads title from issue show JSON =="
cat > "$mock_dir/forge-summary-only" << 'MOCK'
#!/usr/bin/env bash
echo "$*" >> "$LOG_FILE"
case "$1 $2" in
  "issue show")
    printf '{"data":{"issue":{"id":"beads-summary","title":"Summary Only Title","labels":["github_issue:77"]}}}\n'
    ;;
  "issue update") echo "Updated" ;;
esac
MOCK
chmod +x "$mock_dir/forge-summary-only"
export FORGE_CMD="$mock_dir/forge-summary-only"
> "$log_file"
rc=0
sync_issue_create "beads-summary" || rc=$?
assert_exit "sync_issue_create works with title from issue show JSON" 0 "$rc"
log_contents="$(cat "$log_file")"
assert_contains "summary-only title is passed to gh issue create" "Summary Only Title" "$log_contents"
export FORGE_CMD="$mock_dir/forge"

echo
echo "Results: $PASS passed, $FAIL failed"
[[ $FAIL -eq 0 ]] && exit 0 || exit 1
