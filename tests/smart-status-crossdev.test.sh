#!/usr/bin/env bash
# tests/smart-status-crossdev.test.sh — Tests for cross-developer visibility in smart-status.sh
#
# Usage: bash tests/smart-status-crossdev.test.sh
# Exit 0 = all pass, exit 1 = any fail.

set -euo pipefail

# ── Test harness ──────────────────────────────────────────────────────────

PASS=0
FAIL=0
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SUT="$REPO_ROOT/scripts/smart-status.sh"

TEST_TMP=""

setup() {
  TEST_TMP="$(mktemp -d)"
  mkdir -p "$TEST_TMP/.beads"
  mkdir -p "$TEST_TMP/mock-bin"

  # Create a mock bd command that returns minimal issues JSON
  cat > "$TEST_TMP/mock-bin/bd" <<'MOCKEOF'
#!/usr/bin/env bash
case "$1" in
  list)
    # Return a single open issue so smart-status does not bail early
    echo '[{"id":"forge-local","title":"local issue","status":"open","type":"feature","priority":"P2","updated_at":"2026-03-22T00:00:00Z"}]'
    ;;
  children)
    echo '[]'
    ;;
  *)
    echo '[]'
    ;;
esac
MOCKEOF
  chmod +x "$TEST_TMP/mock-bin/bd"

  # Create a mock git command
  cat > "$TEST_TMP/mock-bin/git" <<'MOCKEOF'
#!/usr/bin/env bash
case "$1" in
  rev-parse)
    # Support --verify master for BASE_BRANCH detection
    if [[ "${2:-}" == "--verify" ]] && [[ "${3:-}" == "master" ]]; then
      echo "abc123"
      exit 0
    fi
    exit 1
    ;;
  worktree)
    # Return empty — no worktrees (sessions)
    echo ""
    ;;
  --version)
    echo "git version 2.45.0"
    ;;
  config)
    # For get_session_identity
    if [[ "${2:-}" == "user.email" ]]; then
      echo "localdev@myhost"
    fi
    ;;
  *)
    echo ""
    ;;
esac
MOCKEOF
  chmod +x "$TEST_TMP/mock-bin/git"

  export FILE_INDEX_ROOT="$TEST_TMP"
  export SMART_STATUS_IDENTITY="localdev@myhost"
}

teardown() {
  [[ -n "$TEST_TMP" ]] && rm -rf "$TEST_TMP"
  unset FILE_INDEX_ROOT
  unset SMART_STATUS_IDENTITY
}

assert_eq() {
  local label="$1" expected="$2" actual="$3"
  if [[ "$expected" == "$actual" ]]; then
    PASS=$((PASS + 1))
    echo "  PASS: $label"
  else
    FAIL=$((FAIL + 1))
    echo "  FAIL: $label"
    echo "    expected: $expected"
    echo "    actual:   $actual"
  fi
}

assert_contains() {
  local label="$1" needle="$2" haystack="$3"
  if printf '%s' "$haystack" | grep -qF "$needle"; then
    PASS=$((PASS + 1))
    echo "  PASS: $label"
  else
    FAIL=$((FAIL + 1))
    echo "  FAIL: $label"
    echo "    expected to contain: $needle"
    echo "    actual: $haystack"
  fi
}

assert_not_contains() {
  local label="$1" needle="$2" haystack="$3"
  if ! printf '%s' "$haystack" | grep -qF "$needle"; then
    PASS=$((PASS + 1))
    echo "  PASS: $label"
  else
    FAIL=$((FAIL + 1))
    echo "  FAIL: $label"
    echo "    expected NOT to contain: $needle"
    echo "    actual: $haystack"
  fi
}

# Helper: populate file index with entries for OTHER developers
populate_other_dev_entries() {
  local jsonl_file="$TEST_TMP/.beads/file-index.jsonl"

  # dev-b working on forge-xyz, touching src/lib/ and scripts/
  local ts_recent
  ts_recent="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  printf '%s\n' "$(jq -n -c \
    --arg ts "$ts_recent" \
    '{issue_id:"forge-xyz", developer:"dev-b@laptop-2", files:["src/lib/helpers.ts","scripts/build.sh"], modules:["src/lib/","scripts/"], updated_at:$ts, tombstone:false}')" >> "$jsonl_file"

  # dev-c working on forge-abc, but stale (3 days ago)
  local ts_stale
  ts_stale="$(date -u -d '3 days ago' +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -v-3d +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || echo '2026-03-19T00:00:00Z')"
  printf '%s\n' "$(jq -n -c \
    --arg ts "$ts_stale" \
    '{issue_id:"forge-abc", developer:"dev-c@laptop-3", files:["docs/README.md"], modules:["docs/"], updated_at:$ts, tombstone:false}')" >> "$jsonl_file"
}

# Helper: populate file index with an entry for the LOCAL developer
populate_local_dev_entry() {
  local jsonl_file="$TEST_TMP/.beads/file-index.jsonl"

  local ts_recent
  ts_recent="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  # localdev@myhost is working on src/lib/ — overlaps with dev-b
  printf '%s\n' "$(jq -n -c \
    --arg ts "$ts_recent" \
    '{issue_id:"forge-local", developer:"localdev@myhost", files:["src/lib/status.ts"], modules:["src/lib/"], updated_at:$ts, tombstone:false}')" >> "$jsonl_file"
}

# ── Test: Team Activity section appears in text output when other devs exist ──

test_team_activity_section_appears() {
  echo "TEST: Team Activity section appears when other devs have file index entries"
  setup
  populate_other_dev_entries
  populate_local_dev_entry

  local output
  output="$(BD_CMD="$TEST_TMP/mock-bin/bd" GIT_CMD="$TEST_TMP/mock-bin/git" NO_COLOR=1 bash "$SUT" 2>/dev/null)" || true

  assert_contains "Team Activity header present" "Team Activity" "$output"
  assert_contains "dev-b shown" "dev-b@laptop-2" "$output"
  assert_contains "dev-c shown" "dev-c@laptop-3" "$output"

  teardown
}

# ── Test: Current developer is excluded from Team Activity ──

test_current_dev_excluded() {
  echo "TEST: Current developer is excluded from Team Activity section"
  setup
  populate_other_dev_entries
  populate_local_dev_entry

  local output
  output="$(BD_CMD="$TEST_TMP/mock-bin/bd" GIT_CMD="$TEST_TMP/mock-bin/git" NO_COLOR=1 bash "$SUT" 2>/dev/null)" || true

  # localdev@myhost should NOT appear in Team Activity
  # The Team Activity section content (between header and next section) should not contain localdev
  assert_not_contains "local dev excluded from Team Activity" "localdev@myhost" "$output"

  teardown
}

# ── Test: Overlap warning format is correct ──

test_overlap_warning_format() {
  echo "TEST: Overlap warning format shows module and correct annotation"
  setup
  populate_other_dev_entries
  populate_local_dev_entry

  local output
  output="$(BD_CMD="$TEST_TMP/mock-bin/bd" GIT_CMD="$TEST_TMP/mock-bin/git" NO_COLOR=1 bash "$SUT" 2>/dev/null)" || true

  # dev-b works on src/lib/ and localdev also works on src/lib/ — overlap expected
  assert_contains "overlap warning for src/lib/" "Overlap" "$output"
  assert_contains "overlap mentions src/lib/" "src/lib/" "$output"

  teardown
}

# ── Test: Staleness shown for old claims ──

test_staleness_shown() {
  echo "TEST: Stale annotation shown for entries older than 48 hours"
  setup
  populate_other_dev_entries
  populate_local_dev_entry

  local output
  output="$(BD_CMD="$TEST_TMP/mock-bin/bd" GIT_CMD="$TEST_TMP/mock-bin/git" NO_COLOR=1 bash "$SUT" 2>/dev/null)" || true

  # dev-c's forge-abc is 3 days old — should be flagged as stale
  assert_contains "stale annotation present" "stale" "$output"

  teardown
}

# ── Test: No Team Activity section when file index is empty ──

test_no_section_when_empty() {
  echo "TEST: No Team Activity section when file index is empty"
  setup
  # Don't populate any entries

  local output
  output="$(BD_CMD="$TEST_TMP/mock-bin/bd" GIT_CMD="$TEST_TMP/mock-bin/git" NO_COLOR=1 bash "$SUT" 2>/dev/null)" || true

  assert_not_contains "no Team Activity when empty" "Team Activity" "$output"

  teardown
}

# ── Test: No Team Activity when only local dev has entries ──

test_no_section_when_only_local_dev() {
  echo "TEST: No Team Activity section when only the local developer has entries"
  setup
  populate_local_dev_entry

  local output
  output="$(BD_CMD="$TEST_TMP/mock-bin/bd" GIT_CMD="$TEST_TMP/mock-bin/git" NO_COLOR=1 bash "$SUT" 2>/dev/null)" || true

  assert_not_contains "no Team Activity for solo dev" "Team Activity" "$output"

  teardown
}

# ── Test: JSON mode includes team_activity field ──

test_json_mode_includes_team_activity() {
  echo "TEST: JSON mode includes team_activity in output"
  setup
  populate_other_dev_entries
  populate_local_dev_entry

  local output
  output="$(BD_CMD="$TEST_TMP/mock-bin/bd" GIT_CMD="$TEST_TMP/mock-bin/git" bash "$SUT" --json 2>/dev/null)" || true

  # JSON output should have team_activity key
  local has_key
  has_key="$(printf '%s' "$output" | jq 'has("team_activity")' 2>/dev/null || echo 'false')"
  assert_eq "JSON has team_activity key" "true" "$has_key"

  # team_activity should be an array
  local ta_type
  ta_type="$(printf '%s' "$output" | jq '.team_activity | type' 2>/dev/null || echo 'null')"
  assert_eq "team_activity is array" '"array"' "$ta_type"

  # Should have 2 entries (dev-b and dev-c, not localdev)
  local ta_count
  ta_count="$(printf '%s' "$output" | jq '.team_activity | length' 2>/dev/null || echo '0')"
  assert_eq "team_activity has 2 entries" "2" "$ta_count"

  teardown
}

# ── Test: JSON mode empty team_activity when no other devs ──

test_json_mode_empty_when_no_other_devs() {
  echo "TEST: JSON mode has empty team_activity when no other devs"
  setup
  # Only local dev entry
  populate_local_dev_entry

  local output
  output="$(BD_CMD="$TEST_TMP/mock-bin/bd" GIT_CMD="$TEST_TMP/mock-bin/git" bash "$SUT" --json 2>/dev/null)" || true

  local ta_count
  ta_count="$(printf '%s' "$output" | jq '.team_activity | length' 2>/dev/null || echo '0')"
  assert_eq "team_activity empty for solo dev" "0" "$ta_count"

  teardown
}

# ── Test: "No overlaps with your work" shown when no module overlap ──

test_no_overlaps_message() {
  echo "TEST: 'No overlaps' shown when other dev works on different modules"
  setup
  populate_other_dev_entries
  populate_local_dev_entry

  local output
  output="$(BD_CMD="$TEST_TMP/mock-bin/bd" GIT_CMD="$TEST_TMP/mock-bin/git" NO_COLOR=1 bash "$SUT" 2>/dev/null)" || true

  # dev-c works on docs/ — localdev works on src/lib/ — no overlap
  assert_contains "no overlaps message" "No overlaps" "$output"

  teardown
}

# ── Run all tests ─────────────────────────────────────────────────────────

echo "=== smart-status-crossdev.sh test suite ==="
echo ""

test_team_activity_section_appears
test_current_dev_excluded
test_overlap_warning_format
test_staleness_shown
test_no_section_when_empty
test_no_section_when_only_local_dev
test_json_mode_includes_team_activity
test_json_mode_empty_when_no_other_devs
test_no_overlaps_message

echo ""
echo "=== Results: $PASS passed, $FAIL failed ==="

if [[ $FAIL -gt 0 ]]; then
  exit 1
fi
exit 0
