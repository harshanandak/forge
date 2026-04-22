#!/usr/bin/env bash
# dep-guard.sh Ã¢â‚¬â€ Dependency-guard helper for pre-change impact analysis.
#
# Subcommands:
#   find-consumers     <file-path>                Find files that import/require a given module
#   check-ripple       <issue-id>                  Check ripple impact via keyword matching
#   store-contracts    <issue-id> <contracts-string> Store contract metadata on a Beads issue
#   extract-contracts  <file-path>                  Extract public API contracts from a file
#
# Cross-platform: works on Windows (Git Bash), macOS, and Linux.
# OWASP A03: All variables properly quoted to prevent shell injection.

set -euo pipefail

# Source shared sanitize library
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NODE_CMD="${NODE_CMD:-node}"
source "$SCRIPT_DIR/lib/sanitize.sh"

# Ã¢â€â‚¬Ã¢â€â‚¬ Helpers Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬

usage() {
  cat >&2 <<'EOF'
Usage: dep-guard.sh <subcommand> [args...]

Subcommands:
  find-consumers     <file-path>                Find files that import/require a given module
  check-ripple       <issue-id>                  Check ripple impact via keyword matching
  apply-decision     <issue-id> <dependent-id> <depends-on-id> "<rationale>" Apply approved dependency decision via Beads
  store-contracts    <issue-id> <contracts-string> Store contract metadata on a Beads issue
  extract-contracts  <file-path>                  Extract public API contracts from a file
EOF
  exit 1
}

die() {
  echo "Error: $1" >&2
  exit 1
}

cycles_output_is_safe() {
  local output="$1"
  printf '%s' "$output" | grep -Eqi 'no cycles? found|no cycles? detected|no dependency cycles|0 dependency cycles|0 cycles'
}

rollback_dependency() {
  local dependent_issue="$1"
  local depends_on_issue="$2"

  local rollback_output
  rollback_output="$(${BD_CMD:-bd} dep remove "$dependent_issue" "$depends_on_issue" 2>&1)" || {
    echo "$rollback_output" >&2
    die "Cycle detected for ${dependent_issue} -> ${depends_on_issue}; rollback failed and requires manual intervention"
  }

  printf '%s\n' "$rollback_output" > /dev/null
}

rollback_and_die() {
  local dependent_issue="$1"
  local depends_on_issue="$2"
  local message="$3"
  local command_output="${4:-}"

  rollback_dependency "$dependent_issue" "$depends_on_issue"
  if [[ -n "$command_output" ]]; then
    echo "$command_output" >&2
  fi
  die "$message"
}

# Run bd update and check for errors in both exit code and output.
# bd update exits 0 even for non-existent issues, so we check stdout too.
bd_update() {
  local output
  output="$(${BD_CMD:-bd} update "$@" 2>&1)"
  local rc=$?

  if [[ $rc -ne 0 ]]; then
    echo "$output" >&2
    return 1
  fi

  # bd prints "Error resolving/updating ..." to stdout for non-existent issues
  # Use specific patterns to avoid false positives from data containing "error"
  if printf '%s' "$output" | grep -Eqi '^Error|Error resolving|Error updating'; then
    echo "$output" >&2
    return 1
  fi

  echo "$output"
  return 0
}

bd_comment_add() {
  local output
  output="$(${BD_CMD:-bd} comments add "$@" 2>&1)"
  local rc=$?

  if [[ $rc -ne 0 ]]; then
    echo "$output" >&2
    return 1
  fi

  if printf '%s' "$output" | grep -Eqi '^Error|Error resolving|Error adding'; then
    echo "$output" >&2
    return 1
  fi

  echo "$output"
  return 0
}

bd_set_state() {
  local output
  output="$(${BD_CMD:-bd} set-state "$@" 2>&1)"
  local rc=$?

  if [[ $rc -ne 0 ]]; then
    echo "$output" >&2
    return 1
  fi

  if printf '%s' "$output" | grep -Eqi '^Error|Error resolving|Error setting'; then
    echo "$output" >&2
    return 1
  fi

  echo "$output"
  return 0
}

# Run bd show <id> --json and return the JSON string.
# Handles both array and object JSON responses.
bd_show_json() {
  local issue_id="$1"

  local json
  json="$(${BD_CMD:-bd} show "$issue_id" --json 2>&1)" || die "Failed to show issue ${issue_id}"

  # bd show may exit 0 but print an error for non-existent issues
  if printf '%s' "$json" | grep -Eqi '^Error (fetching|resolving)'; then
    die "Issue not found: ${issue_id}"
  fi

  # bd show returns "[]" or empty for non-existent issues
  if [[ -z "$json" || "$json" == "[]" || "$json" == "null" ]]; then
    die "Issue not found: ${issue_id}"
  fi

  # Normalize: if the response is an array, extract the first element
  if command -v jq &>/dev/null; then
    local normalized
    normalized="$(printf '%s' "$json" | jq 'if type == "array" then .[0] else . end' 2>/dev/null)" || true
    if [[ -n "$normalized" && "$normalized" != "null" ]]; then
      json="$normalized"
    fi
  fi

  printf '%s' "$json"
}

# Emit contract lines from files and description text.
# Args: $1 = comma-separated file paths, $2 = "What to implement" text
# Output: lines of "<file>:<function>(modified)" to stdout
emit_contracts() {
  local files_str="$1"
  local what_str="$2"

  if [[ -z "$files_str" || -z "$what_str" ]]; then
    return
  fi

  # Extract word() patterns from the what section
  local funcs
  funcs="$(printf '%s' "$what_str" | grep -oE '[a-zA-Z_][a-zA-Z0-9_]*\(\)' || true)"

  if [[ -z "$funcs" ]]; then
    return
  fi

  # Parse comma-separated file paths, strip backticks and whitespace
  local IFS=','
  local file_list
  read -ra file_list <<< "$files_str"

  local fp fn
  for fp in "${file_list[@]}"; do
    # Strip leading/trailing whitespace and backticks
    fp="$(printf '%s' "$fp" | sed 's/^[[:space:]`]*//;s/[[:space:]`]*$//')"
    [[ -z "$fp" ]] && continue

    while IFS= read -r fn; do
      [[ -z "$fn" ]] && continue
      # Strip the trailing () from the function name
      fn="${fn%()}"
      printf '%s\n' "${fp}:${fn}(modified)"
    done <<< "$funcs"
  done
}

extract_task_file_from_design() {
  local design_text="$1"

  if [[ -z "$design_text" || "$design_text" != *"|"* ]]; then
    return 1
  fi

  local task_file="${design_text#*|}"
  task_file="$(printf '%s' "$task_file" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')"
  [[ -n "$task_file" ]] || return 1
  printf '%s' "$task_file"
}

run_phase3_analyzer() {
  local current_json="$1"
  local open_json="$2"
  local in_progress_json="$3"
  local task_file="$4"
  local repository_root="$5"
  local analyzer_script="${DEP_GUARD_ANALYZE_SCRIPT:-scripts/dep-guard-analyze.js}"

  printf '{"currentIssue":%s,"openIssues":%s,"inProgressIssues":%s,"taskFile":%s,"repositoryRoot":%s}' \
    "$current_json" \
    "${open_json:-[]}" \
    "${in_progress_json:-[]}" \
    "$(printf '%s' "$task_file" | jq -R '.')" \
    "$(printf '%s' "$repository_root" | jq -R '.')" \
    | "$NODE_CMD" "$analyzer_script" --stdin
}

render_phase3_review() {
  local renderer_script="${DEP_GUARD_RENDER_SCRIPT:-scripts/dep-guard-render-review.js}"
  "$NODE_CMD" "$renderer_script"
}

# Ã¢â€â‚¬Ã¢â€â‚¬ Subcommands Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬

cmd_find_consumers() {
  if [[ $# -lt 1 || -z "$1" ]]; then
    echo "Usage: dep-guard.sh find-consumers <function-or-pattern>" >&2
    exit 1
  fi

  local pattern
  pattern="$(sanitize "$1")"

  # Build list of directories that actually exist
  local dirs=()
  for d in lib/ scripts/ bin/ .claude/commands/ .forge/hooks/; do
    [[ -d "$d" ]] && dirs+=("$d")
  done

  if [[ ${#dirs[@]} -eq 0 ]]; then
    echo "No consumers found"
    return 0
  fi

  # Grep across key directories, excluding noise
  local results
  results="$(grep -rn -e "$pattern" \
    --include='*.js' --include='*.sh' --include='*.md' --include='*.ts' --include='*.json' \
    --exclude-dir=node_modules --exclude-dir=.worktrees --exclude-dir=test --exclude-dir=test-env \
    --exclude='dep-guard.sh' \
    "${dirs[@]}" 2>/dev/null || true)"

  if [[ -z "$results" ]]; then
    echo "No consumers found"
    return 0
  fi

  echo "$results"
  return 0
}

cmd_check_ripple_keyword_v1() {
  if [[ $# -lt 1 || -z "$1" ]]; then
    echo "Usage: dep-guard.sh check-ripple <issue-id>" >&2
    exit 1
  fi

  local issue_id
  issue_id="$(sanitize "$1")"

  # Ã¢â€â‚¬Ã¢â€â‚¬ Step 1: Validate issue exists Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬
  local src_json
  src_json="$(bd_show_json "$issue_id")"

  # Ã¢â€â‚¬Ã¢â€â‚¬ Step 2: Extract source title Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬
  local src_title=""
  if command -v jq &>/dev/null; then
    src_title="$(printf '%s' "$src_json" | jq -r '.title // ""' 2>/dev/null)" || true
  fi
  # Fallback: grep for title in JSON
  if [[ -z "$src_title" ]]; then
    src_title="$(printf '%s' "$src_json" | grep -oE '"title"[[:space:]]*:[[:space:]]*"[^"]*"' | head -1 | sed 's/^"title"[[:space:]]*:[[:space:]]*"//;s/"$//')" || true
  fi

  if [[ -z "$src_title" ]]; then
    echo "Warning: could not extract title for ${issue_id} - ripple check skipped" >&2
    return 0
  fi

  echo ""
  printf '%s\n' "Ripple check for ${issue_id}..."
  echo ""

  # Ã¢â€â‚¬Ã¢â€â‚¬ Step 3: Collect active issues Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬
  # Run bd list for open and in_progress separately, combine results
  local list_output=""
  local open_list=""
  local ip_list=""
  open_list="$(${BD_CMD:-bd} list --status=open 2>/dev/null)" || true
  ip_list="$(${BD_CMD:-bd} list --status=in_progress 2>/dev/null)" || true

  # Combine and deduplicate (in case bd list returns overlapping results)
  local combined=""
  if [[ -n "$open_list" && -n "$ip_list" ]]; then
    combined="${open_list}"$'\n'"${ip_list}"
  elif [[ -n "$open_list" ]]; then
    combined="$open_list"
  elif [[ -n "$ip_list" ]]; then
    combined="$ip_list"
  fi

  # Deduplicate by unique lines (preserves order via awk)
  if [[ -n "$combined" ]]; then
    list_output="$(printf '%s\n' "$combined" | awk '!seen[$0]++')"
  fi

  if [[ -z "$list_output" ]]; then
    echo "Warning: could not fetch active issue list - ripple check skipped" >&2
    return 0
  fi

  # Ã¢â€â‚¬Ã¢â€â‚¬ Step 4: Parse each active issue (excluding source) Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬
  # Format: Ã¢â€”â€¹ forge-xxx [Ã¢â€”Â P2] [feature] - Title of the issue
  #         Ã¢â€”Â forge-yyy [Ã¢â€”Â P1] [task] - Another issue title
  if ! command -v "$NODE_CMD" >/dev/null 2>&1; then
    echo "Error: ${NODE_CMD} is required but not found." >&2
    exit 1
  fi

  ISSUE_ID="$issue_id" \
  SOURCE_TITLE="$src_title" \
  LIST_OUTPUT="$list_output" \
  "$NODE_CMD" "$SCRIPT_DIR/dep-guard-keyword-ripple.js"
  return 0

}

cmd_check_ripple() {
  if [[ $# -lt 1 || -z "$1" ]]; then
    echo "Usage: dep-guard.sh check-ripple <issue-id>" >&2
    exit 1
  fi

  local issue_id
  issue_id="$(sanitize "$1")"

  local src_json
  src_json="$(bd_show_json "$issue_id")"

  local src_title=""
  if command -v jq &>/dev/null; then
    src_title="$(printf '%s' "$src_json" | jq -r '.title // ""' 2>/dev/null)" || true
  fi
  if [[ -z "$src_title" ]]; then
    src_title="$(printf '%s' "$src_json" | grep -oE '"title"[[:space:]]*:[[:space:]]*"[^"]*"' | head -1 | sed 's/^"title"[[:space:]]*:[[:space:]]*"//;s/"$//')" || true
  fi

  if [[ -z "$src_title" ]]; then
    echo "Warning: could not extract title for ${issue_id} - ripple check skipped" >&2
    return 0
  fi

  local design_text=""
  if command -v jq &>/dev/null; then
    design_text="$(printf '%s' "$src_json" | jq -r '.design // ""' 2>/dev/null)" || true
  fi
  if [[ -z "$design_text" ]]; then
    design_text="$(printf '%s' "$src_json" | grep -oE '"design"[[:space:]]*:[[:space:]]*"[^"]*"' | head -1 | sed 's/^"design"[[:space:]]*:[[:space:]]*"//;s/"$//')" || true
  fi

  local task_file=""
  task_file="$(extract_task_file_from_design "$design_text" || true)"
  if [[ -z "$task_file" || ! -f "$task_file" ]]; then
    echo "Warning: structured analyzer unavailable, falling back to keyword-only ripple check." >&2
    cmd_check_ripple_keyword_v1 "$issue_id"
    return 0
  fi

  local open_json=""
  local in_progress_json=""
  open_json="$(${BD_CMD:-bd} list --status=open --json 2>/dev/null)" || true
  in_progress_json="$(${BD_CMD:-bd} list --status=in_progress --json 2>/dev/null)" || true

  if [[ -z "$open_json" && -z "$in_progress_json" ]]; then
    echo "Warning: could not fetch active issue list - ripple check skipped" >&2
    return 0
  fi


  local repository_root="${DEP_GUARD_REPOSITORY_ROOT:-$PWD}"
  if run_phase3_analyzer \
    "$src_json" \
    "${open_json:-[]}" \
    "${in_progress_json:-[]}" \
    "$task_file" \
    "$repository_root" \
    | render_phase3_review; then
    return 0
  fi

  echo "Warning: structured analyzer unavailable, falling back to keyword-only ripple check." >&2
  cmd_check_ripple_keyword_v1 "$issue_id"
}

cmd_apply_decision() {
  if [[ $# -lt 4 ]]; then
    echo "Usage: dep-guard.sh apply-decision <issue-id> <dependent-id> <depends-on-id> \"<rationale>\"" >&2
    exit 1
  fi

  local issue_id
  issue_id="$(sanitize "$1")"
  local dependent_issue
  dependent_issue="$(sanitize "$2")"
  local depends_on_issue
  depends_on_issue="$(sanitize "$3")"
  local rationale
  rationale="$(sanitize "$4")"

  local dep_add_output
  dep_add_output="$(${BD_CMD:-bd} dep add "$dependent_issue" "$depends_on_issue" 2>&1)" || {
    echo "$dep_add_output" >&2
    die "Failed to add dependency ${dependent_issue} -> ${depends_on_issue}"
  }

  # Check for cycles Ã¢â‚¬â€ use exit code as primary signal
  if ! ${BD_CMD:-bd} dep cycles &>/dev/null; then
    rollback_dependency "$dependent_issue" "$depends_on_issue"
    die "Cycle detected for ${dependent_issue} -> ${depends_on_issue}"
  fi

  local graph_output
  graph_output="$(${BD_CMD:-bd} graph "$issue_id" 2>&1)" || rollback_and_die \
    "$dependent_issue" \
    "$depends_on_issue" \
    "Failed to render dependency graph for ${issue_id}" \
    "$graph_output"

  local ready_output
  ready_output="$(${BD_CMD:-bd} ready 2>&1)" || rollback_and_die \
    "$dependent_issue" \
    "$depends_on_issue" \
    "Failed to summarize ready work" \
    "$ready_output"

  if ! bd_set_state "$issue_id" "logicdep=approved" --reason "$rationale" > /dev/null; then
    rollback_and_die \
      "$dependent_issue" \
      "$depends_on_issue" \
      "Failed to persist approved decision state on ${issue_id}"
  fi

  if ! bd_comment_add "$issue_id" "Approved dependency: ${dependent_issue} depends on ${depends_on_issue}. ${rationale}" > /dev/null; then
    rollback_and_die \
      "$dependent_issue" \
      "$depends_on_issue" \
      "Failed to record approval rationale on ${issue_id}"
  fi

  echo "Approved dependency applied: ${dependent_issue} depends on ${depends_on_issue}"
  echo "Graph:"
  printf '%s\n' "$graph_output"
  echo "Ready impact:"
  printf '%s\n' "$ready_output"
}

cmd_store_contracts() {
  if [[ $# -lt 2 ]]; then
    echo "Usage: dep-guard.sh store-contracts <issue-id> <contracts-string>" >&2
    exit 1
  fi

  local issue_id
  issue_id="$(sanitize "$1")"
  local contracts="$2"

  if [[ -z "$contracts" ]]; then
    die "Contracts string cannot be empty"
  fi

  contracts="$(sanitize "$contracts")"

  # Validate issue exists
  bd_show_json "$issue_id" > /dev/null

  # Store contracts metadata with timestamp for deduplication.
  # bd only supports --append-notes (no replace), so we prefix with a timestamp.
  # Consumers (check-ripple) should use the LATEST contracts: line and ignore older ones.
  local ts
  ts="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  if ! bd_update "$issue_id" --append-notes "contracts@${ts}: ${contracts}" > /dev/null; then
    die "Failed to store contracts on issue ${issue_id}"
  fi

  echo "Contracts stored on ${issue_id} (${ts})"
}

cmd_extract_contracts() {
  if [[ $# -lt 1 ]]; then
    echo "Usage: dep-guard.sh extract-contracts <file-path>" >&2
    exit 1
  fi

  local task_file="$1"

  # Validate file exists
  if [[ ! -f "$task_file" ]]; then
    die "File does not exist: ${task_file}"
  fi

  # Check that file contains at least one ## Task header
  if ! grep -q '^## Task' "$task_file"; then
    die "No tasks found in ${task_file}"
  fi

  # Parse task blocks using line-by-line bash processing.
  # For each task: collect File(s) paths and function names from "What to implement".
  local current_files=""
  local current_what=""
  local in_what=0
  local all_contracts=""

  while IFS= read -r line || [[ -n "$line" ]]; do
    # New task block Ã¢â‚¬â€ flush previous
    if [[ "$line" =~ ^##\ Task ]]; then
      local _emitted
      _emitted="$(emit_contracts "$current_files" "$current_what")"
      [[ -n "$_emitted" ]] && all_contracts="${all_contracts}${_emitted}"$'\n'
      current_files=""
      current_what=""
      in_what=0
      continue
    fi

    # File(s): line
    if [[ "$line" =~ ^File\(s\): ]]; then
      current_files="${line#File(s):}"
      current_files="$(printf '%s' "$current_files" | sed 's/^[[:space:]]*//')"
      in_what=0
      continue
    fi

    # What to implement: line
    if [[ "$line" =~ ^What\ to\ implement: ]]; then
      current_what="${line#What to implement:}"
      current_what="$(printf '%s' "$current_what" | sed 's/^[[:space:]]*//')"
      in_what=1
      continue
    fi

    # Continue what section (stop at section boundaries)
    if [[ $in_what -eq 1 ]]; then
      if [[ "$line" =~ ^(##\ Task|File\(s\):|What\ to\ implement:|TDD\ |Expected\ output|---) ]]; then
        in_what=0
        continue
      fi
      current_what="${current_what} ${line}"
      continue
    fi
  done < "$task_file"

  # Flush the last task block
  local _emitted
  _emitted="$(emit_contracts "$current_files" "$current_what")"
  [[ -n "$_emitted" ]] && all_contracts="${all_contracts}${_emitted}"$'\n'

  # Deduplicate and sort
  local contracts
  contracts="$(printf '%s' "$all_contracts" | grep -v '^$' | sort -u)"

  if [[ -z "$contracts" ]]; then
    echo "No contracts found" >&2
    exit 1
  fi

  printf '%s\n' "$contracts"
}

# Ã¢â€â‚¬Ã¢â€â‚¬ Main dispatcher Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬

if [[ $# -lt 1 ]]; then
  usage
fi

subcommand="$1"
shift

case "$subcommand" in
  find-consumers)     cmd_find_consumers "$@" ;;
  check-ripple)       cmd_check_ripple "$@" ;;
  apply-decision)     cmd_apply_decision "$@" ;;
  store-contracts)    cmd_store_contracts "$@" ;;
  extract-contracts)  cmd_extract_contracts "$@" ;;
  *)
    echo "Error: Unknown subcommand '${subcommand}'" >&2
    usage
    ;;
esac
