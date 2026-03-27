#!/usr/bin/env bash
# tests/pr-coordinator-labels.test.sh — Tests for pr-coordinator.sh auto-label subcommand (Task 11)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
COORD="$PROJECT_DIR/scripts/pr-coordinator.sh"

PASS=0
FAIL=0
ERRORS=""

assert_exit() {
  local label="$1" expected="$2" actual="$3"
  if [[ "$actual" -eq "$expected" ]]; then
    PASS=$((PASS + 1))
    echo "  PASS: $label"
  else
    FAIL=$((FAIL + 1))
    ERRORS="${ERRORS}\n  FAIL: $label (expected exit $expected, got $actual)"
    echo "  FAIL: $label (expected exit $expected, got $actual)"
  fi
}

assert_contains() {
  local label="$1" haystack="$2" needle="$3"
  if printf '%s' "$haystack" | grep -qF "$needle"; then
    PASS=$((PASS + 1))
    echo "  PASS: $label"
  else
    FAIL=$((FAIL + 1))
    ERRORS="${ERRORS}\n  FAIL: $label (expected to contain '$needle', got: $haystack)"
    echo "  FAIL: $label (expected to contain '$needle')"
  fi
}

assert_not_contains() {
  local label="$1" haystack="$2" needle="$3"
  if ! printf '%s' "$haystack" | grep -qF "$needle"; then
    PASS=$((PASS + 1))
    echo "  PASS: $label"
  else
    FAIL=$((FAIL + 1))
    ERRORS="${ERRORS}\n  FAIL: $label (expected NOT to contain '$needle')"
    echo "  FAIL: $label (expected NOT to contain '$needle')"
  fi
}

assert_log_contains() {
  local label="$1" log_file="$2" needle="$3"
  if [[ -f "$log_file" ]] && grep -qF -- "$needle" "$log_file"; then
    PASS=$((PASS + 1))
    echo "  PASS: $label"
  else
    FAIL=$((FAIL + 1))
    local content=""
    [[ -f "$log_file" ]] && content="$(cat "$log_file")"
    ERRORS="${ERRORS}\n  FAIL: $label (expected log to contain '$needle', log: $content)"
    echo "  FAIL: $label (expected log to contain '$needle')"
  fi
}

assert_log_not_contains() {
  local label="$1" log_file="$2" needle="$3"
  if [[ ! -f "$log_file" ]] || ! grep -qF -- "$needle" "$log_file"; then
    PASS=$((PASS + 1))
    echo "  PASS: $label"
  else
    FAIL=$((FAIL + 1))
    ERRORS="${ERRORS}\n  FAIL: $label (expected log NOT to contain '$needle')"
    echo "  FAIL: $label (expected log NOT to contain '$needle')"
  fi
}

# ── Setup mock directory ──────────────────────────────────────────────

mock_dir="$(mktemp -d)"
trap 'rm -rf "$mock_dir"' EXIT

gh_log="$mock_dir/gh-calls.log"

# ── Mock bd: issue with deps + blocks + PR ────────────────────────────

cat > "$mock_dir/bd-with-deps" << 'MOCK'
#!/usr/bin/env bash
case "$1" in
  show)
    cat << 'SHOW'
○ forge-with-deps · Issue with deps [pr_number:42 pr_branch:feat/test]

DEPENDS ON
  → forge-other: Other issue ● P2

BLOCKS
  ← forge-blocked: Blocked issue ● P2
SHOW
    ;;
  *) echo "Unknown: $*" >&2; exit 1 ;;
esac
MOCK
chmod +x "$mock_dir/bd-with-deps"

# ── Mock bd: issue with no deps, no blocks, has PR ───────────────────

cat > "$mock_dir/bd-no-deps" << 'MOCK'
#!/usr/bin/env bash
case "$1" in
  show)
    cat << 'SHOW'
○ forge-no-deps · Issue without deps [pr_number:43]
SHOW
    ;;
  *) echo "Unknown: $*" >&2; exit 1 ;;
esac
MOCK
chmod +x "$mock_dir/bd-no-deps"

# ── Mock bd: issue with no PR ────────────────────────────────────────

cat > "$mock_dir/bd-no-pr" << 'MOCK'
#!/usr/bin/env bash
case "$1" in
  show)
    cat << 'SHOW'
○ forge-no-pr · Issue without PR
SHOW
    ;;
  *) echo "Unknown: $*" >&2; exit 1 ;;
esac
MOCK
chmod +x "$mock_dir/bd-no-pr"

# ── Mock bd: fails on show ───────────────────────────────────────────

cat > "$mock_dir/bd-fail" << 'MOCK'
#!/usr/bin/env bash
echo "bd error: database locked" >&2
exit 1
MOCK
chmod +x "$mock_dir/bd-fail"

# ── Mock bd: issue with only deps (no blocks) ────────────────────────

cat > "$mock_dir/bd-deps-only" << 'MOCK'
#!/usr/bin/env bash
case "$1" in
  show)
    cat << 'SHOW'
○ forge-deps-only · Issue with deps only [pr_number:44 pr_branch:feat/deps-only]

DEPENDS ON
  → forge-other: Other issue ● P2
SHOW
    ;;
  *) echo "Unknown: $*" >&2; exit 1 ;;
esac
MOCK
chmod +x "$mock_dir/bd-deps-only"

# ── Mock bd: issue with only blocks (no deps) ────────────────────────

cat > "$mock_dir/bd-blocks-only" << 'MOCK'
#!/usr/bin/env bash
case "$1" in
  show)
    cat << 'SHOW'
○ forge-blocks-only · Issue that blocks others [pr_number:45 pr_branch:feat/blocks-only]

BLOCKS
  ← forge-blocked: Blocked issue ● P2
SHOW
    ;;
  *) echo "Unknown: $*" >&2; exit 1 ;;
esac
MOCK
chmod +x "$mock_dir/bd-blocks-only"

# ── Mock gh: logs all calls ──────────────────────────────────────────

cat > "$mock_dir/gh" << MOCK
#!/usr/bin/env bash
echo "\$*" >> "$gh_log"
MOCK
chmod +x "$mock_dir/gh"

echo "=== pr-coordinator auto-label tests ==="
echo ""

# ── Test 1: Issue with dependencies → forge/has-deps added ───────────
echo "Test 1: Issue with dependencies gets forge/has-deps label"
> "$gh_log"  # clear log
output="$(BD_CMD="$mock_dir/bd-with-deps" GH_CMD="$mock_dir/gh" bash "$COORD" auto-label forge-with-deps 2>&1)" && rc=$? || rc=$?
assert_exit "auto-label with deps exits 0" 0 "$rc"
assert_log_contains "gh called with --add-label forge/has-deps" "$gh_log" "--add-label forge/has-deps"

# ── Test 2: Issue that blocks others → forge/blocks-others added ─────
echo ""
echo "Test 2: Issue that blocks others gets forge/blocks-others label"
assert_log_contains "gh called with --add-label forge/blocks-others" "$gh_log" "--add-label forge/blocks-others"

# ── Test 3: Issue with no deps, no blocks → labels removed ──────────
echo ""
echo "Test 3: Issue with no deps, no blocks → labels removed"
> "$gh_log"  # clear log
output="$(BD_CMD="$mock_dir/bd-no-deps" GH_CMD="$mock_dir/gh" bash "$COORD" auto-label forge-no-deps 2>&1)" && rc=$? || rc=$?
assert_exit "auto-label no-deps exits 0" 0 "$rc"
assert_log_contains "gh called with --remove-label forge/has-deps" "$gh_log" "--remove-label forge/has-deps"
assert_log_contains "gh called with --remove-label forge/blocks-others" "$gh_log" "--remove-label forge/blocks-others"

# ── Test 4: No PR found → exit 0 with skip message ──────────────────
echo ""
echo "Test 4: No PR found → exit 0 with skip message"
> "$gh_log"  # clear log
output="$(BD_CMD="$mock_dir/bd-no-pr" GH_CMD="$mock_dir/gh" bash "$COORD" auto-label forge-no-pr 2>&1)" && rc=$? || rc=$?
assert_exit "auto-label no-pr exits 0" 0 "$rc"
assert_contains "auto-label no-pr prints skip" "$output" "No PR found"
assert_contains "auto-label no-pr prints skip labels" "$output" "skipping labels"

# ── Test 5: Invalid issue-id (bd show fails) → exit 1 ───────────────
echo ""
echo "Test 5: bd show failure → exit 1"
> "$gh_log"  # clear log
output="$(BD_CMD="$mock_dir/bd-fail" GH_CMD="$mock_dir/gh" bash "$COORD" auto-label forge-bad 2>&1)" && rc=$? || rc=$?
assert_exit "auto-label bd-fail exits 1" 1 "$rc"
assert_contains "auto-label bd-fail reports error" "$output" "Error: failed to show issue"

# ── Test 6: Label removal when condition no longer applies ───────────
echo ""
echo "Test 6: Label removal tracked (no deps → remove-label called)"
> "$gh_log"  # clear log
output="$(BD_CMD="$mock_dir/bd-no-deps" GH_CMD="$mock_dir/gh" bash "$COORD" auto-label forge-no-deps 2>&1)" && rc=$? || rc=$?
assert_exit "auto-label removal exits 0" 0 "$rc"
assert_log_contains "remove forge/has-deps tracked" "$gh_log" "--remove-label forge/has-deps"
assert_log_contains "remove forge/blocks-others tracked" "$gh_log" "--remove-label forge/blocks-others"
assert_log_not_contains "no --add-label forge/has-deps" "$gh_log" "--add-label forge/has-deps"
assert_log_not_contains "no --add-label forge/blocks-others" "$gh_log" "--add-label forge/blocks-others"

# ── Test 7: Missing args → exit 1 with usage ────────────────────────
echo ""
echo "Test 7: Missing args → exit 1 with usage"
> "$gh_log"  # clear log
output="$(BD_CMD="$mock_dir/bd-with-deps" GH_CMD="$mock_dir/gh" bash "$COORD" auto-label 2>&1)" && rc=$? || rc=$?
assert_exit "auto-label no-args exits 1" 1 "$rc"
assert_contains "auto-label no-args shows usage" "$output" "Usage:"

# ── Test 8: Deps-only issue → has-deps added, blocks-others removed ──
echo ""
echo "Test 8: Deps-only issue → has-deps added, blocks-others removed"
> "$gh_log"  # clear log
output="$(BD_CMD="$mock_dir/bd-deps-only" GH_CMD="$mock_dir/gh" bash "$COORD" auto-label forge-deps-only 2>&1)" && rc=$? || rc=$?
assert_exit "auto-label deps-only exits 0" 0 "$rc"
assert_log_contains "deps-only: add has-deps" "$gh_log" "--add-label forge/has-deps"
assert_log_contains "deps-only: remove blocks-others" "$gh_log" "--remove-label forge/blocks-others"
assert_log_not_contains "deps-only: no add blocks-others" "$gh_log" "--add-label forge/blocks-others"

# ── Test 9: Blocks-only issue → blocks-others added, has-deps removed ─
echo ""
echo "Test 9: Blocks-only issue → blocks-others added, has-deps removed"
> "$gh_log"  # clear log
output="$(BD_CMD="$mock_dir/bd-blocks-only" GH_CMD="$mock_dir/gh" bash "$COORD" auto-label forge-blocks-only 2>&1)" && rc=$? || rc=$?
assert_exit "auto-label blocks-only exits 0" 0 "$rc"
assert_log_contains "blocks-only: add blocks-others" "$gh_log" "--add-label forge/blocks-others"
assert_log_contains "blocks-only: remove has-deps" "$gh_log" "--remove-label forge/has-deps"
assert_log_not_contains "blocks-only: no add has-deps" "$gh_log" "--add-label forge/has-deps"

# ── Test 10: Output reports labels added ─────────────────────────────
echo ""
echo "Test 10: Output reports labels added"
> "$gh_log"  # clear log
output="$(BD_CMD="$mock_dir/bd-with-deps" GH_CMD="$mock_dir/gh" bash "$COORD" auto-label forge-with-deps 2>&1)" && rc=$? || rc=$?
assert_contains "output mentions labels added" "$output" "Labels added:"
assert_contains "output mentions forge/has-deps" "$output" "forge/has-deps"
assert_contains "output mentions forge/blocks-others" "$output" "forge/blocks-others"

# ── Summary ──────────────────────────────────────────────────────────
echo ""
echo "=== Results: $PASS passed, $FAIL failed ==="
if [[ $FAIL -gt 0 ]]; then
  printf '%b\n' "$ERRORS"
  exit 1
fi
exit 0
