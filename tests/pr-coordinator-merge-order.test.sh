#!/usr/bin/env bash
# Test pr-coordinator.sh merge-order subcommand
# Tests topological sort (Kahn's algorithm) for merge ordering

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PR_COORD="$SCRIPT_DIR/scripts/pr-coordinator.sh"
PASS=0
FAIL=0

assert_exit_code() {
  local label="$1" expected="$2" actual="$3"
  if [[ "$actual" -eq "$expected" ]]; then
    PASS=$((PASS + 1)); echo "  PASS: $label"
  else
    FAIL=$((FAIL + 1)); echo "  FAIL: $label (expected exit $expected, got $actual)"
  fi
}

assert_contains() {
  local label="$1" expected="$2" actual="$3"
  if [[ "$actual" == *"$expected"* ]]; then
    PASS=$((PASS + 1)); echo "  PASS: $label"
  else
    FAIL=$((FAIL + 1)); echo "  FAIL: $label (expected to contain '$expected', got: $actual)"
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

# ── Mock setup helpers ──────────────────────────────────────────────

create_mock_dir() {
  local tmpdir
  tmpdir="$(mktemp -d)"
  echo "$tmpdir"
}

# Linear chain: A depends on B, B depends on C
# Expected merge order: C, B, A (C first since it has no deps)
create_linear_chain_mock() {
  local mock_dir="$1"
  cat > "$mock_dir/bd" << 'MOCK'
#!/usr/bin/env bash
case "$1" in
  list)
    echo "forge-aaa · Issue A"
    echo "forge-bbb · Issue B"
    echo "forge-ccc · Issue C"
    ;;
  show)
    case "$2" in
      forge-aaa)
        printf 'DEPENDS ON\n  forge-bbb\n\n'
        ;;
      forge-bbb)
        printf 'DEPENDS ON\n  forge-ccc\n\n'
        ;;
      forge-ccc)
        echo "No dependencies"
        ;;
    esac
    ;;
  dep)
    case "$2" in
      cycles) echo "No cycles found" ;;
    esac
    ;;
esac
MOCK
  chmod +x "$mock_dir/bd"
}

# Two independent PRs (no dependencies between them)
create_independent_mock() {
  local mock_dir="$1"
  cat > "$mock_dir/bd" << 'MOCK'
#!/usr/bin/env bash
case "$1" in
  list)
    echo "forge-xxx · Feature X"
    echo "forge-yyy · Feature Y"
    ;;
  show)
    case "$2" in
      forge-xxx) echo "No dependencies" ;;
      forge-yyy) echo "No dependencies" ;;
    esac
    ;;
  dep)
    case "$2" in
      cycles) echo "No cycles found" ;;
    esac
    ;;
esac
MOCK
  chmod +x "$mock_dir/bd"
}

# Diamond: A depends on B and C; B depends on D; C depends on D
# Expected: D first, then B and C (either order), then A last
create_diamond_mock() {
  local mock_dir="$1"
  cat > "$mock_dir/bd" << 'MOCK'
#!/usr/bin/env bash
case "$1" in
  list)
    echo "forge-aaa · Issue A"
    echo "forge-bbb · Issue B"
    echo "forge-ccc · Issue C"
    echo "forge-ddd · Issue D"
    ;;
  show)
    case "$2" in
      forge-aaa)
        printf 'DEPENDS ON\n  forge-bbb\n  forge-ccc\n\n'
        ;;
      forge-bbb)
        printf 'DEPENDS ON\n  forge-ddd\n\n'
        ;;
      forge-ccc)
        printf 'DEPENDS ON\n  forge-ddd\n\n'
        ;;
      forge-ddd)
        echo "No dependencies"
        ;;
    esac
    ;;
  dep)
    case "$2" in
      cycles) echo "No cycles found" ;;
    esac
    ;;
esac
MOCK
  chmod +x "$mock_dir/bd"
}

# Cycle detected mock
create_cycle_mock() {
  local mock_dir="$1"
  cat > "$mock_dir/bd" << 'MOCK'
#!/usr/bin/env bash
case "$1" in
  dep)
    case "$2" in
      cycles) echo "Cycle detected: forge-aaa -> forge-bbb -> forge-aaa"; exit 1 ;;
    esac
    ;;
  list)
    echo "forge-aaa · Issue A"
    echo "forge-bbb · Issue B"
    ;;
esac
MOCK
  chmod +x "$mock_dir/bd"
}

# Single PR, no deps
create_single_mock() {
  local mock_dir="$1"
  cat > "$mock_dir/bd" << 'MOCK'
#!/usr/bin/env bash
case "$1" in
  list)
    echo "forge-xyz · Solo Issue"
    ;;
  show)
    case "$2" in
      forge-xyz) echo "No dependencies" ;;
    esac
    ;;
  dep)
    case "$2" in
      cycles) echo "No cycles found" ;;
    esac
    ;;
esac
MOCK
  chmod +x "$mock_dir/bd"
}

# No open PRs
create_empty_mock() {
  local mock_dir="$1"
  cat > "$mock_dir/bd" << 'MOCK'
#!/usr/bin/env bash
case "$1" in
  list) ;; # empty output
  dep)
    case "$2" in
      cycles) echo "No cycles found" ;;
    esac
    ;;
esac
MOCK
  chmod +x "$mock_dir/bd"
}

# ── Test 1: Linear chain A->B->C ────────────────────────────────────

echo "── Test 1: Linear chain A->B->C ──"

mock_dir="$(create_mock_dir)"
create_linear_chain_mock "$mock_dir"
output="$(BD_CMD="$mock_dir/bd" bash "$PR_COORD" merge-order 2>&1)"; rc=$?

assert_exit_code "linear chain exits 0" 0 "$rc"
assert_contains "linear chain shows merge order" "Recommended merge order" "$output"
assert_contains "linear chain has forge-ccc" "forge-ccc" "$output"
assert_contains "linear chain has forge-bbb" "forge-bbb" "$output"
assert_contains "linear chain has forge-aaa" "forge-aaa" "$output"

# Verify order: ccc before bbb before aaa
ccc_pos="$(echo "$output" | grep -n 'forge-ccc' | head -1 | cut -d: -f1)"
bbb_pos="$(echo "$output" | grep -n 'forge-bbb' | head -1 | cut -d: -f1)"
aaa_pos="$(echo "$output" | grep -n 'forge-aaa' | head -1 | cut -d: -f1)"
if [[ -n "$ccc_pos" && -n "$bbb_pos" && -n "$aaa_pos" ]] && \
   [[ "$ccc_pos" -lt "$bbb_pos" ]] && [[ "$bbb_pos" -lt "$aaa_pos" ]]; then
  PASS=$((PASS + 1)); echo "  PASS: linear chain order is C, B, A"
else
  FAIL=$((FAIL + 1)); echo "  FAIL: linear chain order should be C, B, A (got ccc=$ccc_pos bbb=$bbb_pos aaa=$aaa_pos)"
fi

rm -rf "$mock_dir"

# ── Test 2: Two independent PRs ─────────────────────────────────────

echo ""
echo "── Test 2: Two independent PRs ──"

mock_dir="$(create_mock_dir)"
create_independent_mock "$mock_dir"
output="$(BD_CMD="$mock_dir/bd" bash "$PR_COORD" merge-order 2>&1)"; rc=$?

assert_exit_code "independent exits 0" 0 "$rc"
assert_contains "independent shows any order" "Can merge in any order" "$output"
assert_contains "independent has forge-xxx" "forge-xxx" "$output"
assert_contains "independent has forge-yyy" "forge-yyy" "$output"

rm -rf "$mock_dir"

# ── Test 3: Diamond A->B,C; B->D; C->D ──────────────────────────────

echo ""
echo "── Test 3: Diamond dependency ──"

mock_dir="$(create_mock_dir)"
create_diamond_mock "$mock_dir"
output="$(BD_CMD="$mock_dir/bd" bash "$PR_COORD" merge-order 2>&1)"; rc=$?

assert_exit_code "diamond exits 0" 0 "$rc"
assert_contains "diamond shows merge order" "Recommended merge order" "$output"

# D must come before B, C, and A
ddd_pos="$(echo "$output" | grep -n 'forge-ddd' | head -1 | cut -d: -f1)"
bbb_pos="$(echo "$output" | grep -n 'forge-bbb' | head -1 | cut -d: -f1)"
ccc_pos="$(echo "$output" | grep -n 'forge-ccc' | head -1 | cut -d: -f1)"
aaa_pos="$(echo "$output" | grep -n 'forge-aaa' | head -1 | cut -d: -f1)"

if [[ -n "$ddd_pos" && -n "$aaa_pos" ]] && [[ "$ddd_pos" -lt "$aaa_pos" ]]; then
  PASS=$((PASS + 1)); echo "  PASS: diamond D before A"
else
  FAIL=$((FAIL + 1)); echo "  FAIL: diamond D should come before A"
fi

if [[ -n "$ddd_pos" && -n "$bbb_pos" ]] && [[ "$ddd_pos" -lt "$bbb_pos" ]]; then
  PASS=$((PASS + 1)); echo "  PASS: diamond D before B"
else
  FAIL=$((FAIL + 1)); echo "  FAIL: diamond D should come before B"
fi

if [[ -n "$ddd_pos" && -n "$ccc_pos" ]] && [[ "$ddd_pos" -lt "$ccc_pos" ]]; then
  PASS=$((PASS + 1)); echo "  PASS: diamond D before C"
else
  FAIL=$((FAIL + 1)); echo "  FAIL: diamond D should come before C"
fi

# A must be last
if [[ -n "$aaa_pos" && -n "$bbb_pos" && -n "$ccc_pos" ]] && \
   [[ "$aaa_pos" -gt "$bbb_pos" ]] && [[ "$aaa_pos" -gt "$ccc_pos" ]]; then
  PASS=$((PASS + 1)); echo "  PASS: diamond A is last"
else
  FAIL=$((FAIL + 1)); echo "  FAIL: diamond A should be last"
fi

rm -rf "$mock_dir"

# ── Test 4: Cycle detected ──────────────────────────────────────────

echo ""
echo "── Test 4: Cycle detected ──"

mock_dir="$(create_mock_dir)"
create_cycle_mock "$mock_dir"
output="$(BD_CMD="$mock_dir/bd" bash "$PR_COORD" merge-order 2>&1)"; rc=$?

assert_exit_code "cycle exits 1" 1 "$rc"
assert_contains "cycle shows error" "cycle detected" "$output"

rm -rf "$mock_dir"

# ── Test 5: Single PR, no deps ──────────────────────────────────────

echo ""
echo "── Test 5: Single PR, no deps ──"

mock_dir="$(create_mock_dir)"
create_single_mock "$mock_dir"
output="$(BD_CMD="$mock_dir/bd" bash "$PR_COORD" merge-order 2>&1)"; rc=$?

assert_exit_code "single PR exits 0" 0 "$rc"
assert_contains "single PR shows ready" "Ready to merge: forge-xyz" "$output"

rm -rf "$mock_dir"

# ── Test 6: No open PRs ─────────────────────────────────────────────

echo ""
echo "── Test 6: No open PRs ──"

mock_dir="$(create_mock_dir)"
create_empty_mock "$mock_dir"
output="$(BD_CMD="$mock_dir/bd" bash "$PR_COORD" merge-order 2>&1)"; rc=$?

assert_exit_code "no PRs exits 0" 0 "$rc"
assert_contains "no PRs shows nothing to merge" "Nothing to merge" "$output"

rm -rf "$mock_dir"

# ── Test 7: JSON format output ───────────────────────────────────────

echo ""
echo "── Test 7: JSON format ──"

mock_dir="$(create_mock_dir)"
create_linear_chain_mock "$mock_dir"
output="$(BD_CMD="$mock_dir/bd" bash "$PR_COORD" merge-order --format=json 2>&1)"; rc=$?

assert_exit_code "json format exits 0" 0 "$rc"
# Should be a JSON array
assert_contains "json starts with bracket" "[" "$output"
assert_contains "json has forge-ccc" "forge-ccc" "$output"
assert_contains "json has forge-bbb" "forge-bbb" "$output"
assert_contains "json has forge-aaa" "forge-aaa" "$output"

rm -rf "$mock_dir"

# ── Summary ──────────────────────────────────────────────────────────

echo ""
echo "Results: $PASS passed, $FAIL failed"
[[ $FAIL -eq 0 ]] && exit 0 || exit 1
