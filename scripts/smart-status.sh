#!/usr/bin/env bash
# smart-status.sh â€” Workflow intelligence scoring engine
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
#   BD_CMD  â€” override the bd command (for testing with mocks)
#   GIT_CMD â€” override the git command (for testing with mocks)
#   DEFAULT_BRANCH â€” override the default branch name (default: auto-detect)
#
# Cross-platform: bash 3.2 compatible (no associative arrays, no mapfile).
# OWASP A03: All variables quoted, sanitize() strips injection patterns.

set -euo pipefail

# â”€â”€ Source cross-dev awareness scripts â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
# file-index.sh: file_index_read for reading file index entries
# sync-utils.sh: get_session_identity for current developer identity

_SMART_STATUS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NODE_CMD="${NODE_CMD:-node}"
if [ -f "$_SMART_STATUS_DIR/lib/sanitize.sh" ]; then
  source "$_SMART_STATUS_DIR/lib/sanitize.sh"
fi
if [ -f "$_SMART_STATUS_DIR/file-index.sh" ]; then
  source "$_SMART_STATUS_DIR/file-index.sh"
fi
if [ -f "$_SMART_STATUS_DIR/sync-utils.sh" ]; then
  source "$_SMART_STATUS_DIR/sync-utils.sh"
fi

# â”€â”€ Helpers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

if ! declare -F sanitize >/dev/null; then
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
fi

# â”€â”€ Dependency check â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

if ! command -v jq &>/dev/null; then
  echo "Error: jq is required but not found." >&2
  echo "Install jq:" >&2
  echo "  macOS:   brew install jq" >&2
  echo "  Ubuntu:  sudo apt-get install jq" >&2
  echo "  Windows: winget install jqlang.jq" >&2
  exit 1
fi

# Warn if jq < 1.6 (fromdateiso8601 and sub/2 require 1.6+)
# Strip CR here as well because Windows jq.exe (or a CRLF-emitting wrapper in
# tests) can affect the version probe before the jq() shim is defined below.
_jq_version="$(command jq --version 2>/dev/null | tr -d '\r' | sed 's/jq-//')" || true
if [ -n "$_jq_version" ]; then
  _jq_major="${_jq_version%%.*}"
  _jq_minor="${_jq_version#*.}"; _jq_minor="${_jq_minor%%.*}"
  if [ "${_jq_major:-0}" -lt 1 ] || { [ "${_jq_major:-0}" -eq 1 ] && [ "${_jq_minor:-0}" -lt 6 ]; }; then
    echo "Warning: jq $_jq_version detected â€” staleness features require jq 1.6+. Team Activity may not display." >&2
  fi
fi

# On Windows/WSL we may be invoking jq.exe, which emits CRLF and breaks
# numeric comparisons like `[ "$count" -gt 0 ]`. Strip trailing CRs from
# all jq output after the dependency/version checks above.
jq() {
  command jq "$@" | tr -d '\r'
}

# â”€â”€ Configuration â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

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

# Parse arguments (bash 3.2 compatible â€” no associative arrays)
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

# â”€â”€ Fetch issues â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

# Auto-recover beads database if Dolt server lost the database (e.g. branch
# switch, fresh clone, server restart).  Checks for the specific "database
# not found" error, runs bd init --force + bd backup restore, then retries.
# Capture stderr into variable (2>&1 redirects stderr to stdout for capture,
# then >/dev/null discards original stdout so only errors remain).
if ! command -v "$BD" >/dev/null 2>&1; then
  echo "Error: bd is required but not found." >&2
  exit 1
fi

_bd_list_err="$("$BD" list --json --limit 0 2>&1 >/dev/null || true)"
if printf '%s' "$_bd_list_err" | grep -qi "database.*not found"; then
  _repo_root="$("$GIT" rev-parse --show-toplevel 2>/dev/null || pwd)"
  _metadata_path="$_repo_root/.beads/metadata.json"
  _bd_prefix=""
  if [ -f "$_metadata_path" ]; then
    if _metadata_prefix="$(jq -r '(.dolt_database // "") | strings' "$_metadata_path" 2>/dev/null)"; then
      _bd_prefix="$(printf '%s' "$_metadata_prefix" | tr -d '\r')"
    fi
  fi
  if [ -z "$_bd_prefix" ]; then
    _bd_prefix="$(basename "$_repo_root" | tr '[:upper:]' '[:lower:]' | tr -cs '[:alnum:]-' '-' | sed 's/^-//;s/-$//')"
  fi
  echo "Beads database not found â€” attempting auto-recovery..." >&2
  if "$BD" init --force --prefix "$_bd_prefix" >/dev/null 2>&1; then
    if [ -d "$_repo_root/.beads/backup" ] && ls "$_repo_root/.beads/backup"/*.jsonl >/dev/null 2>&1; then
      "$BD" backup restore >/dev/null 2>&1 && echo "Beads: restored from backup." >&2 || echo "Beads: backup restore failed." >&2
    else
      echo "Beads: initialized fresh (no backup found)." >&2
    fi
  else
    echo "Beads: auto-recovery failed â€” run 'bd doctor' manually." >&2
  fi
fi

ISSUES_JSON="$("$BD" list --json --limit 0 2>/dev/null || echo '[]')"

# Bail early on empty
if [ "$(printf '%s' "$ISSUES_JSON" | jq 'length')" = "0" ]; then
  if [ "$JSON_MODE" = "1" ]; then
    echo '{"sessions":[],"issues":[],"team_activity":[]}'
  else
    echo "No issues found."
  fi
  exit 0
fi

# â”€â”€ Identify epics and fetch their children â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

# Extract epic IDs (type == "epic")
EPIC_IDS="$(printf '%s' "$ISSUES_JSON" | jq -r '.[] | select(.type == "epic") | .id')"

# Build a JSON object mapping epic_id -> { closed, total }
EPIC_STATS="{}"
if [ -n "$EPIC_IDS" ]; then
  # Process each epic (bash 3.2 compatible â€” read line by line)
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

# â”€â”€ Score issues via shared JS helper â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

if ! command -v "$NODE_CMD" >/dev/null 2>&1; then
  echo "Error: node is required but not found." >&2
  exit 1
fi

SCORED_JSON="$(printf '{"issues":%s,"epicStats":%s}' "$ISSUES_JSON" "$EPIC_STATS" | "$NODE_CMD" "$_SMART_STATUS_DIR/smart-status-score.js")"

# â”€â”€ Session detection â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

# Parse git worktree list --porcelain to find active sessions
# Format: blocks separated by blank lines, each block has:
#   worktree <path>
#   HEAD <sha>
#   branch refs/heads/<branch>

WORKTREE_PORCELAIN="$("$GIT" worktree list --porcelain 2>/dev/null || echo '')"


# Build session/conflict data with the shared JS helper so the shell layer
# only performs command execution and rendering.
IN_PROGRESS_JSON="[]"
if [ -n "$WORKTREE_PORCELAIN" ]; then
  IN_PROGRESS_JSON="$("$BD" list --status in_progress --json --limit 0 2>/dev/null || echo '')"
  if [ -z "$IN_PROGRESS_JSON" ] || ! printf '%s' "$IN_PROGRESS_JSON" | jq empty 2>/dev/null; then
    IN_PROGRESS_JSON="$(printf '%s' "$ISSUES_JSON" | jq '[.[] | select(.status == "in_progress")]')"
  fi
fi

SESSIONS_JSON="$(printf '{"baseBranch":%s,"worktreePorcelain":%s,"inProgressIssues":%s}' \
  "$(printf '%s' "$BASE_BRANCH" | jq -R '.')" \
  "$(printf '%s' "$WORKTREE_PORCELAIN" | jq -Rs '.')" \
  "$IN_PROGRESS_JSON" | "$NODE_CMD" "$_SMART_STATUS_DIR/smart-status-sessions.js")"
SESSION_COUNT="$(printf '%s' "$SESSIONS_JSON" | jq 'length')"

if [ "$SESSION_COUNT" -ge 2 ]; then
  BRANCH_FILES_JSON="[]"
  _session_branches="$(printf '%s' "$SESSIONS_JSON" | jq -r '.[].branch')"
  while IFS= read -r _branch; do
    [ -z "$_branch" ] && continue
    _files="$("$GIT" diff "${BASE_BRANCH}...${_branch}" --name-only -- 2>/dev/null || echo '')"
    _files_json="$(printf '%s' "$_files" | jq -R -s 'split("\n") | map(select(length > 0))')"
    BRANCH_FILES_JSON="$(printf '%s' "$BRANCH_FILES_JSON" | jq \
      --arg branch "$_branch" \
      --argjson files "$_files_json" \
      '. + [{branch: $branch, files: $files}]'
    )"
  done <<BRANCHEOF
$_session_branches
BRANCHEOF

  SESSIONS_JSON="$(printf '{"sessions":%s,"branchFiles":%s}' "$SESSIONS_JSON" "$BRANCH_FILES_JSON" | "$NODE_CMD" "$_SMART_STATUS_DIR/smart-status-sessions.js")"
fi

TIER2_ENABLED=0
if [ "$SESSION_COUNT" -ge 2 ]; then
  _git_ver="$("$GIT" --version 2>/dev/null || echo '')"
  _git_major=0
  _git_minor=0
  _ver_nums="${_git_ver#git version }"
  _git_major="${_ver_nums%%.*}"
  _ver_rest="${_ver_nums#*.}"
  _git_minor="${_ver_rest%%.*}"
  case "$_git_major" in ''|*[!0-9]*) _git_major=0 ;; esac
  case "$_git_minor" in ''|*[!0-9]*) _git_minor=0 ;; esac

  if [ "$_git_major" -gt 2 ] || { [ "$_git_major" -eq 2 ] && [ "$_git_minor" -ge 38 ]; }; then
    TIER2_ENABLED=1
  fi
fi

if [ "$TIER2_ENABLED" = "1" ]; then
  _conflict_pairs="$(printf '%s' "$SESSIONS_JSON" | jq -r '
    [.[] | select((.conflicts // []) | length > 0) |
      .branch as $b |
      .conflicts[] |
      [$b, .branch] | sort | join("\t")
    ] | unique | .[]
  ')"

  if [ -n "$_conflict_pairs" ]; then
    MERGE_TREE_RESULTS_JSON="[]"
    while IFS='	' read -r _b1 _b2; do
      [ -z "$_b1" ] && continue
      [ -z "$_b2" ] && continue
      _mt_output=""
      _mt_exit=0
      _mt_output="$("$GIT" merge-tree --write-tree --name-only --no-messages -- "$_b1" "$_b2" 2>/dev/null)" || _mt_exit=$?
      MERGE_TREE_RESULTS_JSON="$(printf '%s' "$MERGE_TREE_RESULTS_JSON" | jq \
        --arg left "$_b1" \
        --arg right "$_b2" \
        --arg output "$_mt_output" \
        --argjson exitCode "$_mt_exit" \
        '. + [{left: $left, right: $right, exitCode: $exitCode, output: $output}]'
      )"
    done <<PAIRSEOF
$_conflict_pairs
PAIRSEOF

    SESSIONS_JSON="$(printf '{"sessions":%s,"mergeTreeResults":%s}' "$SESSIONS_JSON" "$MERGE_TREE_RESULTS_JSON" | "$NODE_CMD" "$_SMART_STATUS_DIR/smart-status-sessions.js")"
  fi
fi

TEAM_ACTIVITY_JSON="[]"

# Only proceed if file_index_read and get_session_identity are available
if command -v file_index_read &>/dev/null && command -v get_session_identity &>/dev/null; then
  _file_index_all="$(file_index_read 2>/dev/null || echo '[]')"
  _file_index_len="$(printf '%s' "$_file_index_all" | jq 'length')"

  if [ "$_file_index_len" -gt 0 ]; then
    _my_identity="$(get_session_identity 2>/dev/null || echo '')"

    # Allow override via SMART_STATUS_IDENTITY env (for testing)
    if [ -n "${SMART_STATUS_IDENTITY:-}" ]; then
      _my_identity="$SMART_STATUS_IDENTITY"
    fi

    if [ -n "$_my_identity" ]; then
      # Build team activity: filter out current dev, compute overlaps and staleness
      # Current dev's modules (for overlap detection)
      _my_modules="$(printf '%s' "$_file_index_all" | jq -c --arg me "$_my_identity" \
        '[.[] | select(.developer == $me) | .modules // [] | .[]] | unique')" || _my_modules="[]"

      # STALENESS_THRESHOLD_SECS = 48 hours = 172800 seconds
      TEAM_ACTIVITY_JSON="$(printf '%s' "$_file_index_all" | jq -c --arg me "$_my_identity" \
        --argjson my_modules "$_my_modules" \
        --arg now_ts "$(date +%s)" '
        [.[] | select(.developer != $me) |
          . as $entry |
          # Compute staleness
          (if .updated_at then
            ((.updated_at | sub("\\.[0-9]+Z$"; "Z")) | fromdateiso8601) as $ts |
            (($now_ts | tonumber) - $ts) as $age_secs |
            {
              age_secs: $age_secs,
              stale: ($age_secs > 172800),
              days_ago: (($age_secs / 86400) | floor)
            }
          else
            { age_secs: 0, stale: false, days_ago: 0 }
          end) as $staleness |
          # Compute module overlaps
          ([$entry.modules // [] | .[] | select(. as $m | $my_modules | index($m))] | unique) as $overlaps |
          {
            developer: $entry.developer,
            issue_id: $entry.issue_id,
            modules: ($entry.modules // []),
            files: ($entry.files // []),
            stale: $staleness.stale,
            days_ago: $staleness.days_ago,
            overlapping_modules: $overlaps,
            updated_at: $entry.updated_at
          }
        ] | sort_by(.developer) | group_by(.developer) | map({
          developer: .[0].developer,
          issues: [.[] | {
            issue_id: .issue_id,
            modules: .modules,
            files: .files,
            stale: .stale,
            days_ago: .days_ago,
            overlapping_modules: .overlapping_modules
          }]
        })
      ')" || TEAM_ACTIVITY_JSON="[]"
    fi
  fi
fi

# â”€â”€ Output â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

if [ "$JSON_MODE" = "1" ]; then
  # Always output consistent shape: {sessions: [...], issues: [...], team_activity: [...]}
  jq -n --argjson sessions "$SESSIONS_JSON" --argjson issues "$SCORED_JSON" \
    --argjson team_activity "$TEAM_ACTIVITY_JSON" \
    '{sessions: $sessions, issues: $issues, team_activity: $team_activity}'
else
  # Grouped, colored output
  # NO_COLOR support: https://no-color.org/
  if [ -n "${NO_COLOR:-}" ]; then
    C_RESET="" C_GREEN="" C_YELLOW="" C_RED="" C_DIM="" C_BOLD="" C_CYAN=""
  else
    C_RESET=$'\033[0m' C_GREEN=$'\033[32m' C_YELLOW=$'\033[33m'
    C_RED=$'\033[31m' C_DIM=$'\033[2m' C_BOLD=$'\033[1m' C_CYAN=$'\033[36m'
  fi

  # â”€â”€ Active Sessions (before grouped output) â”€â”€
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

  # â”€â”€ Team Activity (cross-developer visibility) â”€â”€
  _ta_len="$(printf '%s' "$TEAM_ACTIVITY_JSON" | jq 'length')"
  if [ "$_ta_len" -gt 0 ]; then
    printf '%s%sâ”€â”€ Team Activity â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€%s\n' "$C_BOLD" "$C_CYAN" "$C_RESET"
    printf '%s' "$TEAM_ACTIVITY_JSON" | jq -r '
      .[] |
      .developer as $dev |
      "  " + $dev + ":",
      (.issues[] |
        .issue_id as $iid |
        .modules as $mods |
        .stale as $stale |
        .days_ago as $days |
        .overlapping_modules as $overlaps |
        # Issue line with optional stale annotation
        (if $stale then
          "    " + $iid + " (in_progress, stale: claimed " + ($days | tostring) + " days ago)"
        else
          "    " + $iid + " (in_progress)" +
            (if ($mods | length) > 0 then
              " â€” touching " + ($mods | join(", "))
            else "" end)
        end),
        # Overlap or no-overlap line
        (if ($overlaps | length) > 0 then
          "    ! Overlap: " + ($overlaps | join(", ")) + " (you are also working here)"
        else
          "    No overlaps with your work"
        end)
      )
    '
    printf '\n'
  fi

  # Use jq to assign groups and format, then bash to colorize
  printf '%s\n' "$SCORED_JSON" | jq -r --arg now "$(date +%s)" '
    # Assign group to each issue
    [.[] | . as $item |
      # Compute days since updated_at
      (if .updated_at then
        ((.updated_at[:19] + "Z") | fromdateiso8601) as $ts |
        (($now | tonumber) - $ts) / 86400 | floor
       else 0 end) as $days_ago |
      # Group assignment (priority order: RESUME > UNBLOCK_CHAINS > BLOCKED > BACKLOG > READY_WORK)
      # Note: in_progress issues with active blockers still show in RESUME (you started
      # the work, you need to see it) but get a "BLOCKED" annotation in the output.
      (if .status == "in_progress" then "RESUME"
       elif (.dependent_count // 0) >= 2 then "UNBLOCK_CHAINS"
       elif (.dependency_count // 0) > 0 and .status != "closed" then "BLOCKED"
       elif (.priority == "P4" or .priority == 4) then "BACKLOG"
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
          $item.id + " (" + (if ($item.priority | type) == "number" then "P" + ($item.priority | tostring) else ($item.priority // "-" | tostring) end) + " " + ($item.type // "-" | tostring) + ") -- " +
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
