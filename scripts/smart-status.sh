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
#   GIT_CMD — override the git command (for testing with mocks)
#   DEFAULT_BRANCH — override the default branch name (default: auto-detect)
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

# Auto-detect default branch (master or main), with override via DEFAULT_BRANCH env
if [ -n "${DEFAULT_BRANCH:-}" ]; then
  BASE_BRANCH="$DEFAULT_BRANCH"
elif "$GIT" rev-parse --verify master >/dev/null 2>&1; then
  BASE_BRANCH="master"
elif "$GIT" rev-parse --verify main >/dev/null 2>&1; then
  BASE_BRANCH="main"
else
  BASE_BRANCH="master"
fi

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
    echo '{"sessions":[],"issues":[]}'
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
  # First pass: build reverse dependency map (who does each issue unblock?)
  # For each issue X, find all issues Y where Y.dependencies[].depends_on_id == X.id
  (reduce .[] as $dep_issue ({};
    reduce ($dep_issue.dependencies // [] | .[]) as $dep (.;
      .[$dep.depends_on_id] += [$dep_issue.id]
    )
  )) as $dependents_map |

  [.[] | . as $issue |

    # Priority weight: P0=5, P1=4, P2=3, P3=2, P4=1, default=1
    (if .priority == "P0" then 5
     elif .priority == "P1" then 4
     elif .priority == "P2" then 3
     elif .priority == "P3" then 2
     elif .priority == "P4" then 1
     else 1 end) as $priority_weight |

    # Unblock chain: dependent_count + 1 (min 1).
    # NOTE: dependent_count is the authoritative server-side count. The "Unblocks:"
    # annotation (computed below from local response) may show fewer items when
    # bd list omits closed or filtered-out issues. This is an intentional trade-off.
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

    # Compute dependents list (which issues does this one unblock?)
    ($dependents_map[$issue.id] // []) as $dependents_list |

    # Output scored issue
    $issue + {
      score: ($score * 100 | round / 100),
      priority_weight: $priority_weight,
      unblock_chain: $unblock_chain,
      type_weight: $type_weight,
      status_boost: $status_boost,
      epic_proximity: (($epic_proximity * 100 | round) / 100),
      staleness_boost: $staleness_boost,
      dependents: $dependents_list
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

# Collect non-default-branch worktree branches and paths
# Stored as newline-delimited "branch<TAB>path" entries — safe for paths with |, spaces, etc.
SESSION_ENTRIES=""
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
      # End of block — process if we have a branch that is not the default branch
      if [ -n "$_wt_branch" ] && [ "$_wt_branch" != "$BASE_BRANCH" ]; then
        SESSION_COUNT=$((SESSION_COUNT + 1))
        if [ -n "$SESSION_ENTRIES" ]; then
          SESSION_ENTRIES="${SESSION_ENTRIES}
${_wt_branch}	${_wt_path}"
        else
          SESSION_ENTRIES="${_wt_branch}	${_wt_path}"
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
  IN_PROGRESS_JSON="$("$BD" list --status in_progress --json --limit 0 2>/dev/null || echo '')"
  # Fallback: only if bd command failed (empty output), not if result is legitimately empty array
  if [ -z "$IN_PROGRESS_JSON" ] || ! printf '%s' "$IN_PROGRESS_JSON" | jq empty 2>/dev/null; then
    IN_PROGRESS_JSON="$(printf '%s' "$ISSUES_JSON" | jq '[.[] | select(.status == "in_progress")]')"
  fi
fi

# Build sessions data: for each branch, find matching in-progress issues
# Match by: branch slug (after feat/, fix/, docs/) appears in issue title (case-insensitive, hyphen-to-space)
SESSIONS_JSON="[]"
if [ "$SESSION_COUNT" -gt 0 ]; then
  # Process each session (newline-delimited "branch<TAB>path" entries)
  while IFS='	' read -r _branch _path; do
    [ -z "$_branch" ] && continue

    # Extract slug from branch name (strip any <prefix>/ convention)
    _slug="$_branch"
    case "$_slug" in
      */*) _slug="${_slug##*/}" ;;
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

  done <<SESSIONS_EOF
$SESSION_ENTRIES
SESSIONS_EOF
fi

# ── File-level conflict detection ────────────────────────────────────────
# For each active worktree branch, get changed files via:
#   git diff <base-branch>...<branch> --name-only --
# Uses -- separator to prevent argument injection (OWASP A03)

# ALL_BRANCH_FILES: newline-delimited list of "branch<TAB>file1<TAB>file2..."
ALL_BRANCH_FILES=""
if [ "$SESSION_COUNT" -ge 2 ]; then
  # Read branches from SESSION_ENTRIES (newline-delimited "branch<TAB>path")
  while IFS='	' read -r _branch _path; do
    [ -z "$_branch" ] && continue

    # Get changed files for this branch vs BASE_BRANCH (-- prevents injection)
    _files="$("$GIT" diff "${BASE_BRANCH}...${_branch}" --name-only -- 2>/dev/null || echo '')"
    # Collapse to tab-delimited (tabs can't appear in filenames), strip empty lines
    _files_csv="$(printf '%s' "$_files" | tr '\n' '\t' | sed 's/\t$//' | sed 's/^\t//')"

    if [ -n "$ALL_BRANCH_FILES" ]; then
      ALL_BRANCH_FILES="${ALL_BRANCH_FILES}
${_branch}:${_files_csv}"
    else
      ALL_BRANCH_FILES="${_branch}:${_files_csv}"
    fi
  done <<CONFLICT_EOF
$SESSION_ENTRIES
CONFLICT_EOF

  # Build conflict map: find files that appear in multiple branches
  # and add changed_files + conflicts to SESSIONS_JSON
  while IFS= read -r _entry; do
    [ -z "$_entry" ] && continue
    _branch="${_entry%%:*}"
    _files_csv="${_entry#*:}"

    # Convert tab-delimited files to JSON array
    if [ -n "$_files_csv" ]; then
      _files_json="$(printf '%s' "$_files_csv" | jq -R 'split("\t")')"
    else
      _files_json="[]"
    fi

    # Find conflicts: files in this branch that also appear in other branches
    _conflicts_json="[]"
    while IFS= read -r _other_entry; do
      [ -z "$_other_entry" ] && continue
      _other_branch="${_other_entry%%:*}"
      _other_files="${_other_entry#*:}"

      # Skip self
      [ "$_other_branch" = "$_branch" ] && continue
      [ -z "$_other_files" ] && continue

      # Find intersection
      _other_json="$(printf '%s' "$_other_files" | jq -R 'split("\t")')"
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
    done <<INNER_EOF
$ALL_BRANCH_FILES
INNER_EOF

    # Update SESSIONS_JSON: add changed_files and conflicts to matching branch entry
    SESSIONS_JSON="$(printf '%s' "$SESSIONS_JSON" | jq \
      --arg branch "$_branch" \
      --argjson files "$_files_json" \
      --argjson conflicts "$_conflicts_json" \
      '[.[] | if .branch == $branch then . + {changed_files: $files, conflicts: $conflicts} else . end]'
    )"
  done <<OUTER_EOF
$ALL_BRANCH_FILES
OUTER_EOF
fi

# ── Tier 2: git merge-tree conflict detection ──────────────────────────
# If git >= 2.38 and there are file overlaps from Tier 1, run merge-tree
# to detect actual merge conflicts vs mere file overlap.

TIER2_ENABLED=0
if [ "$SESSION_COUNT" -ge 2 ]; then
  # Check git version >= 2.38 (merge-tree --write-tree requires it)
  _git_ver="$("$GIT" --version 2>/dev/null || echo '')"
  _git_major=0
  _git_minor=0
  # Parse "git version X.Y.Z..." -> extract major and minor
  _ver_nums="${_git_ver#git version }"
  _git_major="${_ver_nums%%.*}"
  _ver_rest="${_ver_nums#*.}"
  _git_minor="${_ver_rest%%.*}"
  # Validate they are numbers
  case "$_git_major" in ''|*[!0-9]*) _git_major=0 ;; esac
  case "$_git_minor" in ''|*[!0-9]*) _git_minor=0 ;; esac

  if [ "$_git_major" -gt 2 ] || { [ "$_git_major" -eq 2 ] && [ "$_git_minor" -ge 38 ]; }; then
    TIER2_ENABLED=1
  fi
fi

# For each pair of branches with file overlaps, run merge-tree
if [ "$TIER2_ENABLED" = "1" ]; then
  # Collect all branch pairs that have conflicts in SESSIONS_JSON
  _conflict_pairs="$(printf '%s' "$SESSIONS_JSON" | jq -r '
    [.[] | select((.conflicts // []) | length > 0) |
      .branch as $b |
      .conflicts[] |
      [$b, .branch] | sort | join(" ")
    ] | unique | .[]
  ')"

  if [ -n "$_conflict_pairs" ]; then
    # Process each unique pair
    while IFS= read -r _pair; do
      [ -z "$_pair" ] && continue
      _b1="${_pair%% *}"
      _b2="${_pair#* }"

      # Run merge-tree; exit 1 = actual conflict, exit 0 = clean merge
      _mt_output=""
      _mt_exit=0
      _mt_output="$("$GIT" merge-tree --write-tree --name-only --no-messages -- "$_b1" "$_b2" 2>/dev/null)" || _mt_exit=$?

      if [ "$_mt_exit" -ne 0 ] && [ -n "$_mt_output" ]; then
        # Real conflict detected — parse conflicted file names
        # merge-tree outputs a tree SHA on first line, then filenames
        # With --name-only, conflicted files are listed after the SHA line
        _conflict_files=""
        _line_num=0
        while IFS= read -r _cf_line; do
          _line_num=$((_line_num + 1))
          # Skip the first line (tree SHA output from merge-tree)
          if [ "$_line_num" -eq 1 ]; then continue; fi
          # Skip empty lines
          if [ -z "$_cf_line" ]; then continue; fi
          if [ -n "$_conflict_files" ]; then
            _conflict_files="${_conflict_files}	${_cf_line}"
          else
            _conflict_files="${_cf_line}"
          fi
        done <<MTEOF
$_mt_output
MTEOF

        if [ -n "$_conflict_files" ]; then
          _cf_json="$(printf '%s' "$_conflict_files" | jq -R 'split("\t")')"

          # Add merge_conflicts to both branches in SESSIONS_JSON
          for _target_branch in "$_b1" "$_b2"; do
            _other_branch="$_b1"
            [ "$_target_branch" = "$_b1" ] && _other_branch="$_b2"

            SESSIONS_JSON="$(printf '%s' "$SESSIONS_JSON" | jq \
              --arg branch "$_target_branch" \
              --arg other "$_other_branch" \
              --argjson files "$_cf_json" \
              '[.[] | if .branch == $branch then
                . + {merge_conflicts: ((.merge_conflicts // []) + [{branch: $other, files: $files}])}
              else . end]'
            )"
          done
        fi
      fi
    done <<PAIRSEOF
$_conflict_pairs
PAIRSEOF
  fi
fi

# ── Output ──────────────────────────────────────────────────────────────

if [ "$JSON_MODE" = "1" ]; then
  # Always output consistent shape: {sessions: [...], issues: [...]}
  jq -n --argjson sessions "$SESSIONS_JSON" --argjson issues "$SCORED_JSON" \
    '{sessions: $sessions, issues: $issues}'
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
      .merge_conflicts as $merge_conflicts |
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
      # Tier 2: Merge conflict annotations (real conflicts from merge-tree)
      (if ($merge_conflicts // [] | length) > 0 then
        ($merge_conflicts[] |
          .branch as $other |
          .files[] |
          "    !! Merge conflict: " + . + " (" + $branch + " vs " + $other + ")"
        )
      else empty end),
      # Tier 1: Conflict risk annotations (file overlap only, excluding merge conflicts)
      (if ($conflicts // [] | length) > 0 then
        # Build set of files that have real merge conflicts
        ([$merge_conflicts // [] | .[] | .files[]] | unique) as $mc_files |
        ($conflicts[] |
          .branch as $other |
          .files[] |
          # Only show Conflict risk if NOT already a merge conflict
          if ($mc_files | index(.)) then empty
          else "    ! Conflict risk: " + . + " (" + $other + " in-progress)"
          end
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
      # Group assignment (priority order: RESUME > UNBLOCK_CHAINS > BLOCKED > BACKLOG > READY_WORK)
      # Note: in_progress issues with active blockers still show in RESUME (you started
      # the work, you need to see it) but get a "BLOCKED" annotation in the output.
      (if .status == "in_progress" then "RESUME"
       elif (.dependent_count // 0) >= 2 then "UNBLOCK_CHAINS"
       elif (.dependency_count // 0) > 0 and .status != "closed" then "BLOCKED"
       elif .priority == "P4" then "BACKLOG"
       else "READY_WORK"
       end) as $group |
      # Flag in_progress issues that have active blockers
      (if .status == "in_progress" and (.dependency_count // 0) > 0 then true else false end) as $blocked_resume |
      $item + { group: $group, days_ago: $days_ago, blocked_resume: $blocked_resume }
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
        ("[" + ($item.status // "open") + " " + ($item.days_ago | tostring) + "d]") as $status_tag |
        # Unblocks annotation
        (if ($item.dependents // [] | length) > 0 then
          " -> Unblocks: " + ($item.dependents | join(", "))
         else "" end) as $unblocks |
        # Blocked-resume warning
        (if $item.blocked_resume then " !! BLOCKED by dependencies" else "" end) as $blocked_warn |
        "ENTRY:" + $item.group + ":" +
          $rank + ". [" + ($item.score | tostring) + "] " +
          $item.id + " (" + ($item.priority // "-") + " " + ($item.type // "-") + ") -- " +
          ($item.title // "-") + " " + $status_tag + $stale + $blocked_warn + $unblocks
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
