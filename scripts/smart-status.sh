#!/usr/bin/env bash
# smart-status.sh — Workflow intelligence scoring engine
#
# Reads issues via `bd list --json --limit 0`, computes a composite score
# for each issue, and outputs them sorted by score descending.
#
# Composite score:
#   priority_weight * unblock_chain * type_weight * status_boost * epic_proximity * staleness_boost
#
# Usage:
#   smart-status.sh [--json]
#
# Environment:
#   BD_CMD  — override the bd command (for testing with mocks)
#
# Cross-platform: bash 3.2 compatible (no associative arrays, no mapfile).
# OWASP A03: All variables quoted, sanitize() strips injection patterns.

set -euo pipefail

# ── Helpers ──────────────────────────────────────────────────────────────

# Sanitize a string: strip shell-injection patterns (OWASP A03)
# Removes: double quotes, $(...), backticks, semicolons, and newlines
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
  # Collapse newlines to spaces
  val="$(printf '%s' "$val" | tr '\n' ' ')"
  printf '%s' "$val"
}

# ── Dependency check ────────────────────────────────────────────────────

if ! command -v jq &>/dev/null; then
  echo "Error: jq is required but not found." >&2
  echo "Install jq:" >&2
  echo "  macOS:   brew install jq" >&2
  echo "  Ubuntu:  sudo apt-get install jq" >&2
  echo "  Windows: winget install jqlang.jq" >&2
  exit 1
fi

# ── Configuration ───────────────────────────────────────────────────────

BD="${BD_CMD:-bd}"
GIT="${GIT_CMD:-git}"
JSON_MODE=0

# Parse arguments (bash 3.2 compatible — no associative arrays)
for arg in "$@"; do
  case "$arg" in
    --json) JSON_MODE=1 ;;
    --help|-h)
      echo "Usage: smart-status.sh [--json]"
      echo ""
      echo "Scores and ranks issues by composite priority score."
      echo ""
      echo "Options:"
      echo "  --json   Output raw scored JSON array"
      echo "  --help   Show this help message"
      exit 0
      ;;
    *)
      echo "Error: unknown argument: $(sanitize "$arg")" >&2
      exit 1
      ;;
  esac
done

# ── Fetch issues ────────────────────────────────────────────────────────

ISSUES_JSON="$("$BD" list --json --limit 0 2>/dev/null || echo '[]')"

# Bail early on empty
if [ "$(printf '%s' "$ISSUES_JSON" | jq 'length')" = "0" ]; then
  if [ "$JSON_MODE" = "1" ]; then
    echo "[]"
  else
    echo "No issues found."
  fi
  exit 0
fi

# ── Identify epics and fetch their children ─────────────────────────────

# Extract epic IDs (type == "epic")
EPIC_IDS="$(printf '%s' "$ISSUES_JSON" | jq -r '.[] | select(.type == "epic") | .id')"

# Build a JSON object mapping epic_id -> { closed, total }
EPIC_STATS="{}"
if [ -n "$EPIC_IDS" ]; then
  # Process each epic (bash 3.2 compatible — read line by line)
  while IFS= read -r epic_id; do
    [ -z "$epic_id" ] && continue
    CHILDREN_JSON="$("$BD" children "$epic_id" --json 2>/dev/null || echo '[]')"
    TOTAL="$(printf '%s' "$CHILDREN_JSON" | jq 'length')"
    CLOSED="$(printf '%s' "$CHILDREN_JSON" | jq '[.[] | select(.status == "closed")] | length')"
    EPIC_STATS="$(printf '%s' "$EPIC_STATS" | jq --arg id "$epic_id" --argjson total "$TOTAL" --argjson closed "$CLOSED" '. + {($id): {total: $total, closed: $closed}}')"
  done <<EOF
$EPIC_IDS
EOF
fi

# ── Score issues with jq ────────────────────────────────────────────────

SCORED_JSON="$(printf '%s' "$ISSUES_JSON" | jq --argjson epic_stats "$EPIC_STATS" '
  [.[] | . as $issue |

    # Priority weight: P0=5, P1=4, P2=3, P3=2, P4=1, default=1
    (if .priority == "P0" then 5
     elif .priority == "P1" then 4
     elif .priority == "P2" then 3
     elif .priority == "P3" then 2
     elif .priority == "P4" then 1
     else 1 end) as $priority_weight |

    # Unblock chain: dependent_count + 1 (min 1)
    (((.dependent_count // 0) + 1) | if . < 1 then 1 else . end) as $unblock_chain |

    # Type weight: bug=1.2, feature=1.0, task=0.8, default=1.0
    (if .type == "bug" then 1.2
     elif .type == "feature" then 1.0
     elif .type == "task" then 0.8
     else 1.0 end) as $type_weight |

    # Status boost: in_progress=1.5, open=1.0, default=1.0
    (if .status == "in_progress" then 1.5
     elif .status == "open" then 1.0
     else 1.0 end) as $status_boost |

    # Epic proximity: if issue has parent_id that is an epic, compute
    # 1.0 + (closed_siblings / total_siblings) * 0.5
    (if (.parent_id // "") != "" and ($epic_stats[.parent_id] // null) != null then
       $epic_stats[.parent_id] as $es |
       if $es.total > 0 then
         1.0 + (($es.closed / $es.total) * 0.5)
       else 1.0 end
     else 1.0 end) as $epic_proximity |

    # Staleness boost based on updated_at
    # 0-7d=1.0, 7-14d=1.1, 14-30d=1.2, 30+d=1.5
    # Strip fractional seconds (.NNZ) before parsing — jq fromdateiso8601
    # only accepts "%Y-%m-%dT%H:%M:%SZ" format
    (if .updated_at then
       ((.updated_at | sub("\\.[0-9]+Z$"; "Z")) | fromdateiso8601) as $ts |
       ((now - $ts) / 86400) as $days |
       if $days >= 30 then 1.5
       elif $days >= 14 then 1.2
       elif $days >= 7 then 1.1
       else 1.0 end
     else 1.0 end) as $staleness_boost |

    # Composite score
    ($priority_weight * $unblock_chain * $type_weight * $status_boost * $epic_proximity * $staleness_boost) as $score |

    # Output scored issue
    $issue + {
      score: ($score * 100 | round / 100),
      priority_weight: $priority_weight,
      unblock_chain: $unblock_chain,
      type_weight: $type_weight,
      status_boost: $status_boost,
      epic_proximity: (($epic_proximity * 100 | round) / 100),
      staleness_boost: $staleness_boost
    }
  ] | sort_by(-.score)
')"

# ── Session detection ─────────────────────────────────────────────────

# Parse git worktree list --porcelain to find active sessions
# Format: blocks separated by blank lines, each block has:
#   worktree <path>
#   HEAD <sha>
#   branch refs/heads/<branch>

WORKTREE_PORCELAIN="$("$GIT" worktree list --porcelain 2>/dev/null || echo '')"

# Collect non-main worktree branches and paths
SESSION_BRANCHES=""
SESSION_PATHS=""
SESSION_COUNT=0

_wt_path=""
_wt_branch=""
while IFS= read -r line; do
  case "$line" in
    worktree\ *)
      _wt_path="${line#worktree }"
      ;;
    branch\ *)
      _wt_branch="${line#branch refs/heads/}"
      ;;
    "")
      # End of block — process if we have a branch that is not main/master
      if [ -n "$_wt_branch" ] && [ "$_wt_branch" != "main" ] && [ "$_wt_branch" != "master" ]; then
        SESSION_COUNT=$((SESSION_COUNT + 1))
        if [ -n "$SESSION_BRANCHES" ]; then
          SESSION_BRANCHES="${SESSION_BRANCHES}|${_wt_branch}"
          SESSION_PATHS="${SESSION_PATHS}|${_wt_path}"
        else
          SESSION_BRANCHES="${_wt_branch}"
          SESSION_PATHS="${_wt_path}"
        fi
      fi
      _wt_path=""
      _wt_branch=""
      ;;
  esac
done <<EOF
${WORKTREE_PORCELAIN}

EOF

# Get in-progress issues for matching (only if we have sessions)
IN_PROGRESS_JSON="[]"
if [ "$SESSION_COUNT" -gt 0 ]; then
  IN_PROGRESS_JSON="$("$BD" list --status in_progress --json --limit 0 2>/dev/null || echo '[]')"
  # Fallback: if bd doesn't support --status flag, filter from full list
  if [ "$(printf '%s' "$IN_PROGRESS_JSON" | jq 'length' 2>/dev/null)" = "0" ] || [ -z "$IN_PROGRESS_JSON" ]; then
    IN_PROGRESS_JSON="$(printf '%s' "$ISSUES_JSON" | jq '[.[] | select(.status == "in_progress")]')"
  fi
fi

# Build sessions data: for each branch, find matching in-progress issues
# Match by: branch slug (after feat/, fix/, docs/) appears in issue title (case-insensitive, hyphen-to-space)
SESSIONS_JSON="[]"
if [ "$SESSION_COUNT" -gt 0 ]; then
  # Process each session
  _idx=0
  _remaining_branches="$SESSION_BRANCHES"
  _remaining_paths="$SESSION_PATHS"
  while [ -n "$_remaining_branches" ]; do
    # Extract first branch and path (delimited by |)
    case "$_remaining_branches" in
      *"|"*)
        _branch="${_remaining_branches%%|*}"
        _remaining_branches="${_remaining_branches#*|}"
        _path="${_remaining_paths%%|*}"
        _remaining_paths="${_remaining_paths#*|}"
        ;;
      *)
        _branch="$_remaining_branches"
        _remaining_branches=""
        _path="$_remaining_paths"
        _remaining_paths=""
        ;;
    esac

    # Extract slug from branch name (strip feat/, fix/, docs/ prefix)
    _slug="$_branch"
    case "$_slug" in
      feat/*) _slug="${_slug#feat/}" ;;
      fix/*) _slug="${_slug#fix/}" ;;
      docs/*) _slug="${_slug#docs/}" ;;
    esac

    # Convert slug hyphens to spaces for title matching
    _slug_spaces="$(printf '%s' "$_slug" | tr '-' ' ')"

    # Find matching in-progress issues: title contains slug words (case-insensitive)
    _matched_ids="$(printf '%s' "$IN_PROGRESS_JSON" | jq -r --arg slug "$_slug_spaces" '
      [.[] | select(
        (.title | ascii_downcase | contains($slug | ascii_downcase))
      ) | .id] | join(",")
    ')"

    _issue_count=0
    if [ -n "$_matched_ids" ]; then
      # Count commas + 1
      _issue_count="$(printf '%s' "$_matched_ids" | tr -cd ',' | wc -c)"
      _issue_count=$((_issue_count + 1))
    fi

    # Build session JSON entry
    if [ -n "$_matched_ids" ]; then
      _ids_json="$(printf '%s' "$_matched_ids" | jq -R 'split(",")')"
    else
      _ids_json="[]"
    fi

    SESSIONS_JSON="$(printf '%s' "$SESSIONS_JSON" | jq \
      --arg branch "$_branch" \
      --arg path "$_path" \
      --argjson ids "$_ids_json" \
      --argjson count "$_issue_count" \
      '. + [{branch: $branch, path: $path, issue_ids: $ids, issue_count: $count}]'
    )"

    _idx=$((_idx + 1))
  done
fi

# ── File-level conflict detection ────────────────────────────────────────
# For each active worktree branch, get changed files via:
#   git diff master...<branch> --name-only --
# Uses -- separator to prevent argument injection (OWASP A03)

# ALL_BRANCH_FILES: pipe-delimited list of "branch:file1,file2,..."
ALL_BRANCH_FILES=""
if [ "$SESSION_COUNT" -ge 2 ]; then
  _remaining_branches="$SESSION_BRANCHES"
  while [ -n "$_remaining_branches" ]; do
    case "$_remaining_branches" in
      *"|"*)
        _branch="${_remaining_branches%%|*}"
        _remaining_branches="${_remaining_branches#*|}"
        ;;
      *)
        _branch="$_remaining_branches"
        _remaining_branches=""
        ;;
    esac

    # Get changed files for this branch vs master (-- prevents injection)
    _files="$("$GIT" diff "master...${_branch}" --name-only -- 2>/dev/null || echo '')"
    # Collapse to comma-delimited, strip empty lines
    _files_csv="$(printf '%s' "$_files" | tr '\n' ',' | sed 's/,$//' | sed 's/^,//')"

    if [ -n "$ALL_BRANCH_FILES" ]; then
      ALL_BRANCH_FILES="${ALL_BRANCH_FILES}|${_branch}:${_files_csv}"
    else
      ALL_BRANCH_FILES="${_branch}:${_files_csv}"
    fi
  done

  # Build conflict map: find files that appear in multiple branches
  # and add changed_files + conflicts to SESSIONS_JSON
  _remaining="$ALL_BRANCH_FILES"
  while [ -n "$_remaining" ]; do
    case "$_remaining" in
      *"|"*)
        _entry="${_remaining%%|*}"
        _remaining="${_remaining#*|}"
        ;;
      *)
        _entry="$_remaining"
        _remaining=""
        ;;
    esac

    _branch="${_entry%%:*}"
    _files_csv="${_entry#*:}"

    # Convert comma-delimited files to JSON array
    if [ -n "$_files_csv" ]; then
      _files_json="$(printf '%s' "$_files_csv" | jq -R 'split(",")')"
    else
      _files_json="[]"
    fi

    # Find conflicts: files in this branch that also appear in other branches
    _conflicts_json="[]"
    _remaining_other="$ALL_BRANCH_FILES"
    while [ -n "$_remaining_other" ]; do
      case "$_remaining_other" in
        *"|"*)
          _other_entry="${_remaining_other%%|*}"
          _remaining_other="${_remaining_other#*|}"
          ;;
        *)
          _other_entry="$_remaining_other"
          _remaining_other=""
          ;;
      esac

      _other_branch="${_other_entry%%:*}"
      _other_files="${_other_entry#*:}"

      # Skip self
      [ "$_other_branch" = "$_branch" ] && continue
      [ -z "$_other_files" ] && continue

      # Find intersection
      _other_json="$(printf '%s' "$_other_files" | jq -R 'split(",")')"
      _overlap="$(jq -n --argjson a "$_files_json" --argjson b "$_other_json" \
        '[$a[] as $f | select($b | index($f))] | unique')"
      _overlap_len="$(printf '%s' "$_overlap" | jq 'length')"
      if [ "$_overlap_len" -gt 0 ]; then
        _conflicts_json="$(jq -n \
          --argjson existing "$_conflicts_json" \
          --arg other_branch "$_other_branch" \
          --argjson files "$_overlap" \
          '$existing + [{branch: $other_branch, files: $files}]')"
      fi
    done

    # Update SESSIONS_JSON: add changed_files and conflicts to matching branch entry
    SESSIONS_JSON="$(printf '%s' "$SESSIONS_JSON" | jq \
      --arg branch "$_branch" \
      --argjson files "$_files_json" \
      --argjson conflicts "$_conflicts_json" \
      '[.[] | if .branch == $branch then . + {changed_files: $files, conflicts: $conflicts} else . end]'
    )"
  done
fi

# ── Output ──────────────────────────────────────────────────────────────

if [ "$JSON_MODE" = "1" ]; then
  if [ "$SESSION_COUNT" -gt 0 ]; then
    # Wrap scored issues and sessions together
    jq -n --argjson sessions "$SESSIONS_JSON" --argjson issues "$SCORED_JSON" \
      '{sessions: $sessions, issues: $issues}'
  else
    printf '%s\n' "$SCORED_JSON"
  fi
else
  # Grouped, colored output
  # NO_COLOR support: https://no-color.org/
  if [ -n "${NO_COLOR:-}" ]; then
    C_RESET="" C_GREEN="" C_YELLOW="" C_RED="" C_DIM="" C_BOLD="" C_CYAN=""
  else
    C_RESET=$'\033[0m' C_GREEN=$'\033[32m' C_YELLOW=$'\033[33m'
    C_RED=$'\033[31m' C_DIM=$'\033[2m' C_BOLD=$'\033[1m' C_CYAN=$'\033[36m'
  fi

  # ── Active Sessions (before grouped output) ──
  if [ "$SESSION_COUNT" -gt 0 ]; then
    printf '%s%s=== ACTIVE SESSIONS ===%s\n' "$C_BOLD" "$C_CYAN" "$C_RESET"
    printf '%s' "$SESSIONS_JSON" | jq -r '.[] |
      .branch as $branch |
      .issue_ids as $ids |
      .issue_count as $count |
      .changed_files as $files |
      .conflicts as $conflicts |
      # Branch line
      (if $count > 0 then
        "  " + $branch + " -> " + ($ids | join(", ")) + " (" + ($count | tostring) + " issue" + (if $count > 1 then "s" else "" end) + ")"
      else
        "  " + $branch + " (untracked)"
      end),
      # Changed files line (up to 3, then +N more)
      (if ($files // [] | length) > 0 then
        ($files | length) as $total |
        (if $total > 3 then
          "    Changed: " + ($files[:3] | join(", ")) + " (+" + (($total - 3) | tostring) + " more)"
        else
          "    Changed: " + ($files | join(", "))
        end)
      else empty end),
      # Conflict risk annotations
      (if ($conflicts // [] | length) > 0 then
        ($conflicts[] |
          .branch as $other |
          .files[] |
          "    ! Conflict risk: " + . + " (" + $other + " in-progress)"
        )
      else empty end)
    '
    printf '\n'
  fi

  # Use jq to assign groups and format, then bash to colorize
  printf '%s\n' "$SCORED_JSON" | jq -r --arg now "$(date +%s)" '
    # Assign group to each issue
    [.[] | . as $item |
      # Compute days since updated_at
      (if .updated_at then
        ((.updated_at | sub("\\.[0-9]+Z$"; "Z")) | fromdateiso8601) as $ts |
        (($now | tonumber) - $ts) / 86400 | floor
       else 0 end) as $days_ago |
      # Group assignment (priority order: RESUME > UNBLOCK_CHAINS > READY_WORK > BLOCKED > BACKLOG)
      (if .status == "in_progress" then "RESUME"
       elif (.dependent_count // 0) >= 2 and .status != "in_progress" then "UNBLOCK_CHAINS"
       elif .priority == "P4" then "BACKLOG"
       elif (.dependency_count // 0) > 0 and .status != "closed" then "BLOCKED"
       else "READY_WORK"
       end) as $group |
      $item + { group: $group, days_ago: $days_ago }
    ] |

    # Group order mapping
    def group_order:
      if . == "RESUME" then 0
      elif . == "UNBLOCK_CHAINS" then 1
      elif . == "READY_WORK" then 2
      elif . == "BLOCKED" then 3
      elif . == "BACKLOG" then 4
      else 5 end;

    # Sort by group order, then by score descending within group
    sort_by([(.group | group_order), -.score]) |

    # Group and format
    group_by(.group) |
    sort_by(.[0].group | group_order) |
    [.[] |
      # Group header
      (.[0].group | if . == "UNBLOCK_CHAINS" then "UNBLOCK CHAINS"
       elif . == "READY_WORK" then "READY WORK"
       else . end) as $header |
      "GROUP:" + $header,
      (to_entries[] |
        .value as $item |
        (.key + 1 | tostring) as $rank |
        # Staleness flag
        (if $item.days_ago >= 7 then " [stale " + ($item.days_ago | tostring) + "d]" else "" end) as $stale |
        # Status + days
        "[" + ($item.status // "open") + " " + ($item.days_ago | tostring) + "d]" as $status_tag |
        # Unblocks annotation
        (if ($item.dependents // [] | length) > 0 then
          "\n   -> Unblocks: " + ($item.dependents | join(", "))
         else "" end) as $unblocks |
        "ENTRY:" + $item.group + ":" +
          $rank + ". [" + ($item.score | tostring) + "] " +
          $item.id + " (" + ($item.priority // "-") + " " + ($item.type // "-") + ") -- " +
          ($item.title // "-") + " " + $status_tag + $stale + $unblocks
      ),
      ""
    ] | .[]
  ' | while IFS= read -r line; do
    case "$line" in
      GROUP:RESUME)
        printf '%s%s=== RESUME ===%s\n' "$C_BOLD" "$C_GREEN" "$C_RESET"
        ;;
      GROUP:UNBLOCK\ CHAINS)
        printf '%s%s=== UNBLOCK CHAINS ===%s\n' "$C_BOLD" "$C_CYAN" "$C_RESET"
        ;;
      GROUP:READY\ WORK)
        printf '%s%s=== READY WORK ===%s\n' "$C_BOLD" "$C_YELLOW" "$C_RESET"
        ;;
      GROUP:BLOCKED)
        printf '%s%s=== BLOCKED ===%s\n' "$C_BOLD" "$C_RED" "$C_RESET"
        ;;
      GROUP:BACKLOG)
        printf '%s%s=== BACKLOG ===%s\n' "$C_BOLD" "$C_DIM" "$C_RESET"
        ;;
      ENTRY:RESUME:*)
        printf '  %s%s%s\n' "$C_GREEN" "${line#ENTRY:RESUME:}" "$C_RESET"
        ;;
      ENTRY:UNBLOCK_CHAINS:*)
        printf '  %s%s%s\n' "$C_CYAN" "${line#ENTRY:UNBLOCK_CHAINS:}" "$C_RESET"
        ;;
      ENTRY:READY_WORK:*)
        printf '  %s%s%s\n' "$C_YELLOW" "${line#ENTRY:READY_WORK:}" "$C_RESET"
        ;;
      ENTRY:BLOCKED:*)
        printf '  %s%s%s\n' "$C_RED" "${line#ENTRY:BLOCKED:}" "$C_RESET"
        ;;
      ENTRY:BACKLOG:*)
        printf '  %s%s%s\n' "$C_DIM" "${line#ENTRY:BACKLOG:}" "$C_RESET"
        ;;
      "")
        # blank line between groups
        ;;
      *)
        printf '%s\n' "$line"
        ;;
    esac
  done
fi
