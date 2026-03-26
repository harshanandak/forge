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

cmd_dep() {
  if [[ $# -lt 1 ]]; then
    echo "Usage: pr-coordinator.sh dep <add|remove|list|list-all|set-pr> [args...]" >&2
    return 1
  fi

  local action="$1"
  shift

  case "$action" in
    add)
      # dep add <issue-a> <issue-b> — issue-a depends on issue-b
      if [[ $# -lt 2 ]]; then
        echo "Usage: pr-coordinator.sh dep add <issue-a> <issue-b>" >&2
        return 1
      fi
      local issue_a="$1" issue_b="$2"

      # Validate issue IDs
      [[ "$issue_a" =~ ^[a-zA-Z0-9-]+$ ]] || { echo "Error: invalid issue-id: $issue_a" >&2; return 2; }
      [[ "$issue_b" =~ ^[a-zA-Z0-9-]+$ ]] || { echo "Error: invalid issue-id: $issue_b" >&2; return 2; }

      # Add dependency
      local add_output
      add_output="$(${BD_CMD:-bd} dep add "$issue_a" "$issue_b" 2>&1)" || {
        echo "Error: failed to add dependency: $add_output" >&2
        return 1
      }

      # Check for cycles
      local cycles_output
      cycles_output="$(${BD_CMD:-bd} dep cycles 2>&1)" || true

      # Detect actual cycles (not "no cycles found" messages)
      if printf '%s' "$cycles_output" | grep -Eqi 'cycle' \
        && ! printf '%s' "$cycles_output" | grep -Eqi 'no cycles? found|no cycles? detected|no dependency cycles|0 dependency cycles|0 cycles'; then
        # Cycle detected — rollback
        ${BD_CMD:-bd} dep remove "$issue_a" "$issue_b" 2>/dev/null || true
        echo "Error: circular dependency detected — rolled back" >&2
        return 1
      fi

      echo "Dependency added: $issue_a depends on $issue_b"
      ;;

    remove)
      if [[ $# -lt 2 ]]; then
        echo "Usage: pr-coordinator.sh dep remove <issue-a> <issue-b>" >&2
        return 1
      fi
      local issue_a="$1" issue_b="$2"
      [[ "$issue_a" =~ ^[a-zA-Z0-9-]+$ ]] || { echo "Error: invalid issue-id: $issue_a" >&2; return 2; }
      [[ "$issue_b" =~ ^[a-zA-Z0-9-]+$ ]] || { echo "Error: invalid issue-id: $issue_b" >&2; return 2; }

      ${BD_CMD:-bd} dep remove "$issue_a" "$issue_b" 2>&1 || {
        echo "Error: failed to remove dependency" >&2
        return 1
      }
      echo "Dependency removed: $issue_a no longer depends on $issue_b"
      ;;

    list)
      if [[ $# -lt 1 ]]; then
        echo "Usage: pr-coordinator.sh dep list <issue-id>" >&2
        return 1
      fi
      local issue_id="$1"
      [[ "$issue_id" =~ ^[a-zA-Z0-9-]+$ ]] || { echo "Error: invalid issue-id: $issue_id" >&2; return 2; }

      local show_output
      show_output="$(${BD_CMD:-bd} show "$issue_id" 2>&1)" || {
        echo "Error: failed to show issue $issue_id" >&2
        return 1
      }

      # Parse DEPENDS ON section
      local deps
      deps="$(printf '%s' "$show_output" | sed -n '/^DEPENDS ON/,/^$/p' | grep -E '^\s+' | grep -v '^DEPENDS ON' || true)"

      if [[ -z "$deps" ]]; then
        echo "No dependencies for $issue_id"
      else
        echo "Dependencies for $issue_id:"
        printf '%s\n' "$deps"
      fi
      ;;

    list-all)
      local list_output
      list_output="$(${BD_CMD:-bd} list --status=open,in_progress 2>&1)" || {
        echo "Error: failed to list issues" >&2
        return 1
      }

      if [[ -z "$list_output" ]]; then
        echo "No open issues"
        return 0
      fi

      # For each issue, show its dependencies
      local issue_id
      while IFS= read -r line; do
        issue_id="$(printf '%s' "$line" | grep -oE '[a-z]+-[a-z0-9]+' | head -1)" || continue
        [[ -z "$issue_id" ]] && continue

        local show_out
        show_out="$(${BD_CMD:-bd} show "$issue_id" 2>&1)" || continue
        local deps
        deps="$(printf '%s' "$show_out" | sed -n '/^DEPENDS ON/,/^$/p' | grep -E '^\s+' | grep -v '^DEPENDS ON' || true)"

        if [[ -n "$deps" ]]; then
          echo "$issue_id:"
          printf '%s\n' "$deps"
          echo ""
        fi
      done <<< "$list_output"
      ;;

    set-pr)
      # Store PR number on issue: dep set-pr <issue-id> <pr-number>
      if [[ $# -lt 2 ]]; then
        echo "Usage: pr-coordinator.sh dep set-pr <issue-id> <pr-number>" >&2
        return 1
      fi
      local issue_id="$1" pr_number="$2"
      [[ "$issue_id" =~ ^[a-zA-Z0-9-]+$ ]] || { echo "Error: invalid issue-id: $issue_id" >&2; return 2; }
      validate_pr_number "$pr_number" || return 2

      ${BD_CMD:-bd} set-state "$issue_id" "pr_number=$pr_number" --reason "PR created by /ship" 2>&1 || {
        echo "Error: failed to store PR number" >&2
        return 1
      }
      echo "PR #$pr_number linked to $issue_id"
      ;;

    *)
      echo "Error: unknown dep action '$action'" >&2
      echo "Usage: pr-coordinator.sh dep <add|remove|list|list-all|set-pr>" >&2
      return 1
      ;;
  esac
}
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
