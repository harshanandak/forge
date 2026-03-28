#!/usr/bin/env bash
# scripts/forge-team/lib/claim.sh — Claim locking with pre-claim check
#
# Before allowing issue claim, checks GitHub assignee and uses flock/mkdir
# to prevent race conditions between concurrent agents.
#
# Functions:
#   pre_claim_check   — Check if issue is claimable
#   claim_with_lock   — Atomic claim with file locking
#   forge_team_claim  — Top-level dispatcher entry point
#
# Env overrides (for testing):
#   GH_CMD   — Path to gh binary
#   BD_CMD   — Path to bd binary
#
# This file does NOT set errexit/pipefail — callers manage their own shell options.

# Guard against double-sourcing
if [[ -n "${_CLAIM_LIB_LOADED:-}" ]]; then
  return 0 2>/dev/null || true
fi
_CLAIM_LIB_LOADED=1

_CLAIM_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Source dependencies
if [[ -f "$_CLAIM_DIR/agent-prompt.sh" ]]; then
  source "$_CLAIM_DIR/agent-prompt.sh"
fi

if [[ -f "$_CLAIM_DIR/identity.sh" ]]; then
  source "$_CLAIM_DIR/identity.sh"
fi

# ── Internal helpers ─────────────────────────────────────────────────────

# _claim_error <message>
_claim_error() {
  if declare -f agent_error &>/dev/null; then
    agent_error "$1"
  else
    echo "ERROR: $1" >&2
  fi
}

# _claim_info <message>
_claim_info() {
  if declare -f agent_info &>/dev/null; then
    agent_info "$1"
  else
    echo "INFO: $1" >&2
  fi
}

# _claim_prompt <message>
_claim_prompt() {
  if declare -f agent_prompt &>/dev/null; then
    agent_prompt "$1"
  else
    echo "PROMPT: $1" >&2
  fi
}

# _get_github_issue_number <beads-id>
# Extracts github_issue:N from bd show output. Returns number or empty.
_get_github_issue_number() {
  local beads_id="$1"
  local bd_cmd="${BD_CMD:-bd}"
  local bd_output
  bd_output="$("$bd_cmd" show "$beads_id" 2>/dev/null)" || return 1

  local issue_num
  issue_num="$(printf '%s' "$bd_output" | grep -oP 'github_issue:\K[0-9]+' || true)"
  if [[ -z "$issue_num" ]]; then
    return 1
  fi
  printf '%s' "$issue_num"
}

# _get_github_assignee <issue-number>
# Returns the GitHub login of the assignee, or empty if unassigned.
_get_github_assignee() {
  local issue_num="$1"
  local gh_cmd="${GH_CMD:-gh}"
  local assignee
  assignee="$("$gh_cmd" issue view "$issue_num" --json assignees --jq '.assignees[0].login // empty' 2>/dev/null)" || return 1
  printf '%s' "$assignee"
}

# _claim_lock_dir — Returns the path to the claim lock directory
_claim_lock_dir() {
  local root="${TEAM_MAP_ROOT:-.}"
  printf '%s' "$root/.beads"
}

# ── Public API ───────────────────────────────────────────────────────────

# pre_claim_check <beads-id>
# Checks if issue is claimable. Returns 0 if clear, 1 if blocked.
pre_claim_check() {
  local beads_id="${1:-}"
  if [[ -z "$beads_id" ]]; then
    _claim_error "Usage: pre_claim_check <beads-id>"
    return 1
  fi

  # Get current user first (validates gh auth)
  local current_user
  if ! current_user="$(get_github_user)"; then
    _claim_error "GitHub CLI not authenticated. Run 'gh auth login' first."
    return 1
  fi

  # Get GitHub issue number from beads
  local issue_num
  if ! issue_num="$(_get_github_issue_number "$beads_id")"; then
    _claim_error "No github_issue number found for $beads_id"
    return 1
  fi

  if [[ -z "$issue_num" ]]; then
    _claim_error "No github_issue number found for $beads_id"
    return 1
  fi

  # Query GitHub assignee
  local assignee
  assignee="$(_get_github_assignee "$issue_num")" || true

  # If unassigned or assigned to current user: proceed
  if [[ -z "$assignee" ]] || [[ "$assignee" == "$current_user" ]]; then
    return 0
  fi

  # Assigned to someone else: prompt
  _claim_prompt "$beads_id is claimed by $assignee. Override? Run: forge team claim $beads_id --force"
  return 1
}

# claim_with_lock <beads-id> [--force]
# Atomic claim using flock/mkdir locking pattern.
# With --force, skips the re-check of assignee inside the lock.
claim_with_lock() {
  local beads_id="${1:-}"
  local force="${2:-}"
  if [[ -z "$beads_id" ]]; then
    _claim_error "Usage: claim_with_lock <beads-id>"
    return 1
  fi

  local gh_cmd="${GH_CMD:-gh}"
  local bd_cmd="${BD_CMD:-bd}"
  local lock_dir
  lock_dir="$(_claim_lock_dir)"
  mkdir -p "$lock_dir"

  local lock_file="$lock_dir/claim.lock"

  # Get current user
  local current_user
  if ! current_user="$(get_github_user)"; then
    _claim_error "GitHub CLI not authenticated."
    return 1
  fi

  # Get GitHub issue number
  local issue_num
  if ! issue_num="$(_get_github_issue_number "$beads_id")"; then
    _claim_error "No github_issue number found for $beads_id"
    return 1
  fi

  if command -v flock &>/dev/null; then
    # flock-based locking
    (
      flock -w 5 200 || {
        _claim_error "Claim lock timeout after 5s"
        exit 1
      }
      # Re-check assignee inside lock (skip if --force)
      if [[ "$force" != "--force" ]]; then
        local assignee
        assignee="$(_get_github_assignee "$issue_num")" || true
        if [[ -n "$assignee" ]] && [[ "$assignee" != "$current_user" ]]; then
          _claim_error "$beads_id was claimed by $assignee while waiting for lock"
          exit 1
        fi
      fi
      # Claim on both Beads and GitHub
      "$bd_cmd" update "$beads_id" --claim >/dev/null 2>&1 || true
      "$gh_cmd" issue edit "$issue_num" --add-assignee "$current_user" >/dev/null 2>&1 || true
    ) 200>"$lock_file"
    local subshell_rc=$?
    [[ $subshell_rc -ne 0 ]] && return $subshell_rc
  else
    # mkdir-based fallback
    local lock_mkdir="$lock_dir/claim.lock.d"
    local attempts=0
    while ! mkdir "$lock_mkdir" 2>/dev/null; do
      attempts=$((attempts + 1))
      if [[ $attempts -ge 50 ]]; then
        _claim_error "Claim lock timeout after 5s"
        return 1
      fi
      sleep 0.1
    done
    trap 'rmdir "$lock_mkdir" 2>/dev/null; trap - RETURN' RETURN

    # Re-check assignee inside lock (skip if --force)
    if [[ "$force" != "--force" ]]; then
      local assignee
      assignee="$(_get_github_assignee "$issue_num")" || true
      if [[ -n "$assignee" ]] && [[ "$assignee" != "$current_user" ]]; then
        _claim_error "$beads_id was claimed by $assignee while waiting for lock"
        return 1
      fi
    fi
    # Claim on both Beads and GitHub
    "$bd_cmd" update "$beads_id" --claim >/dev/null 2>&1 || true
    "$gh_cmd" issue edit "$issue_num" --add-assignee "$current_user" >/dev/null 2>&1 || true
  fi

  return 0
}

# forge_team_claim <beads-id> [--force]
# Top-level function called by the dispatcher.
forge_team_claim() {
  local beads_id="${1:-}"
  local force_flag="${2:-}"

  if [[ -z "$beads_id" ]]; then
    _claim_error "Usage: forge team claim <beads-id> [--force]"
    return 1
  fi

  local bd_cmd="${BD_CMD:-bd}"

  if [[ "$force_flag" == "--force" ]]; then
    # Skip pre-claim check, claim directly (pass --force to skip lock re-check too)
    claim_with_lock "$beads_id" "--force" || return 1
    # Log override via bd comments
    "$bd_cmd" comments add "$beads_id" "Force-claimed by $(get_github_user 2>/dev/null || echo 'unknown')" >/dev/null 2>&1 || true
    _claim_info "$beads_id force-claimed successfully"
    return 0
  fi

  # Normal flow: pre-claim check then lock-claim
  if ! pre_claim_check "$beads_id"; then
    return 1
  fi

  claim_with_lock "$beads_id" || return 1
  _claim_info "$beads_id claimed successfully"
  return 0
}
