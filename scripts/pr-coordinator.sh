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
cmd_merge_sim() {
  if [[ $# -lt 1 ]]; then
    echo "Usage: pr-coordinator.sh merge-sim <branch> [--base=<base>]" >&2
    return 1
  fi

  local branch="$1"
  shift
  local base="master"

  # Parse optional --base flag
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --base=*) base="${1#--base=}"; shift ;;
      *) echo "Error: unknown flag '$1'" >&2; return 1 ;;
    esac
  done

  # Validate branch names (defense in depth — dispatcher also validates)
  validate_branch_name "$branch" || return 2
  validate_branch_name "$base" || return 2

  # Verify branches exist
  if ! git rev-parse --verify "$branch" &>/dev/null; then
    echo "Error: branch '$branch' does not exist" >&2
    return 1
  fi
  if ! git rev-parse --verify "$base" &>/dev/null; then
    echo "Error: base branch '$base' does not exist" >&2
    return 1
  fi

  # Save current state
  local original_branch
  original_branch="$(git rev-parse --abbrev-ref HEAD)"
  local original_head
  original_head="$(git rev-parse HEAD)"

  # Set up trap for crash recovery — ALWAYS clean up
  trap '_merge_sim_cleanup "$original_branch" "$original_head"' EXIT ERR INT TERM

  # Checkout base branch (detached to avoid moving branch pointer)
  git checkout --detach "$base" 2>/dev/null || {
    echo "Error: failed to checkout base '$base'" >&2
    trap - EXIT ERR INT TERM
    return 1
  }

  # Attempt merge
  local merge_output
  if merge_output="$(git merge --no-commit --no-ff "$branch" 2>&1)"; then
    # Clean merge — no conflicts
    git merge --abort 2>/dev/null || true
    git checkout "$original_branch" 2>/dev/null || git checkout "$original_head" 2>/dev/null
    trap - EXIT ERR INT TERM
    echo "No conflicts detected with $base"
    return 0
  else
    # Conflicts detected
    local conflicted_files
    conflicted_files="$(git diff --name-only --diff-filter=U 2>/dev/null || true)"
    git merge --abort 2>/dev/null || true
    git checkout "$original_branch" 2>/dev/null || git checkout "$original_head" 2>/dev/null
    trap - EXIT ERR INT TERM

    if [[ -n "$conflicted_files" ]]; then
      echo "Conflicts detected with $base:"
      printf '%s\n' "$conflicted_files"
    else
      echo "Merge failed (non-conflict reason):"
      printf '%s\n' "$merge_output"
    fi
    return 1
  fi
}

_merge_sim_cleanup() {
  local original_branch="$1"
  local original_head="$2"
  git merge --abort 2>/dev/null || true
  git checkout "$original_branch" 2>/dev/null || git checkout "$original_head" 2>/dev/null || true
}
cmd_merge_order() {
  local format="text"

  # Parse flags
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --format=*) format="${1#--format=}"; shift ;;
      *) echo "Error: unknown flag '$1'" >&2; return 1 ;;
    esac
  done

  # Check for cycles first
  local cycles_output
  cycles_output="$(${BD_CMD:-bd} dep cycles 2>&1)" || true
  if printf '%s' "$cycles_output" | grep -Eqi 'cycle' \
    && ! printf '%s' "$cycles_output" | grep -Eqi 'no cycles? found|no cycles? detected|no dependency cycles|0 dependency cycles|0 cycles'; then
    echo "Error: dependency cycle detected — cannot compute merge order" >&2
    printf '%s\n' "$cycles_output" >&2
    return 1
  fi

  # Get all open/in_progress issues
  local issues_output
  issues_output="$(${BD_CMD:-bd} list --status=open,in_progress 2>&1)" || {
    echo "Error: failed to list issues" >&2
    return 1
  }

  if [[ -z "$issues_output" ]]; then
    echo "Nothing to merge — no open issues"
    return 0
  fi

  # Extract issue IDs
  local -a all_issues=()
  while IFS= read -r line; do
    local id
    id="$(printf '%s' "$line" | grep -oE '[a-z]+-[a-z0-9]+' | head -1)" || continue
    [[ -n "$id" ]] && all_issues+=("$id")
  done <<< "$issues_output"

  if [[ ${#all_issues[@]} -eq 0 ]]; then
    echo "Nothing to merge — no open issues"
    return 0
  fi

  # Build adjacency list and in-degree count
  # dependency: A depends on B means B must merge before A
  # So edge is B -> A (B blocks A)
  local -A in_degree=()
  local -A adj=()  # adj[B] = "A1 A2 A3" (B blocks these)

  for id in "${all_issues[@]}"; do
    in_degree[$id]=0
    adj[$id]=""
  done

  # For each issue, get its dependencies
  for id in "${all_issues[@]}"; do
    local show_out
    show_out="$(${BD_CMD:-bd} show "$id" 2>&1)" || continue

    # Parse DEPENDS ON section — extract issue IDs
    local deps
    deps="$(printf '%s' "$show_out" | sed -n '/^DEPENDS ON/,/^$/p' | grep -oE '[a-z]+-[a-z0-9]+' || true)"

    while IFS= read -r dep_id; do
      [[ -z "$dep_id" ]] && continue
      # Only count deps that are in our open issues list
      local found=0
      for oid in "${all_issues[@]}"; do
        if [[ "$oid" == "$dep_id" ]]; then
          found=1
          break
        fi
      done
      [[ "$found" -eq 0 ]] && continue

      # dep_id blocks id (dep_id must merge first)
      in_degree[$id]=$(( ${in_degree[$id]} + 1 ))
      adj[$dep_id]="${adj[$dep_id]} $id"
    done <<< "$deps"
  done

  # Kahn's algorithm
  local -a queue=()
  local -a result=()

  # Find all nodes with in-degree 0
  for id in "${all_issues[@]}"; do
    if [[ "${in_degree[$id]}" -eq 0 ]]; then
      queue+=("$id")
    fi
  done

  while [[ ${#queue[@]} -gt 0 ]]; do
    # Pop first element
    local current="${queue[0]}"
    queue=("${queue[@]:1}")
    result+=("$current")

    # Reduce in-degree of neighbors
    for neighbor in ${adj[$current]}; do
      in_degree[$neighbor]=$(( ${in_degree[$neighbor]} - 1 ))
      if [[ "${in_degree[$neighbor]}" -eq 0 ]]; then
        queue+=("$neighbor")
      fi
    done
  done

  # Output
  if [[ "$format" == "json" ]]; then
    printf '%s\n' "${result[@]}" | jq -R . | jq -s -c '.'
  else
    if [[ ${#result[@]} -eq 0 ]]; then
      echo "Nothing to merge"
    elif [[ ${#result[@]} -eq 1 ]]; then
      echo "Ready to merge: ${result[0]}"
    else
      # Check if all are independent (all in-degree 0 initially)
      local all_independent=1
      for id in "${all_issues[@]}"; do
        local show_out
        show_out="$(${BD_CMD:-bd} show "$id" 2>&1)" || continue
        local deps
        deps="$(printf '%s' "$show_out" | sed -n '/^DEPENDS ON/,/^$/p' | grep -oE '[a-z]+-[a-z0-9]+' || true)"
        # Check if any dep is in our open list
        while IFS= read -r dep_id; do
          [[ -z "$dep_id" ]] && continue
          for oid in "${all_issues[@]}"; do
            if [[ "$oid" == "$dep_id" ]]; then
              all_independent=0
              break 2
            fi
          done
        done <<< "$deps"
        [[ "$all_independent" -eq 0 ]] && break
      done

      if [[ "$all_independent" -eq 1 ]]; then
        echo "Can merge in any order:"
        local i=1
        for id in "${result[@]}"; do
          echo "  $i. $id"
          i=$((i + 1))
        done
      else
        echo "Recommended merge order:"
        local i=1
        for id in "${result[@]}"; do
          echo "  $i. $id"
          i=$((i + 1))
        done
      fi
    fi
  fi
}
cmd_rebase_check() {
  local after_merge=""
  local base="master"

  while [[ $# -gt 0 ]]; do
    case "$1" in
      --after-merge=*) after_merge="${1#--after-merge=}"; shift ;;
      --base=*) base="${1#--base=}"; shift ;;
      *) echo "Error: unknown flag '$1'" >&2; return 1 ;;
    esac
  done

  # Get list of feature branches (not merged into base)
  local branches
  branches="$(git branch --no-merged "$base" --format='%(refname:short)' 2>/dev/null | grep -v '^HEAD' || true)"

  if [[ -z "$branches" ]]; then
    echo "No branches need rebasing"
    return 0
  fi

  local found_any=0

  while IFS= read -r branch; do
    [[ -z "$branch" ]] && continue
    [[ "$branch" == "$base" ]] && continue

    # Files changed on the branch (relative to base)
    local branch_files
    branch_files="$(git log --name-only --pretty=format: "$base".."$branch" 2>/dev/null | sort -u | grep -v '^$' || true)"

    # Files changed on base since branch diverged
    local base_files
    if [[ -n "$after_merge" ]]; then
      # Only check overlap with specific merged branch's changes
      base_files="$(git log --name-only --pretty=format: "$branch".."$after_merge" 2>/dev/null | sort -u | grep -v '^$' || true)"
    else
      base_files="$(git log --name-only --pretty=format: "$branch".."$base" 2>/dev/null | sort -u | grep -v '^$' || true)"
    fi

    if [[ -z "$base_files" ]]; then
      continue  # Branch is up-to-date with base
    fi

    # Check for file overlap
    local overlap
    overlap="$(comm -12 <(printf '%s\n' "$branch_files" | sort) <(printf '%s\n' "$base_files" | sort) 2>/dev/null || true)"

    found_any=1
    if [[ -n "$overlap" ]]; then
      echo "CONFLICT REBASE: $branch"
      echo "  Overlapping files:"
      printf '%s\n' "$overlap" | while IFS= read -r f; do
        [[ -z "$f" ]] && continue
        echo "    - $f"
      done
    else
      echo "CLEAN REBASE: $branch (behind but no file overlap)"
    fi
  done <<< "$branches"

  if [[ "$found_any" -eq 0 ]]; then
    echo "No branches need rebasing"
  fi

  return 0
}
cmd_auto_label() {
  if [[ $# -lt 1 ]]; then
    echo "Usage: pr-coordinator.sh auto-label <issue-id>" >&2
    return 1
  fi

  local issue_id="$1"

  # Get issue details
  local show_output
  show_output="$(${BD_CMD:-bd} show "$issue_id" 2>&1)" || {
    echo "Error: failed to show issue $issue_id" >&2
    return 1
  }

  # Get PR number from bd state metadata (pr_number:NNN in show output)
  local pr_number=""
  pr_number="$(printf '%s' "$show_output" | grep -oE 'pr_number:[0-9]+' | head -1 | cut -d: -f2 || true)"

  if [[ -z "$pr_number" ]]; then
    echo "No PR found for $issue_id, skipping labels"
    return 0
  fi

  # Validate PR number
  validate_pr_number "$pr_number" || return 2

  # Determine label state
  local has_deps=0
  local blocks_others=0
  local needs_rebase=0

  # Check DEPENDS ON section
  if printf '%s' "$show_output" | grep -q '^DEPENDS ON'; then
    local dep_lines
    dep_lines="$(printf '%s' "$show_output" | sed -n '/^DEPENDS ON/,/^$/p' | grep -E '^\s+' || true)"
    [[ -n "$dep_lines" ]] && has_deps=1
  fi

  # Check BLOCKS section
  if printf '%s' "$show_output" | grep -q '^BLOCKS'; then
    local block_lines
    block_lines="$(printf '%s' "$show_output" | sed -n '/^BLOCKS/,/^$/p' | grep -E '^\s+' || true)"
    [[ -n "$block_lines" ]] && blocks_others=1
  fi

  # Check if branch needs rebase (behind base)
  local pr_branch=""
  pr_branch="$(printf '%s' "$show_output" | grep -oE 'pr_branch:[a-zA-Z0-9./_@-]+' | head -1 | cut -d: -f2 || true)"
  if [[ -n "$pr_branch" ]]; then
    local base="master"
    local behind_count
    behind_count="$(git rev-list --count "$pr_branch".."$base" 2>/dev/null || echo 0)"
    [[ "$behind_count" -gt 0 ]] && needs_rebase=1
  fi

  # Apply or remove labels
  local GH_CMD="${GH_CMD:-gh}"
  local labels_added=()
  local labels_removed=()

  if [[ "$has_deps" -eq 1 ]]; then
    $GH_CMD pr edit "$pr_number" --add-label "forge/has-deps" 2>/dev/null && labels_added+=("forge/has-deps") || true
  else
    $GH_CMD pr edit "$pr_number" --remove-label "forge/has-deps" 2>/dev/null && labels_removed+=("forge/has-deps") || true
  fi

  if [[ "$blocks_others" -eq 1 ]]; then
    $GH_CMD pr edit "$pr_number" --add-label "forge/blocks-others" 2>/dev/null && labels_added+=("forge/blocks-others") || true
  else
    $GH_CMD pr edit "$pr_number" --remove-label "forge/blocks-others" 2>/dev/null && labels_removed+=("forge/blocks-others") || true
  fi

  if [[ "$needs_rebase" -eq 1 ]]; then
    $GH_CMD pr edit "$pr_number" --add-label "forge/needs-rebase" 2>/dev/null && labels_added+=("forge/needs-rebase") || true
  else
    $GH_CMD pr edit "$pr_number" --remove-label "forge/needs-rebase" 2>/dev/null && labels_removed+=("forge/needs-rebase") || true
  fi

  # Report
  if [[ ${#labels_added[@]} -gt 0 ]]; then
    echo "Labels added: ${labels_added[*]}"
  fi
  if [[ ${#labels_removed[@]} -gt 0 ]]; then
    echo "Labels removed: ${labels_removed[*]}"
  fi
  if [[ ${#labels_added[@]} -eq 0 ]] && [[ ${#labels_removed[@]} -eq 0 ]]; then
    echo "No label changes needed for PR #$pr_number"
  fi
}
cmd_stale_worktrees() {
  local threshold_hours=48
  local worktrees_dir=".worktrees"

  while [[ $# -gt 0 ]]; do
    case "$1" in
      --threshold=*)
        local val="${1#--threshold=}"
        # Parse hours: "48h" -> 48, "72h" -> 72, just a number -> hours
        threshold_hours="${val%h}"
        if [[ ! "$threshold_hours" =~ ^[0-9]+$ ]]; then
          echo "Error: invalid threshold '$val' (use e.g. 48h or 48)" >&2
          return 1
        fi
        shift ;;
      --dir=*) worktrees_dir="${1#--dir=}"; shift ;;
      *) echo "Error: unknown flag '$1'" >&2; return 1 ;;
    esac
  done

  local repo_root
  repo_root="$(git rev-parse --show-toplevel 2>/dev/null)" || repo_root="."
  local wt_path="$repo_root/$worktrees_dir"

  if [[ ! -d "$wt_path" ]]; then
    echo "No worktrees found (directory $worktrees_dir does not exist)"
    return 0
  fi

  # OWASP A01: validate each worktree path with realpath
  local found_any=0
  local stale_count=0

  for entry in "$wt_path"/*/; do
    [[ -d "$entry" ]] || continue
    found_any=1

    # Resolve real path and verify it's under repo root
    local real_path
    real_path="$(realpath "$entry" 2>/dev/null)" || continue
    local real_root
    real_root="$(realpath "$repo_root" 2>/dev/null)" || continue

    if [[ "$real_path" != "$real_root"* ]]; then
      echo "WARNING: skipping symlink outside repo: $entry" >&2
      continue
    fi

    # Get last commit date
    local last_commit_date
    last_commit_date="$(git -C "$entry" log -1 --format=%ci 2>/dev/null)" || continue

    # Get branch name
    local branch_name
    branch_name="$(git -C "$entry" branch --show-current 2>/dev/null)" || branch_name="unknown"

    # Calculate age in hours
    local last_epoch now_epoch
    last_epoch="$(date -d "$last_commit_date" +%s 2>/dev/null || date -jf "%Y-%m-%d %H:%M:%S %z" "$last_commit_date" +%s 2>/dev/null || echo 0)"
    now_epoch="$(date +%s)"
    local age_hours=$(( (now_epoch - last_epoch) / 3600 ))

    if [[ "$age_hours" -ge "$threshold_hours" ]]; then
      stale_count=$((stale_count + 1))
      local dir_name
      dir_name="$(basename "$entry")"
      echo "STALE: $dir_name (branch: $branch_name, last commit: ${age_hours}h ago)"
    fi
  done

  if [[ "$found_any" -eq 0 ]]; then
    echo "No worktrees found"
  elif [[ "$stale_count" -eq 0 ]]; then
    echo "All worktrees are active"
  else
    echo ""
    echo "$stale_count potentially abandoned worktree(s) found"
  fi

  return 0  # Always exit 0 (informational only)
}

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
