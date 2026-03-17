#!/usr/bin/env bash
# dep-guard.sh — Dependency-guard helper for pre-change impact analysis.
#
# Subcommands:
#   find-consumers     <file-path>                Find files that import/require a given module
#   check-ripple       <issue-id> <file-path>     Check ripple impact of changes to a file
#   store-contracts    <issue-id> <file-path>      Store public API contracts for a file
#   extract-contracts  <file-path>                 Extract public API contracts from a file
#
# Cross-platform: works on Windows (Git Bash), macOS, and Linux.
# OWASP A03: All variables properly quoted to prevent shell injection.

set -euo pipefail

# ── Helpers ──────────────────────────────────────────────────────────────

usage() {
  cat >&2 <<'EOF'
Usage: dep-guard.sh <subcommand> [args...]

Subcommands:
  find-consumers     <file-path>                Find files that import/require a given module
  check-ripple       <issue-id> <file-path>     Check ripple impact of changes to a file
  store-contracts    <issue-id> <file-path>      Store public API contracts for a file
  extract-contracts  <file-path>                 Extract public API contracts from a file
EOF
  exit 1
}

die() {
  echo "Error: $1" >&2
  exit 1
}

# Sanitize a string: strip shell-injection patterns (OWASP A03)
# Removes: double quotes, $(...), backticks, semicolons, and newlines
sanitize() {
  local val="$1"
  # Remove double quotes
  val="${val//\"/}"
  # Remove $(...) command substitution patterns (loop handles nested)
  # Use newline-separated commands for BSD sed compatibility (macOS)
  val="$(printf '%s' "$val" | sed -e ':loop' -e 's/\$([^()]*)//g' -e 't loop')"
  # Remove backtick command substitution
  val="${val//\`/}"
  # Remove semicolons (command chaining)
  val="${val//;/}"
  # Replace newlines with spaces
  val="$(printf '%s' "$val" | tr '\n' ' ')"
  printf '%s' "$val"
}

# Run bd update and check for errors in both exit code and output.
# bd update exits 0 even for non-existent issues, so we check stdout too.
bd_update() {
  local output
  output="$(bd update "$@" 2>&1)"
  local rc=$?

  if [[ $rc -ne 0 ]]; then
    echo "$output" >&2
    return 1
  fi

  # bd prints "Error resolving/updating ..." to stdout for non-existent issues
  # Use specific patterns to avoid false positives from data containing "error"
  if printf '%s' "$output" | grep -Eqi '^Error|Error resolving|Error updating'; then
    echo "$output" >&2
    return 1
  fi

  echo "$output"
  return 0
}

# Run bd show <id> --json and return the JSON string.
# Handles both array and object JSON responses.
bd_show_json() {
  local issue_id="$1"

  local json
  json="$(bd show "$issue_id" --json 2>&1)" || die "Failed to show issue ${issue_id}"

  # bd show may exit 0 but print an error for non-existent issues
  if printf '%s' "$json" | grep -Eqi '^Error (fetching|resolving)'; then
    die "Issue not found: ${issue_id}"
  fi

  # bd show returns "[]" or empty for non-existent issues
  if [[ -z "$json" || "$json" == "[]" || "$json" == "null" ]]; then
    die "Issue not found: ${issue_id}"
  fi

  # Normalize: if the response is an array, extract the first element
  if command -v jq &>/dev/null; then
    json="$(printf '%s' "$json" | jq 'if type == "array" then .[0] else . end' 2>/dev/null)" || true
  fi

  printf '%s' "$json"
}

# ── Subcommands ──────────────────────────────────────────────────────────

cmd_find_consumers() {
  if [[ $# -lt 1 || -z "$1" ]]; then
    echo "Usage: dep-guard.sh find-consumers <function-or-pattern>" >&2
    exit 1
  fi

  local pattern
  pattern="$(sanitize "$1")"

  # Build list of directories that actually exist
  local dirs=()
  for d in lib/ scripts/ bin/ .claude/commands/ .forge/hooks/; do
    [[ -d "$d" ]] && dirs+=("$d")
  done

  if [[ ${#dirs[@]} -eq 0 ]]; then
    echo "No consumers found"
    return 0
  fi

  # Grep across key directories, excluding noise
  local results
  results="$(grep -rn "$pattern" \
    --include='*.js' --include='*.sh' --include='*.md' --include='*.ts' --include='*.json' \
    --exclude-dir=node_modules --exclude-dir=.worktrees --exclude-dir=test --exclude-dir=test-env \
    --exclude='dep-guard.sh' \
    "${dirs[@]}" 2>/dev/null || true)"

  if [[ -z "$results" ]]; then
    echo "No consumers found"
    return 0
  fi

  echo "$results"
  return 0
}

cmd_check_ripple() {
  if [[ $# -lt 2 ]]; then
    echo "Usage: dep-guard.sh check-ripple <issue-id> <file-path>" >&2
    exit 1
  fi

  echo "Not implemented: check-ripple" >&2
  exit 1
}

cmd_store_contracts() {
  if [[ $# -lt 2 ]]; then
    echo "Usage: dep-guard.sh store-contracts <issue-id> <file-path>" >&2
    exit 1
  fi

  echo "Not implemented: store-contracts" >&2
  exit 1
}

cmd_extract_contracts() {
  if [[ $# -lt 1 ]]; then
    echo "Usage: dep-guard.sh extract-contracts <file-path>" >&2
    exit 1
  fi

  echo "Not implemented: extract-contracts" >&2
  exit 1
}

# ── Main dispatcher ──────────────────────────────────────────────────────

if [[ $# -lt 1 ]]; then
  usage
fi

subcommand="$1"
shift

case "$subcommand" in
  find-consumers)     cmd_find_consumers "$@" ;;
  check-ripple)       cmd_check_ripple "$@" ;;
  store-contracts)    cmd_store_contracts "$@" ;;
  extract-contracts)  cmd_extract_contracts "$@" ;;
  *)
    echo "Error: Unknown subcommand '${subcommand}'" >&2
    usage
    ;;
esac
