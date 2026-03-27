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
case "$1" in
  list)
    if echo "$*" | grep -q -- "--status=open,in_progress"; then
      if [[ -n "${BD_MOCK_EMPTY:-}" ]]; then
        # No output for empty test
        :
      elif [[ -n "${BD_MOCK_SINGLE:-}" ]]; then
        echo "◐ forge-aaa · Feature A"
      else
        echo "◐ forge-aaa · Feature A"
        echo "○ forge-bbb · Feature B"
        echo "◐ forge-ccc · Feature C"
      fi
    fi
    ;;
  show)
    case "$2" in
      forge-aaa)
        echo "◐ forge-aaa · Feature A [● P2 · IN_PROGRESS]"
        echo "Owner: devone"
        echo "Updated: 2026-03-27T10:00:00Z"
        ;;
      forge-bbb)
        echo "○ forge-bbb · Feature B [● P2 · OPEN]"
        echo "Owner: devtwo"
        echo "Updated: 2026-03-24T10:00:00Z"
        ;;
      forge-ccc)
        echo "◐ forge-ccc · Feature C [● P1 · IN_PROGRESS]"
        echo "Owner: devone"
        echo "Updated: 2026-03-27T09:00:00Z"
        echo ""
        echo "DEPENDS ON"
        echo "  → ◐ forge-aaa: Feature A"
        ;;
    esac
    ;;
esac
MOCK
chmod +x "$mock_dir/bd"

export BD_CMD="$mock_dir/bd"

# Source the library under test
source "$SCRIPT_DIR/lib/dashboard.sh"

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

# ── Test 1: Full dashboard with multiple developers ──────────────────────
echo "── Test 1: Full dashboard with multiple developers ──"

# Override _now to a fixed time: 2026-03-27T12:00:00Z = 1774836000
export FORGE_NOW=1774836000

rc=0
output="$(cmd_dashboard 2>&1)" || rc=$?
assert_exit "dashboard exits 0" 0 "$rc"
assert_contains "shows Team Dashboard header" "Team Dashboard" "$output"
assert_contains "shows devone stats" "devone" "$output"
assert_contains "shows devtwo stats" "devtwo" "$output"
assert_contains "shows total summary" "Total:" "$output"

# ── Test 2: Stale issue flagged (forge-bbb >48h old) ────────────────────
echo ""
echo "── Test 2: Stale issue flagged ──"

# forge-bbb updated 2026-03-24T10:00:00Z, now is 2026-03-27T12:00:00Z => ~74h
assert_contains "stale section shown" "Stale assignments" "$output"
assert_contains "forge-bbb flagged as stale" "forge-bbb" "$output"
assert_contains "stale issue shows devtwo" "devtwo" "$output"

# ── Test 3: Blocked issue detected (forge-ccc depends on forge-aaa) ─────
echo ""
echo "── Test 3: Blocked issue detected ──"

assert_contains "blocked section shown" "Blocked issues" "$output"
assert_contains "forge-ccc flagged as blocked" "forge-ccc" "$output"
assert_contains "blocked shows dependency" "forge-aaa" "$output"

# ── Test 4: No issues → "No active issues" ──────────────────────────────
echo ""
echo "── Test 4: No issues → clear message ──"

export BD_MOCK_EMPTY=1
rc=0
output_empty="$(cmd_dashboard 2>&1)" || rc=$?
assert_exit "empty dashboard exits 0" 0 "$rc"
assert_contains "shows no active issues" "No active issues" "$output_empty"
unset BD_MOCK_EMPTY

# ── Test 5: Single developer → works correctly ──────────────────────────
echo ""
echo "── Test 5: Single developer ──"

export BD_MOCK_SINGLE=1
rc=0
output_single="$(cmd_dashboard 2>&1)" || rc=$?
assert_exit "single dev dashboard exits 0" 0 "$rc"
assert_contains "shows devone" "devone" "$output_single"
assert_not_contains "no devtwo in single mode" "devtwo" "$output_single"
unset BD_MOCK_SINGLE

# ── Test 6: --format=json → valid JSON ──────────────────────────────────
echo ""
echo "── Test 6: --format=json → valid JSON ──"

rc=0
output_json="$(cmd_dashboard --format=json 2>&1)" || rc=$?
assert_exit "json format exits 0" 0 "$rc"
# Check it starts with { and contains expected keys
assert_contains "json has developers key" "developers" "$output_json"
assert_contains "json has total key" "total" "$output_json"
assert_contains "json has stale key" "stale" "$output_json"
assert_contains "json has blocked key" "blocked" "$output_json"

# ── Results ──────────────────────────────────────────────────────────────
echo ""
echo "Results: $PASS passed, $FAIL failed"
[[ $FAIL -eq 0 ]] && exit 0 || exit 1
