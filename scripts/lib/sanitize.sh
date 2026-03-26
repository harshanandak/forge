#!/usr/bin/env bash
# sanitize.sh — Shared input sanitization and validation library.
#
# Extracted from file-index.sh, dep-guard.sh, beads-context.sh, sync-utils.sh
# to eliminate duplication. Source this file; do NOT run it directly.
#
# Functions:
#   sanitize              <string>    Strip shell-injection patterns (OWASP A03)
#   sanitize_config_value <string>    Strip injection + pipes, trim whitespace
#   validate_branch_name  <string>    Validate git branch name format
#   validate_pr_number    <string>    Validate GitHub PR number (digits only)
#   validate_label_name   <string>    Validate GitHub label format
#
# This file does NOT set errexit/pipefail — callers manage their own shell options.
# OWASP A03: All inputs validated and shell-injection patterns stripped.

# Guard against double-sourcing
if [[ -n "${_SANITIZE_LIB_LOADED:-}" ]]; then
  return 0 2>/dev/null || true
fi
_SANITIZE_LIB_LOADED=1

# ── sanitize ──────────────────────────────────────────────────────────────
# Sanitize a string: strip shell-injection patterns (OWASP A03).
# Removes: double quotes, $(...), backticks, semicolons, and newlines.
# Usage: clean="$(sanitize "$raw")"
sanitize() {
  local val="$1"
  # Remove double quotes
  val="${val//\"/}"
  # Remove $(...) command substitution patterns (loop handles nested)
  val="$(printf '%s' "$val" | sed -e ':loop' -e 's/\$([^()]*)//g' -e 't loop')"
  # Remove backtick command substitution
  val="${val//\`/}"
  # Remove semicolons (command chaining)
  val="${val//;/}"
  # Replace newlines with spaces
  val="$(printf '%s' "$val" | tr '\n' ' ')"
  printf '%s' "$val"
}

# ── sanitize_config_value ────────────────────────────────────────────────
# Sanitize a config value: strip shell-injection patterns + pipes (OWASP A03).
# Removes: backticks, $(...), semicolons, pipes, newlines. Trims whitespace.
# Usage: clean="$(sanitize_config_value "$raw")"
sanitize_config_value() {
  local val="$1"
  # Remove backtick command substitution
  val="${val//\`/}"
  # Remove $(...) command substitution patterns (loop handles nested)
  val="$(printf '%s' "$val" | sed -e ':loop' -e 's/\$([^()]*)//g' -e 't loop')"
  # Remove semicolons (command chaining)
  val="${val//;/}"
  # Remove pipes (command chaining)
  val="${val//|/}"
  # Collapse newlines to spaces
  val="$(printf '%s' "$val" | tr '\n' ' ')"
  # Trim leading/trailing whitespace
  val="$(printf '%s' "$val" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')"
  printf '%s' "$val"
}

# ── validate_branch_name ─────────────────────────────────────────────────
# Validate a git branch name.
# Allowed: alphanumeric, dots, hyphens, underscores, forward slashes, @
# Usage: validate_branch_name "feat/my-feature" || exit 1
validate_branch_name() {
  local name="${1:-}"
  if [[ -z "$name" ]]; then
    echo "Error: branch name cannot be empty" >&2
    return 1
  fi
  if [[ ! "$name" =~ ^[a-zA-Z0-9._/@-]+$ ]]; then
    echo "Error: invalid branch name format: $name" >&2
    return 1
  fi
  # Git rejects: double dots (..), trailing .lock, leading/trailing slash, leading hyphen
  if [[ "$name" == *..* ]] || [[ "$name" == *.lock ]] || [[ "$name" == /* ]] || [[ "$name" == */ ]] || [[ "$name" == -* ]]; then
    echo "Error: invalid branch name (contains .., .lock suffix, leading/trailing /, or leading -): $name" >&2
    return 1
  fi
  return 0
}

# ── validate_pr_number ───────────────────────────────────────────────────
# Validate a GitHub PR number (digits only).
# Usage: validate_pr_number "42" || exit 1
validate_pr_number() {
  local num="${1:-}"
  if [[ -z "$num" ]]; then
    echo "Error: PR number cannot be empty" >&2
    return 1
  fi
  if [[ ! "$num" =~ ^[0-9]+$ ]]; then
    echo "Error: invalid PR number format: $num" >&2
    return 1
  fi
  return 0
}

# ── validate_label_name ──────────────────────────────────────────────────
# Validate a GitHub label name.
# Allowed: alphanumeric, dots, hyphens, underscores, forward slashes
# Usage: validate_label_name "forge/has-deps" || exit 1
validate_label_name() {
  local name="${1:-}"
  if [[ -z "$name" ]]; then
    echo "Error: label name cannot be empty" >&2
    return 1
  fi
  if [[ ! "$name" =~ ^[a-zA-Z0-9._/-]+$ ]]; then
    echo "Error: invalid label name format: $name" >&2
    return 1
  fi
  return 0
}
