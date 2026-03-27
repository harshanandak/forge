#!/usr/bin/env bash
# scripts/forge-team/lib/hooks.sh — Hook-based sync (pre-push + stage transitions)
#
# Functions:
#   forge_team_sync [--quiet]                          — Top-level sync for hooks/manual
#   forge_team_sync_on_stage <beads-id> <from> <to>    — Stage transition sync
#   _check_auto_sync_enabled                           — Check config for auto-sync
#
# Env overrides (for testing):
#   GH_CMD      — Path to gh binary (default: gh)
#   BD_CMD      — Path to bd binary (default: bd)
#   BEADS_ROOT  — Path to .beads/ parent directory (default: .)
#
# This file does NOT set errexit/pipefail — callers manage their own shell options.

# Guard against double-sourcing
if [[ -n "${_HOOKS_LIB_LOADED:-}" ]]; then
  return 0 2>/dev/null || true
fi
_HOOKS_LIB_LOADED=1

_HOOKS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Source dependencies
if [[ -f "$_HOOKS_DIR/agent-prompt.sh" ]]; then
  source "$_HOOKS_DIR/agent-prompt.sh"
fi

if [[ -f "$_HOOKS_DIR/sync-github.sh" ]]; then
  source "$_HOOKS_DIR/sync-github.sh"
fi

# ── Internal helpers ─────────────────────────────────────────────────────

# _hooks_error <message>
_hooks_error() {
  if declare -f agent_error &>/dev/null; then
    agent_error "$1"
  else
    echo "ERROR: $1" >&2
  fi
}

# _hooks_info <message>
_hooks_info() {
  if declare -f agent_info &>/dev/null; then
    agent_info "$1"
  else
    echo "INFO: $1" >&2
  fi
}

# _hooks_warn <message>
_hooks_warn() {
  echo "FORGE_AGENT_7f3a:WARN: $1" >&2
}

# ── _check_auto_sync_enabled ─────────────────────────────────────────────
# Reads .beads/config.yaml for team.auto-sync setting.
# Returns 0 if enabled (default), 1 if disabled.
_check_auto_sync_enabled() {
  local beads_root="${BEADS_ROOT:-.}"
  local config_file="$beads_root/.beads/config.yaml"

  if [[ ! -f "$config_file" ]]; then
    # Default: enabled
    return 0
  fi

  # Parse auto-sync value from YAML (simple grep, no yq dependency)
  local auto_sync_line
  auto_sync_line="$(grep -E 'auto-sync:' "$config_file" 2>/dev/null || true)"

  if [[ -z "$auto_sync_line" ]]; then
    # Not set → default enabled
    return 0
  fi

  local value
  value="$(printf '%s' "$auto_sync_line" | sed -E 's/.*auto-sync:[[:space:]]*//' | tr -d '[:space:]')"

  if [[ "$value" == "false" ]]; then
    return 1
  fi

  return 0
}

# ── Public API ───────────────────────────────────────────────────────────

# forge_team_sync [--quiet]
# Top-level sync function called by hooks and manual `forge team sync`.
# 1. Check gh auth status
# 2. Check auto-sync config
# 3. Get in_progress issues with github_issue state
# 4. Sync each to GitHub
# 5. Report count (unless --quiet)
# Non-blocking: warns on failure, doesn't prevent push.
forge_team_sync() {
  local quiet=false

  # Parse arguments
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --quiet) quiet=true; shift ;;
      *) shift ;;
    esac
  done

  local gh_cmd="${GH_CMD:-gh}"
  local bd_cmd="${BD_CMD:-bd}"

  # 1. Check gh auth status
  if ! "$gh_cmd" auth status >/dev/null 2>&1; then
    _hooks_error "GitHub CLI not authenticated. Run 'gh auth login'."
    return 1
  fi

  # 2. Check auto-sync config
  if ! _check_auto_sync_enabled; then
    # auto-sync disabled, skip silently
    return 0
  fi

  # 3. Get all in_progress issues
  local list_output
  list_output="$("$bd_cmd" list --status=in_progress 2>/dev/null)" || {
    if [[ "$quiet" == "false" ]]; then
      _hooks_warn "Failed to list issues, sync skipped"
    fi
    return 0
  }

  # Filter empty lines
  if [[ -z "$list_output" ]] || [[ -z "$(echo "$list_output" | tr -d '[:space:]')" ]]; then
    if [[ "$quiet" == "false" ]]; then
      _hooks_info "Nothing to sync"
    fi
    return 0
  fi

  # 4. For each issue, check for github_issue state and sync
  local synced=0
  local warnings=0

  while IFS= read -r line; do
    [[ -z "$line" ]] && continue

    # Extract issue id
    local issue_id
    issue_id="$(echo "$line" | grep -oE 'forge-[a-zA-Z0-9]+' | head -1)"
    [[ -z "$issue_id" ]] && continue

    # Get details to check for github_issue state
    local show_output
    show_output="$("$bd_cmd" show "$issue_id" 2>/dev/null)" || continue

    # Check if it has github_issue:N state
    local gh_issue_num
    gh_issue_num="$(printf '%s' "$show_output" | grep -oP 'github_issue:\K[0-9]+' | head -1 || true)"

    if [[ -z "$gh_issue_num" ]]; then
      # No GitHub issue linked, skip but warn
      warnings=$((warnings + 1))
      if [[ "$quiet" == "false" ]]; then
        _hooks_warn "No github_issue for $issue_id, sync skipped"
      fi
      continue
    fi

    # Sync status to in_progress on GitHub
    if sync_issue_status "$issue_id" "in_progress" 2>/dev/null; then
      synced=$((synced + 1))
    else
      warnings=$((warnings + 1))
      if [[ "$quiet" == "false" ]]; then
        _hooks_warn "Failed to sync $issue_id to GitHub"
      fi
    fi
  done <<< "$list_output"

  # 5. Report
  if [[ "$quiet" == "false" ]]; then
    if [[ "$synced" -gt 0 ]]; then
      _hooks_info "Synced $synced issues to GitHub"
    elif [[ "$warnings" -gt 0 ]]; then
      _hooks_warn "Sync completed with $warnings warnings"
    fi
  fi

  return 0
}

# forge_team_sync_on_stage <beads-id> <from-stage> <to-stage>
# Called after stage transitions. Syncs the specific issue.
# Stages: plan → dev → validate → ship → review → premerge → verify
forge_team_sync_on_stage() {
  local beads_id="${1:-}"
  local from_stage="${2:-}"
  local to_stage="${3:-}"

  if [[ -z "$beads_id" ]] || [[ -z "$from_stage" ]] || [[ -z "$to_stage" ]]; then
    _hooks_error "Usage: forge_team_sync_on_stage <beads-id> <from-stage> <to-stage>"
    return 1
  fi

  # Check auto-sync
  if ! _check_auto_sync_enabled; then
    return 0
  fi

  local status=""
  case "$to_stage" in
    dev)
      status="in_progress"
      ;;
    ship)
      status="in_progress"
      ;;
    verify)
      # Will be closed by /verify, skip sync
      _hooks_info "Stage verify: sync skipped (closed by /verify)"
      return 0
      ;;
    *)
      # Other stages: sync as in_progress if moving forward
      status="in_progress"
      ;;
  esac

  if [[ -n "$status" ]]; then
    if ! sync_issue_status "$beads_id" "$status" 2>/dev/null; then
      _hooks_warn "Failed to sync $beads_id status on stage transition $from_stage → $to_stage"
    fi
  fi

  return 0
}

# ── CLI entrypoint (for lefthook) ────────────────────────────────────────
# When called directly: bash hooks.sh sync [--quiet]
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
  case "${1:-}" in
    sync)
      shift
      forge_team_sync "$@"
      ;;
    *)
      echo "Usage: hooks.sh sync [--quiet]" >&2
      exit 1
      ;;
  esac
fi
