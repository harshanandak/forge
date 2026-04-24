#!/usr/bin/env bash
# scripts/forge-team/lib/sync-github.sh — Bidirectional sync between Beads and GitHub
#
# Functions:
#   sync_issue_create  <beads-id>             — Create GitHub issue from Beads
#   sync_issue_claim   <beads-id>             — Assign current dev on GitHub
#   sync_issue_status  <beads-id> <status>    — Update status label on GitHub
#   sync_issue_close   <beads-id>             — Close GitHub issue
#   sync_issue_deps    <beads-id-a> <beads-id-b> — Add "Blocked by" comment
#   _get_github_issue_number <beads-id>       — Extract canonical GitHub issue from bd show
#
# Env overrides (for testing):
#   GH_CMD  — Path to gh binary (default: gh)
#   BD_CMD  — Path to bd binary (default: bd)
#
# All GitHub-sourced strings are sanitized via sanitize_for_agent() before
# use in shell commands (OWASP A03).
#
# This file does NOT set errexit/pipefail — callers manage their own shell options.

# Guard against double-sourcing
if [[ -n "${_SYNC_GITHUB_LIB_LOADED:-}" ]]; then
  return 0 2>/dev/null || true
fi
_SYNC_GITHUB_LIB_LOADED=1

_SYNC_GITHUB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Source shared libraries (graceful fallback if missing)
# sanitize.sh — from scripts/lib/
_SYNC_SANITIZE_PATH="$_SYNC_GITHUB_DIR/../../lib/sanitize.sh"
if [[ -f "$_SYNC_SANITIZE_PATH" ]]; then
  source "$_SYNC_SANITIZE_PATH"
fi

# agent-prompt.sh — from forge-team/lib/ (provides sanitize_for_agent)
if [[ -f "$_SYNC_GITHUB_DIR/agent-prompt.sh" ]]; then
  source "$_SYNC_GITHUB_DIR/agent-prompt.sh"
fi

# identity.sh — from forge-team/lib/ (provides get_github_user)
if [[ -f "$_SYNC_GITHUB_DIR/identity.sh" ]]; then
  source "$_SYNC_GITHUB_DIR/identity.sh"
fi

# ── Internal helpers ─────────────────────────────────────────────────────

# _sync_error <message>
# Output error via agent_error if available, otherwise stderr
_sync_error() {
  if declare -f agent_error &>/dev/null; then
    agent_error "$1"
  else
    echo "ERROR: $1" >&2
  fi
}

# _safe_sanitize <string>
# Sanitize using both sanitize_for_agent (strip agent prefix) and sanitize
# (strip shell injection patterns). Either or both may be available.
_safe_sanitize() {
  local input="${1:-}"
  # Step 1: strip agent prefix injection if sanitize_for_agent is available
  if declare -f sanitize_for_agent &>/dev/null; then
    input="$(sanitize_for_agent "$input")"
  fi
  # Step 2: strip shell injection patterns (OWASP A03) if sanitize is available
  if declare -f sanitize &>/dev/null; then
    input="$(sanitize "$input")"
  fi
  printf '%s' "$input"
}

_extract_issue_number_from_url() {
  local input="${1:-}"
  local suffix="${input##*/issues/}"

  if [[ "$suffix" == "$input" ]]; then
    return 1
  fi

  suffix="${suffix%%[^0-9]*}"
  if [[ -z "$suffix" ]]; then
    return 1
  fi

  printf '%s' "$suffix"
}

_extract_issue_title_from_show() {
  local input="${1:-}"

  printf '%s' "$input" | node -e '
    const fs = require("node:fs");
    const input = fs.readFileSync(0, "utf8");
    const lines = input.split(/\r?\n/);
    const titledLine = lines.find((line) => /^Title:\s*/.test(line));

    if (titledLine) {
      process.stdout.write(titledLine.replace(/^Title:\s*/, "").trim());
      process.exit(0);
    }

    const summaryLine = lines.find((line) => line.trim().length > 0);
    if (!summaryLine) {
      process.exit(0);
    }

    const separators = [" - ", " \u00B7 ", " \u2022 "];
    for (const separator of separators) {
      const separatorIndex = summaryLine.indexOf(separator);
      if (separatorIndex === -1) {
        continue;
      }

      const candidate = summaryLine
        .slice(separatorIndex + separator.length)
        .replace(/\s+\[[^\]]*\]\s*$/u, "")
        .trim();

      if (candidate.length > 0) {
        process.stdout.write(candidate);
        break;
      }
    }
  '
}

# ── _get_github_issue_number ─────────────────────────────────────────────
# Extracts the canonical GitHub issue number from `bd show <id> --json`.
# Returns the number or empty string (exit 1 if not found).
_get_github_issue_number() {
  local beads_id="${1:-}"
  if [[ -z "$beads_id" ]]; then
    _sync_error "beads-id required"
    return 1
  fi

  local bd_cmd="${BD_CMD:-bd}"
  local show_output
  show_output="$("$bd_cmd" show "$beads_id" --json 2>/dev/null)" || {
    _sync_error "Failed to get beads info for $beads_id"
    return 1
  }

  local issue_num
  issue_num="$(printf '%s' "$show_output" | node -e '
    const fs = require("node:fs");
    const input = fs.readFileSync(0, "utf8");
    try {
      const data = JSON.parse(input);
      const issue = Array.isArray(data) ? data[0] : data;
      const value = issue?.github?.number
        ?? issue?.githubNumber
        ?? issue?.issueNumber
        ?? null;
      if (value != null && value !== "") {
        process.stdout.write(String(value));
      }
    } catch (_err) {
      process.exitCode = 0;
    }
  ')"

  if [[ -z "$issue_num" ]]; then
    _sync_error "No canonical GitHub number found for $beads_id"
    return 1
  fi

  printf '%s' "$issue_num"
  return 0
}

# ── _get_issue_title ─────────────────────────────────────────────────────
# Extracts issue title from `bd show <id>` output.
# Looks for "Title: <text>" line or falls back to the summary line.
_get_issue_title() {
  local beads_id="${1:-}"
  local bd_cmd="${BD_CMD:-bd}"
  local show_output
  show_output="$("$bd_cmd" show "$beads_id" 2>/dev/null)" || return 1

  local title
  title="$(_extract_issue_title_from_show "$show_output")"

  if [[ -z "$title" ]]; then
    title="$beads_id"
  fi

  printf '%s' "$title"
}

# ── Public API ───────────────────────────────────────────────────────────

# sync_issue_create <beads-id>
# Creates GitHub issue from Beads issue data.
# Returns 0 on success, 1 on failure.
sync_issue_create() {
  local beads_id="${1:-}"
  if [[ -z "$beads_id" ]]; then
    _sync_error "beads-id required"
    return 1
  fi

  local gh_cmd="${GH_CMD:-gh}"
  local bd_cmd="${BD_CMD:-bd}"

  # Get title from bd show
  local raw_title
  raw_title="$(_get_issue_title "$beads_id")" || {
    _sync_error "Failed to get title for $beads_id"
    return 1
  }

  # Sanitize title (OWASP A03)
  local title
  title="$(_safe_sanitize "$raw_title")"

  # Create GitHub issue
  local gh_output
  gh_output="$("$gh_cmd" issue create --title "$title" --body "Beads: $beads_id" 2>/dev/null)" || {
    _sync_error "Failed to create GitHub issue for $beads_id"
    return 1
  }

  # Extract issue number from URL (e.g., https://github.com/.../issues/42)
  local issue_num
  issue_num="$(_extract_issue_number_from_url "$gh_output")"

  if [[ -z "$issue_num" ]]; then
    _sync_error "Could not extract issue number from: $gh_output"
    return 1
  fi

  return 0
}

# sync_issue_claim <beads-id>
# Assigns the current developer to the GitHub issue.
# Returns 0 on success.
sync_issue_claim() {
  local beads_id="${1:-}"
  if [[ -z "$beads_id" ]]; then
    _sync_error "beads-id required"
    return 1
  fi

  local gh_cmd="${GH_CMD:-gh}"

  # Get GitHub issue number
  local issue_num
  issue_num="$(_get_github_issue_number "$beads_id")" || return 1

  # Get current developer's GitHub username
  local user
  user="$(get_github_user)" || {
    _sync_error "Failed to get GitHub username"
    return 1
  }

  # Update assignee
  "$gh_cmd" issue edit "$issue_num" --add-assignee "$user" >/dev/null 2>&1 || {
    _sync_error "Failed to assign $user to issue #$issue_num"
    return 1
  }

  return 0
}

# sync_issue_status <beads-id> <status>
# Updates status label on the GitHub issue.
# Maps: open → status/open, in_progress → status/in-progress, blocked → status/blocked
# Returns 0 on success.
sync_issue_status() {
  local beads_id="${1:-}"
  local status="${2:-}"
  if [[ -z "$beads_id" ]] || [[ -z "$status" ]]; then
    _sync_error "beads-id and status required"
    return 1
  fi

  local gh_cmd="${GH_CMD:-gh}"

  # Get GitHub issue number
  local issue_num
  issue_num="$(_get_github_issue_number "$beads_id")" || return 1

  # Map status to label
  local label
  case "$status" in
    open)        label="status/open" ;;
    in_progress) label="status/in-progress" ;;
    blocked)     label="status/blocked" ;;
    *)
      _sync_error "Unknown status: $status (expected: open, in_progress, blocked)"
      return 1
      ;;
  esac

  # Remove old status labels, add new one
  "$gh_cmd" issue edit "$issue_num" \
    --remove-label "status/open" \
    --remove-label "status/in-progress" \
    --remove-label "status/blocked" \
    --add-label "$label" >/dev/null 2>&1 || {
    _sync_error "Failed to update status label on issue #$issue_num"
    return 1
  }

  return 0
}

# sync_issue_close <beads-id>
# Closes the GitHub issue.
# Returns 0 on success.
sync_issue_close() {
  local beads_id="${1:-}"
  if [[ -z "$beads_id" ]]; then
    _sync_error "beads-id required"
    return 1
  fi

  local gh_cmd="${GH_CMD:-gh}"

  # Get GitHub issue number
  local issue_num
  issue_num="$(_get_github_issue_number "$beads_id")" || return 1

  # Close the issue
  "$gh_cmd" issue close "$issue_num" >/dev/null 2>&1 || {
    _sync_error "Failed to close issue #$issue_num"
    return 1
  }

  return 0
}

# sync_issue_deps <beads-id-a> <beads-id-b>
# Adds "Blocked by #N-B" comment on issue A.
# Returns 0 on success.
sync_issue_deps() {
  local beads_id_a="${1:-}"
  local beads_id_b="${2:-}"
  if [[ -z "$beads_id_a" ]] || [[ -z "$beads_id_b" ]]; then
    _sync_error "Two beads-ids required (A blocked by B)"
    return 1
  fi

  local gh_cmd="${GH_CMD:-gh}"

  # Get both GitHub issue numbers
  local issue_num_a issue_num_b
  issue_num_a="$(_get_github_issue_number "$beads_id_a")" || return 1
  issue_num_b="$(_get_github_issue_number "$beads_id_b")" || return 1

  # Add comment on A referencing B
  "$gh_cmd" issue comment "$issue_num_a" --body "Blocked by #$issue_num_b" >/dev/null 2>&1 || {
    _sync_error "Failed to add dependency comment on issue #$issue_num_a"
    return 1
  }

  return 0
}
