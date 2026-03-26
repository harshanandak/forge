#!/usr/bin/env bash
# pr-coordinator.sh — Parallel PR coordination: dependencies, merge order, simulation.
#
# Subcommands:
#   dep add|remove|list|list-all   PR dependency management
#   merge-sim <branch>             Merge simulation dry-run
#   merge-order                    Dependency-aware merge sequence
#   rebase-check                   Rebase guidance for open branches
#   auto-label <issue-id>          PR label auto-tagging
#   stale-worktrees                Abandoned worktree detection
#   help                           Show usage
#
# Exit codes: 0=success, 1=error, 2=validation error

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/lib/sanitize.sh" || { echo "FATAL: failed to source sanitize.sh" >&2; exit 2; }

# Source these but don't fail if missing (tests may not have them)
[[ -f "$SCRIPT_DIR/file-index.sh" ]] && source "$SCRIPT_DIR/file-index.sh"
[[ -f "$SCRIPT_DIR/sync-utils.sh" ]] && source "$SCRIPT_DIR/sync-utils.sh"

# ── Stub implementations (replaced in Tasks 6-11) ────────────────────

cmd_dep() { echo "dep: not implemented"; }
cmd_merge_sim() { echo "merge-sim: not implemented"; }
cmd_merge_order() { echo "merge-order: not implemented"; }
cmd_rebase_check() { echo "rebase-check: not implemented"; }
cmd_auto_label() { echo "auto-label: not implemented"; }
cmd_stale_worktrees() { echo "stale-worktrees: not implemented"; }

cmd_help() {
  cat <<'EOF'
Usage: pr-coordinator.sh <subcommand> [args...]

Subcommands:
  dep add <issue-a> <issue-b>    Record issue-a depends on issue-b
  dep remove <issue-a> <issue-b> Remove dependency
  dep list <issue-id>            Show dependencies for issue
  dep list-all                   Show all open issues with dependencies
  merge-sim <branch>             Dry-run merge simulation
  merge-order [--format=text|json] Recommended merge sequence
  rebase-check [--after-merge=<branch>] Rebase guidance
  auto-label <issue-id>          Auto-tag PR labels
  stale-worktrees [--threshold=48h] Detect abandoned worktrees
  help                           Show this message
EOF
}

# ── Main dispatcher ──────────────────────────────────────────────────

main() {
  if [[ $# -lt 1 ]]; then
    cmd_help >&2
    exit 1
  fi

  local subcommand="$1"
  shift

  case "$subcommand" in
    dep)           cmd_dep "$@" ;;
    merge-sim)
      # Validate branch name if provided
      if [[ $# -ge 1 ]]; then
        validate_branch_name "$1" || exit 2
      fi
      cmd_merge_sim "$@"
      ;;
    merge-order)   cmd_merge_order "$@" ;;
    rebase-check)  cmd_rebase_check "$@" ;;
    auto-label)
      # Validate issue-id if provided
      if [[ $# -ge 1 ]] && [[ ! "$1" =~ ^[a-zA-Z0-9-]+$ ]]; then
        echo "Error: invalid issue-id format" >&2
        exit 2
      fi
      cmd_auto_label "$@"
      ;;
    stale-worktrees) cmd_stale_worktrees "$@" ;;
    help)          cmd_help ;;
    *)
      echo "Error: unknown subcommand '$subcommand'" >&2
      cmd_help >&2
      exit 1
      ;;
  esac
}

main "$@"
