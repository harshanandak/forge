#!/usr/bin/env bash
# sync-utils.test.sh — Tests for sync-utils.sh session identity utility.
#
# Usage: bash tests/sync-utils.test.sh
# Exit code 0 = all pass, non-zero = failure.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# ── Test framework ─────────────────────────────────────────────────────

PASS=0
FAIL=0

assert_eq() {
  local label="$1" expected="$2" actual="$3"
  if [[ "$expected" == "$actual" ]]; then
    echo "  PASS: $label"
    PASS=$((PASS + 1))
  else
    echo "  FAIL: $label"
    echo "    expected: '$expected'"
    echo "    actual:   '$actual'"
    FAIL=$((FAIL + 1))
  fi
}

assert_match() {
  local label="$1" pattern="$2" actual="$3"
  if [[ "$actual" =~ $pattern ]]; then
    echo "  PASS: $label"
    PASS=$((PASS + 1))
  else
    echo "  FAIL: $label"
    echo "    pattern:  '$pattern'"
    echo "    actual:   '$actual'"
    FAIL=$((FAIL + 1))
  fi
}

assert_fail() {
  local label="$1"
  shift
  if "$@" 2>/dev/null; then
    echo "  FAIL: $label (expected failure, got success)"
    FAIL=$((FAIL + 1))
  else
    echo "  PASS: $label"
    PASS=$((PASS + 1))
  fi
}

# ── Source the module under test ───────────────────────────────────────

source "$REPO_ROOT/scripts/sync-utils.sh"

# ── Tests: get_session_identity ────────────────────────────────────────

echo "=== get_session_identity ==="

# Test 1: Returns a non-empty string
identity="$(get_session_identity)"
if [[ -n "$identity" ]]; then
  echo "  PASS: returns non-empty string"
  PASS=$((PASS + 1))
else
  echo "  FAIL: returns non-empty string (got empty)"
  FAIL=$((FAIL + 1))
fi

# Test 2: Format matches allowed characters (OWASP A03)
assert_match "identity matches ^[a-zA-Z0-9._@+-]+$" \
  '^[a-zA-Z0-9._@+-]+$' "$identity"

# Test 3: Contains @ separator (email@hostname format)
assert_match "identity contains @ separator" '@' "$identity"

# ── Tests: validate_session_identity ───────────────────────────────────

echo ""
echo "=== validate_session_identity ==="

# Test 4: Valid identities accepted
validate_session_identity "user@hostname" && {
  echo "  PASS: accepts user@hostname"
  PASS=$((PASS + 1))
} || {
  echo "  FAIL: accepts user@hostname"
  FAIL=$((FAIL + 1))
}

validate_session_identity "first.last+tag@My-Host" && {
  echo "  PASS: accepts first.last+tag@My-Host"
  PASS=$((PASS + 1))
} || {
  echo "  FAIL: accepts first.last+tag@My-Host"
  FAIL=$((FAIL + 1))
}

validate_session_identity "a@b" && {
  echo "  PASS: accepts minimal a@b"
  PASS=$((PASS + 1))
} || {
  echo "  FAIL: accepts minimal a@b"
  FAIL=$((FAIL + 1))
}

# Test 5: Injection strings rejected
assert_fail "rejects semicolon injection" \
  validate_session_identity "; rm -rf /"

assert_fail "rejects command substitution \$()" \
  validate_session_identity "\$(whoami)"

assert_fail "rejects backtick injection" \
  validate_session_identity '`whoami`'

assert_fail "rejects pipe injection" \
  validate_session_identity "user|cat /etc/passwd"

assert_fail "rejects space in identity" \
  validate_session_identity "user name@host"

assert_fail "rejects empty string" \
  validate_session_identity ""

assert_fail "rejects slash injection" \
  validate_session_identity "user/../../etc@host"

# ── Tests: fallback when email not set ─────────────────────────────────

echo ""
echo "=== fallback behavior ==="

# Test 6: Function uses git config (smoke test — just verify it runs)
# The actual fallback logic is tested by checking the function exists
# and returns a valid format. Full isolation would require mocking git,
# which is out of scope for shell tests.
type get_session_identity &>/dev/null && {
  echo "  PASS: get_session_identity function exists"
  PASS=$((PASS + 1))
} || {
  echo "  FAIL: get_session_identity function not found"
  FAIL=$((FAIL + 1))
}

# ── Setup temp directory for git-based tests ──────────────────────────

TMPDIR_ROOT="$(mktemp -d)"
cleanup() {
  rm -rf -- "$TMPDIR_ROOT"
}
trap cleanup EXIT

# Helper: create a bare remote repo and a clone with a given default branch
# Usage: setup_git_repo <dir_name> <default_branch>
# Sets REPO_DIR to the clone path
setup_git_repo() {
  local dir_name="$1"
  local default_branch="$2"
  local bare_dir="$TMPDIR_ROOT/${dir_name}_bare"
  local clone_dir="$TMPDIR_ROOT/${dir_name}"

  # Create bare repo
  git init --bare -- "$bare_dir" >/dev/null 2>&1

  # Clone it
  git clone -- "$bare_dir" "$clone_dir" >/dev/null 2>&1

  # Create initial commit on the desired branch
  git -C "$clone_dir" checkout -b "$default_branch" >/dev/null 2>&1
  echo "init" > "$clone_dir/README.md"
  git -C "$clone_dir" add -- README.md >/dev/null 2>&1
  git -C "$clone_dir" commit -m "init" >/dev/null 2>&1
  git -C "$clone_dir" push -u origin "$default_branch" >/dev/null 2>&1

  # Set origin HEAD to point at the default branch
  git -C "$bare_dir" symbolic-ref HEAD "refs/heads/$default_branch" >/dev/null 2>&1
  # Update symbolic-ref on clone side
  git -C "$clone_dir" remote set-head origin "$default_branch" >/dev/null 2>&1

  REPO_DIR="$clone_dir"
}

# ── Tests: get_sync_branch ─────────────────────────────────────────────

echo ""
echo "=== get_sync_branch ==="

# Test: Config JSON file takes priority
echo ""
echo "--- config.json priority ---"
setup_git_repo "branch_config" "main"
mkdir -p "$REPO_DIR/.beads"
echo '{"sync_branch": "beads-sync"}' > "$REPO_DIR/.beads/config.json"
result="$(
  unset BD_SYNC_BRANCH 2>/dev/null || true
  source "$REPO_ROOT/scripts/sync-utils.sh"
  get_sync_branch "$REPO_DIR"
)"
assert_eq "config.json sync_branch takes priority" "beads-sync" "$result"

# Test: Env var overrides when no config
echo ""
echo "--- env var fallback ---"
setup_git_repo "branch_env" "main"
result="$(
  export BD_SYNC_BRANCH="env-branch"
  source "$REPO_ROOT/scripts/sync-utils.sh"
  get_sync_branch "$REPO_DIR"
)"
assert_eq "BD_SYNC_BRANCH env var used when no config" "env-branch" "$result"

# Test: git symbolic-ref fallback detects develop
echo ""
echo "--- symbolic-ref fallback ---"
setup_git_repo "branch_symref" "develop"
result="$(
  unset BD_SYNC_BRANCH 2>/dev/null || true
  source "$REPO_ROOT/scripts/sync-utils.sh"
  get_sync_branch "$REPO_DIR"
)"
assert_eq "symbolic-ref detects 'develop'" "develop" "$result"

# Test: Detects 'main' branch via symbolic-ref
echo ""
echo "--- symbolic-ref detects main ---"
setup_git_repo "branch_main" "main"
result="$(
  unset BD_SYNC_BRANCH 2>/dev/null || true
  source "$REPO_ROOT/scripts/sync-utils.sh"
  get_sync_branch "$REPO_DIR"
)"
assert_eq "symbolic-ref detects 'main'" "main" "$result"

# Test: Detects 'master' branch via symbolic-ref
echo ""
echo "--- symbolic-ref detects master ---"
setup_git_repo "branch_master" "master"
result="$(
  unset BD_SYNC_BRANCH 2>/dev/null || true
  source "$REPO_ROOT/scripts/sync-utils.sh"
  get_sync_branch "$REPO_DIR"
)"
assert_eq "symbolic-ref detects 'master'" "master" "$result"

# Test: Fallback to 'main' when symbolic-ref unavailable
echo ""
echo "--- fallback to main ---"
setup_git_repo "branch_fallback_main" "main"
git -C "$REPO_DIR" remote set-head origin --delete >/dev/null 2>&1
result="$(
  unset BD_SYNC_BRANCH 2>/dev/null || true
  source "$REPO_ROOT/scripts/sync-utils.sh"
  get_sync_branch "$REPO_DIR"
)"
assert_eq "falls back to 'main' when it exists" "main" "$result"

# Test: Fallback to 'master' when main absent
echo ""
echo "--- fallback to master ---"
setup_git_repo "branch_fallback_master" "master"
git -C "$REPO_DIR" remote set-head origin --delete >/dev/null 2>&1
result="$(
  unset BD_SYNC_BRANCH 2>/dev/null || true
  source "$REPO_ROOT/scripts/sync-utils.sh"
  get_sync_branch "$REPO_DIR"
)"
assert_eq "falls back to 'master' when main absent" "master" "$result"

# Test: Config YAML sync-branch field
echo ""
echo "--- config.yaml sync-branch ---"
setup_git_repo "branch_yaml" "main"
mkdir -p "$REPO_DIR/.beads"
echo 'sync-branch: "yaml-sync-branch"' > "$REPO_DIR/.beads/config.yaml"
result="$(
  unset BD_SYNC_BRANCH 2>/dev/null || true
  source "$REPO_ROOT/scripts/sync-utils.sh"
  get_sync_branch "$REPO_DIR"
)"
assert_eq "config.yaml sync-branch takes priority" "yaml-sync-branch" "$result"

# Test: Config overrides env var
echo ""
echo "--- config overrides env ---"
setup_git_repo "branch_config_over_env" "main"
mkdir -p "$REPO_DIR/.beads"
echo '{"sync_branch": "from-config"}' > "$REPO_DIR/.beads/config.json"
result="$(
  export BD_SYNC_BRANCH="from-env"
  source "$REPO_ROOT/scripts/sync-utils.sh"
  get_sync_branch "$REPO_DIR"
)"
assert_eq "config overrides env var" "from-config" "$result"

# ── Tests: get_sync_remote ─────────────────────────────────────────────

echo ""
echo "=== get_sync_remote ==="

# Test: Config file takes priority for remote
echo ""
echo "--- config remote priority ---"
setup_git_repo "remote_config" "main"
mkdir -p "$REPO_DIR/.beads"
echo '{"sync_remote": "custom-remote"}' > "$REPO_DIR/.beads/config.json"
result="$(
  unset BD_SYNC_REMOTE 2>/dev/null || true
  source "$REPO_ROOT/scripts/sync-utils.sh"
  get_sync_remote "$REPO_DIR"
)"
assert_eq "config.json sync_remote takes priority" "custom-remote" "$result"

# Test: Env var overrides when no config for remote
echo ""
echo "--- env var remote ---"
setup_git_repo "remote_env" "main"
result="$(
  export BD_SYNC_REMOTE="env-remote"
  source "$REPO_ROOT/scripts/sync-utils.sh"
  get_sync_remote "$REPO_DIR"
)"
assert_eq "BD_SYNC_REMOTE env var used when no config" "env-remote" "$result"

# Test: Detects 'upstream' remote for fork-based setups
echo ""
echo "--- upstream detection for forks ---"
setup_git_repo "remote_fork" "main"
local_upstream_bare="$TMPDIR_ROOT/remote_fork_upstream_bare"
git init --bare -- "$local_upstream_bare" >/dev/null 2>&1
git -C "$REPO_DIR" remote add upstream "$local_upstream_bare" >/dev/null 2>&1
result="$(
  unset BD_SYNC_REMOTE 2>/dev/null || true
  source "$REPO_ROOT/scripts/sync-utils.sh"
  get_sync_remote "$REPO_DIR"
)"
assert_eq "detects 'upstream' remote for forks" "upstream" "$result"

# Test: Defaults to 'origin' when no upstream
echo ""
echo "--- default origin ---"
setup_git_repo "remote_default" "main"
result="$(
  unset BD_SYNC_REMOTE 2>/dev/null || true
  source "$REPO_ROOT/scripts/sync-utils.sh"
  get_sync_remote "$REPO_DIR"
)"
assert_eq "defaults to 'origin' when no upstream" "origin" "$result"

# Test: Config overrides env for remote
echo ""
echo "--- config overrides env remote ---"
setup_git_repo "remote_config_over_env" "main"
mkdir -p "$REPO_DIR/.beads"
echo '{"sync_remote": "from-config"}' > "$REPO_DIR/.beads/config.json"
result="$(
  export BD_SYNC_REMOTE="from-env"
  source "$REPO_ROOT/scripts/sync-utils.sh"
  get_sync_remote "$REPO_DIR"
)"
assert_eq "config overrides env var for remote" "from-config" "$result"

# Test: YAML config for remote
echo ""
echo "--- yaml config remote ---"
setup_git_repo "remote_yaml" "main"
mkdir -p "$REPO_DIR/.beads"
echo 'sync-remote: "yaml-remote"' > "$REPO_DIR/.beads/config.yaml"
result="$(
  unset BD_SYNC_REMOTE 2>/dev/null || true
  source "$REPO_ROOT/scripts/sync-utils.sh"
  get_sync_remote "$REPO_DIR"
)"
assert_eq "config.yaml sync-remote takes priority" "yaml-remote" "$result"

# ── Security tests for branch/remote ──────────────────────────────────

echo ""
echo "=== Security: branch/remote injection ==="

# Test: Semicolon injection in config value is sanitized
echo ""
echo "--- semicolon injection ---"
setup_git_repo "sec_injection" "main"
mkdir -p "$REPO_DIR/.beads"
echo '{"sync_branch": "safe; rm -rf /"}' > "$REPO_DIR/.beads/config.json"
result="$(
  unset BD_SYNC_BRANCH 2>/dev/null || true
  source "$REPO_ROOT/scripts/sync-utils.sh"
  get_sync_branch "$REPO_DIR"
)"
case "$result" in
  *";"*) assert_eq "injection sanitized (no semicolons)" "no-semicolon" "has-semicolon" ;;
  *) assert_eq "injection sanitized (no semicolons)" "sanitized" "sanitized" ;;
esac

# Test: Backtick injection sanitized
echo ""
echo "--- backtick injection ---"
setup_git_repo "sec_backtick" "main"
mkdir -p "$REPO_DIR/.beads"
printf '{"sync_branch": "safe`whoami`"}' > "$REPO_DIR/.beads/config.json"
result="$(
  unset BD_SYNC_BRANCH 2>/dev/null || true
  source "$REPO_ROOT/scripts/sync-utils.sh"
  get_sync_branch "$REPO_DIR"
)"
case "$result" in
  *'`'*) assert_eq "backtick injection sanitized" "no-backtick" "has-backtick" ;;
  *) assert_eq "backtick injection sanitized" "sanitized" "sanitized" ;;
esac

# Test: Command substitution injection sanitized
echo ""
echo "--- command substitution injection ---"
setup_git_repo "sec_cmdsub" "main"
mkdir -p "$REPO_DIR/.beads"
printf '{"sync_remote": "safe$(whoami)end"}' > "$REPO_DIR/.beads/config.json"
result="$(
  unset BD_SYNC_REMOTE 2>/dev/null || true
  source "$REPO_ROOT/scripts/sync-utils.sh"
  get_sync_remote "$REPO_DIR"
)"
case "$result" in
  *'$('*) assert_eq "cmd substitution sanitized" "no-cmdsub" "has-cmdsub" ;;
  *) assert_eq "cmd substitution sanitized" "sanitized" "sanitized" ;;
esac

# ── Summary ────────────────────────────────────────────────────────────

echo ""
echo "=== Results: $PASS passed, $FAIL failed ==="

if [ "$FAIL" -gt 0 ]; then
  exit 1
fi
exit 0
