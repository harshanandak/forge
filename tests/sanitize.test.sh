#!/usr/bin/env bash
# sanitize.test.sh — Tests for shared sanitize library (scripts/lib/sanitize.sh).
#
# Usage: bash tests/sanitize.test.sh
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

assert_exit_0() {
  local label="$1"
  shift
  if "$@" >/dev/null 2>&1; then
    echo "  PASS: $label"
    PASS=$((PASS + 1))
  else
    echo "  FAIL: $label (expected exit 0, got non-zero)"
    FAIL=$((FAIL + 1))
  fi
}

assert_exit_nonzero() {
  local label="$1"
  shift
  if "$@" >/dev/null 2>&1; then
    echo "  FAIL: $label (expected non-zero exit, got 0)"
    FAIL=$((FAIL + 1))
  else
    echo "  PASS: $label"
    PASS=$((PASS + 1))
  fi
}

# ── Source the module under test ───────────────────────────────────────

source "$REPO_ROOT/scripts/lib/sanitize.sh"

# ══════════════════════════════════════════════════════════════════════════
# Tests: sanitize()
# ══════════════════════════════════════════════════════════════════════════

echo ""
echo "── sanitize() ──"

# Valid input passes through unchanged
result="$(sanitize "hello-world")"
assert_eq "valid string passes through" "hello-world" "$result"

# Empty string returns empty
result="$(sanitize "")"
assert_eq "empty string returns empty" "" "$result"

# Strips double quotes
result="$(sanitize 'say "hello"')"
assert_eq "strips double quotes" "say hello" "$result"

# Strips backticks
result="$(sanitize "run $(printf '\x60')whoami$(printf '\x60')")"
assert_eq "strips backticks" "run whoami" "$result"

# Strips semicolons
result="$(sanitize 'cmd; rm -rf /')"
assert_eq "strips semicolons" "cmd rm -rf /" "$result"

# Strips $(...) command substitution
result="$(sanitize 'hello $(whoami) world')"
assert_eq "strips command substitution" "hello  world" "$result"

# Strips nested $(...) command substitution
result="$(sanitize 'a $(b $(c)) d')"
assert_eq "strips nested command substitution" "a  d" "$result"

# Combined injection attempt
result="$(sanitize '$(rm -rf /);`id`"test"')"
assert_eq "strips combined injection" "idtest" "$result"

# Preserves alphanumeric + hyphens + underscores + dots
result="$(sanitize "my-file_v2.0")"
assert_eq "preserves safe chars" "my-file_v2.0" "$result"

# ══════════════════════════════════════════════════════════════════════════
# Tests: sanitize_config_value()
# ══════════════════════════════════════════════════════════════════════════

echo ""
echo "── sanitize_config_value() ──"

# Valid input passes through (whitespace trimmed)
result="$(sanitize_config_value "hello-world")"
assert_eq "valid string passes through" "hello-world" "$result"

# Strips pipes (unlike sanitize)
result="$(sanitize_config_value "cmd | grep foo")"
assert_eq "strips pipes" "cmd  grep foo" "$result"

# Strips backticks
result="$(sanitize_config_value "run $(printf '\x60')id$(printf '\x60')")"
assert_eq "strips backticks" "run id" "$result"

# Strips semicolons
result="$(sanitize_config_value "a; b")"
assert_eq "strips semicolons" "a b" "$result"

# Strips $(...) command substitution
result="$(sanitize_config_value 'val $(whoami)')"
assert_eq "strips command substitution" "val" "$result"

# Trims leading/trailing whitespace
result="$(sanitize_config_value "  spaced  ")"
assert_eq "trims whitespace" "spaced" "$result"

# ══════════════════════════════════════════════════════════════════════════
# Tests: validate_branch_name()
# ══════════════════════════════════════════════════════════════════════════

echo ""
echo "── validate_branch_name() ──"

# Valid branch names
assert_exit_0 "simple branch name" validate_branch_name "feat/my-feature"
assert_exit_0 "branch with dots" validate_branch_name "release/v1.0.0"
assert_exit_0 "branch with underscore" validate_branch_name "fix_something"
assert_exit_0 "branch with @" validate_branch_name "user@feature"
assert_exit_0 "plain alphanumeric" validate_branch_name "main"
assert_exit_0 "nested slashes" validate_branch_name "refs/heads/feat/thing"

# Invalid branch names
assert_exit_nonzero "semicolon injection" validate_branch_name "feat;rm -rf /"
assert_exit_nonzero "pipe injection" validate_branch_name "feat|cat /etc/passwd"
assert_exit_nonzero "backtick injection" validate_branch_name 'feat`whoami`'
assert_exit_nonzero "command substitution" validate_branch_name 'feat$(id)'
assert_exit_nonzero "space in name" validate_branch_name "feat my thing"
assert_exit_nonzero "empty string" validate_branch_name ""
assert_exit_nonzero "double dots (traversal)" validate_branch_name "feat/../../etc/passwd"
assert_exit_nonzero "trailing .lock" validate_branch_name "feat/thing.lock"
assert_exit_nonzero "leading slash" validate_branch_name "/feat/thing"
assert_exit_nonzero "trailing slash" validate_branch_name "feat/thing/"
assert_exit_nonzero "leading hyphen" validate_branch_name "-feat/thing"

# ══════════════════════════════════════════════════════════════════════════
# Tests: validate_pr_number()
# ══════════════════════════════════════════════════════════════════════════

echo ""
echo "── validate_pr_number() ──"

# Valid PR numbers
assert_exit_0 "single digit" validate_pr_number "1"
assert_exit_0 "multi digit" validate_pr_number "42"
assert_exit_0 "large number" validate_pr_number "99999"

# Invalid PR numbers
assert_exit_nonzero "alpha chars" validate_pr_number "abc"
assert_exit_nonzero "mixed" validate_pr_number "123abc"
assert_exit_nonzero "injection attempt" validate_pr_number "123;rm"
assert_exit_nonzero "empty string" validate_pr_number ""
assert_exit_nonzero "negative" validate_pr_number "-1"
assert_exit_nonzero "decimal" validate_pr_number "1.5"

# ══════════════════════════════════════════════════════════════════════════
# Tests: validate_label_name()
# ══════════════════════════════════════════════════════════════════════════

echo ""
echo "── validate_label_name() ──"

# Valid label names
assert_exit_0 "simple label" validate_label_name "bug"
assert_exit_0 "label with slash" validate_label_name "forge/has-deps"
assert_exit_0 "label with dots" validate_label_name "v1.0.0"
assert_exit_0 "label with underscore" validate_label_name "needs_review"
assert_exit_0 "label with hyphen" validate_label_name "work-in-progress"

# Invalid label names
assert_exit_nonzero "label with spaces" validate_label_name "label with spaces"
assert_exit_nonzero "semicolon injection" validate_label_name "bug;rm"
assert_exit_nonzero "pipe injection" validate_label_name "bug|cat"
assert_exit_nonzero "backtick injection" validate_label_name 'bug`id`'
assert_exit_nonzero "empty string" validate_label_name ""

# ══════════════════════════════════════════════════════════════════════════
# Summary
# ══════════════════════════════════════════════════════════════════════════

echo ""
echo "── Results ──"
echo "  Passed: $PASS"
echo "  Failed: $FAIL"
echo ""

if [[ $FAIL -gt 0 ]]; then
  echo "FAIL: $FAIL test(s) failed"
  exit 1
fi

echo "OK: All $PASS tests passed"
exit 0
