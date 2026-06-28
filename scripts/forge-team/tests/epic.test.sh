#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# ── Setup temp dir for test isolation ────────────────────────────────────
TEST_TMP="$(mktemp -d)"
trap 'rm -rf "$TEST_TMP"' EXIT

# ── Create mock forge ────────────────────────────────────────────────────
# Only handles `forge issue children <id> --json`, emitting the kernel
# issue-command-contract envelope ({schema_version,command,data:{epic,children,
# rollup,count},next_commands}). An unknown id mirrors the kernel not-found path:
# error on stderr, empty stdout, non-zero exit.
mock_dir="$(mktemp -d)"

cat > "$mock_dir/forge" << 'MOCK'
#!/usr/bin/env bash
if [[ "$1" == "issue" && "$2" == "children" ]]; then
  id="$3"
  case "$id" in
    forge-epic1)
      cat << 'JSON'
{"schema_version":"forge.issue.v1","command":"issue.children","data":{"epic":{"id":"forge-epic1","title":"Test Epic","type":"epic","status":"in_progress"},"children":[{"id":"forge-child1","title":"Child 1","status":"done","assignee":"devone","blocked":false,"blocked_by":[],"dependencies":[],"dependents":[]},{"id":"forge-child2","title":"Child 2","status":"in_progress","assignee":"devtwo","blocked":false,"blocked_by":[],"dependencies":[],"dependents":[]},{"id":"forge-child3","title":"Child 3","status":"open","assignee":"devone","blocked":false,"blocked_by":[],"dependencies":[],"dependents":[]}],"rollup":{"total":3,"done":1,"in_progress":1,"open":1,"review":0,"cancelled":0,"blocked":0,"percentage":33,"by_status":{"open":1,"in_progress":1,"review":0,"done":1,"cancelled":0}},"count":3},"next_commands":[]}
JSON
      ;;
    forge-empty)
      cat << 'JSON'
{"schema_version":"forge.issue.v1","command":"issue.children","data":{"epic":{"id":"forge-empty","title":"Empty Epic","type":"epic","status":"open"},"children":[],"rollup":{"total":0,"done":0,"in_progress":0,"open":0,"review":0,"cancelled":0,"blocked":0,"percentage":0,"by_status":{"open":0,"in_progress":0,"review":0,"done":0,"cancelled":0}},"count":0},"next_commands":[]}
JSON
      ;;
    forge-blocked)
      cat << 'JSON'
{"schema_version":"forge.issue.v1","command":"issue.children","data":{"epic":{"id":"forge-blocked","title":"Blocked Epic","type":"epic","status":"in_progress"},"children":[{"id":"forge-bchild1","title":"Bchild 1","status":"done","assignee":"devone","blocked":false,"blocked_by":[],"dependencies":[],"dependents":["forge-bchild2"]},{"id":"forge-bchild2","title":"Bchild 2","status":"in_progress","assignee":"devtwo","blocked":true,"blocked_by":["forge-bchild1"],"dependencies":["forge-bchild1"],"dependents":[]},{"id":"forge-bchild3","title":"Bchild 3","status":"open","assignee":"devone","blocked":false,"blocked_by":[],"dependencies":[],"dependents":[]}],"rollup":{"total":3,"done":1,"in_progress":1,"open":1,"review":0,"cancelled":0,"blocked":1,"percentage":33,"by_status":{"open":1,"in_progress":1,"review":0,"done":1,"cancelled":0}},"count":3},"next_commands":[]}
JSON
      ;;
    *)
      echo "Issue $id not found" >&2
      exit 1
      ;;
  esac
  exit 0
fi
exit 1
MOCK
chmod +x "$mock_dir/forge"

export FORGE_CMD="$mock_dir/forge"

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
assert_contains "shows done child marker" "✓ forge-child1" "$output"
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
# Validate it parses as JSON and carries the expected fields/values.
assert_eq "json total is 3" "3" "$(printf '%s' "$output_json" | jq -r '.total')"
assert_eq "json done is 1" "1" "$(printf '%s' "$output_json" | jq -r '.done')"
assert_eq "json percentage is 33" "33" "$(printf '%s' "$output_json" | jq -r '.percentage')"
assert_eq "json has 3 children" "3" "$(printf '%s' "$output_json" | jq -r '.children | length')"
assert_eq "json by_developer devone total 2" "2" "$(printf '%s' "$output_json" | jq -r '.by_developer.devone.total')"
assert_eq "json by_developer devone done 1" "1" "$(printf '%s' "$output_json" | jq -r '.by_developer.devone.done')"
assert_eq "json epic_id" "forge-epic1" "$(printf '%s' "$output_json" | jq -r '.epic_id')"

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
assert_contains "blocked-by id mentioned" "forge-bchild1" "$output_blocked"

# ── Test 8: Unknown epic id → not-found error ────────────────────────────
echo ""
echo "── Test 8: Unknown epic id ──"
rc=0
output_unknown="$(cmd_epic "forge-nope" 2>&1)" || rc=$?
assert_exit "unknown id returns 1" 1 "$rc"
assert_contains "error about fetch" "Could not fetch" "$output_unknown"

# ── Results ──────────────────────────────────────────────────────────────
echo ""
echo "Results: $PASS passed, $FAIL failed"
[[ $FAIL -eq 0 ]] && exit 0 || exit 1
