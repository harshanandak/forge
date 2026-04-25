#!/usr/bin/env bash
# beads-context.sh — Helper script to manage Beads issue context
# for the Forge 7-stage workflow.
#
# Subcommands:
#   set-design       <issue-id> <task-count> <task-file-path>
#   set-acceptance   <issue-id> "<criteria-text>"
#   update-progress  <issue-id> <task-num> <total> "<title>" <commit-sha> <test-count> <gate-count>
#   parse-progress   <issue-id>
#   stage-transition <issue-id> <completed-stage> <next-stage> [--summary "..."] [--decisions "..."] [--artifacts "..."] [--next "..."] [--workflow-state "{...}"]
#   validate         <issue-id>
#
# Cross-platform: works on Windows (Git Bash), macOS, and Linux.
# OWASP A03: All variables properly quoted to prevent shell injection.

set -euo pipefail

# Source shared sanitize library
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/lib/sanitize.sh"

# ── Helpers ──────────────────────────────────────────────────────────────

usage() {
  cat >&2 <<'EOF'
Usage: beads-context.sh <subcommand> [args...]

Subcommands:
  set-design       <issue-id> <task-count> <task-file-path>
  set-acceptance   <issue-id> "<criteria-text>"
  update-progress  <issue-id> <task-num> <total> "<title>" <commit-sha> <test-count> <gate-count>
  parse-progress   <issue-id>
  stage-transition <issue-id> <completed-stage> <next-stage> [--summary "..."] [--decisions "..."] [--artifacts "..."] [--next "..."] [--workflow-state "{...}"]
  validate         <issue-id>
EOF
  exit 1
}

die() {
  echo "Error: $1" >&2
  exit 1
}

# Resolve a Windows bd.exe installation for bash-based helper flows.
# This covers WSL/Git Bash cases where PowerShell can run bd.exe but bash PATH
# does not include the Windows install directory.
convert_windows_path() {
  local raw="${1%$'\r'}"

  if [[ -z "$raw" ]]; then
    return 1
  fi

  if [[ ! "$raw" =~ ^[A-Za-z]:\\ ]]; then
    printf '%s' "$raw"
    return 0
  fi

  if command -v wslpath >/dev/null 2>&1; then
    wslpath -u "$raw" 2>/dev/null && return 0
  fi

  if command -v cygpath >/dev/null 2>&1; then
    cygpath -u "$raw" 2>/dev/null && return 0
  fi

  local drive rest
  drive="$(printf '%s' "$raw" | cut -c1 | tr '[:upper:]' '[:lower:]')"
  rest="${raw:2}"
  rest="${rest//\\//}"
  printf '/mnt/%s%s' "$drive" "$rest"
}

is_runnable_bd_candidate() {
  local candidate="${1:-}"

  if [[ -z "$candidate" || ! -f "$candidate" ]]; then
    return 1
  fi

  [[ -x "$candidate" || "$candidate" == *.exe ]]
}

resolve_bd_cmd() {
  local candidate=""
  local converted=""

  if [[ -n "${BD_CMD:-}" ]]; then
    if [[ "${BD_CMD}" == *"/"* || "${BD_CMD}" == *"\\"* ]]; then
      converted="$(convert_windows_path "$BD_CMD")"
      if is_runnable_bd_candidate "$converted"; then
        printf '%s' "$converted"
        return 0
      fi

      is_runnable_bd_candidate "$BD_CMD" || return 1
    fi
    printf '%s' "$BD_CMD"
    return 0
  fi

  if command -v bd >/dev/null 2>&1; then
    printf '%s' "bd"
    return 0
  fi

  if command -v bd.exe >/dev/null 2>&1; then
    printf '%s' "bd.exe"
    return 0
  fi

  for candidate in \
    "$HOME/.local/bin/bd" \
    "$HOME/.local/bin/bd.exe" \
    "$HOME/.bun/bin/bd" \
    "$HOME/.bun/bin/bd.exe"
  do
    if is_runnable_bd_candidate "$candidate"; then
      printf '%s' "$candidate"
      return 0
    fi
  done

  if command -v where.exe >/dev/null 2>&1; then
    while IFS= read -r candidate; do
      candidate="${candidate%$'\r'}"
      [[ -z "$candidate" ]] && continue

      converted="$(convert_windows_path "$candidate")"
      if is_runnable_bd_candidate "$converted"; then
        printf '%s' "$converted"
        return 0
      fi

      if is_runnable_bd_candidate "$candidate"; then
        printf '%s' "$candidate"
        return 0
      fi
    done < <(where.exe bd 2>/dev/null || true)
  fi

  return 1
}

BD=""

get_bd_cmd() {
  if [[ -z "$BD" ]]; then
    BD="$(resolve_bd_cmd)" || die "bd is required but not found"
  fi

  printf '%s' "$BD"
}

# Run bd update and check for errors in both exit code and output.
# bd update exits 0 even for non-existent issues, so we check stdout too.
bd_update() {
  local bd_cmd
  bd_cmd="$(get_bd_cmd)"
  local output
  output="$("$bd_cmd" update "$@" 2>&1)"
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

# Run bd comments add and check for errors similarly.
bd_comment() {
  local bd_cmd
  bd_cmd="$(get_bd_cmd)"
  local output
  output="$("$bd_cmd" comments add "$@" 2>&1)"
  local rc=$?

  if [[ $rc -ne 0 ]]; then
    echo "$output" >&2
    return 1
  fi

  # Use specific error patterns to avoid false positives from data containing "error"
  if printf '%s' "$output" | grep -Eqi '^Error|Error resolving|Error adding'; then
    echo "$output" >&2
    return 1
  fi

  echo "$output"
  return 0
}

# ── Subcommands ──────────────────────────────────────────────────────────

cmd_set_design() {
  if [[ $# -lt 3 ]]; then
    echo "Usage: beads-context.sh set-design <issue-id> <task-count> <task-file-path>" >&2
    exit 1
  fi

  local issue_id="$1"
  local task_count
  task_count="$(sanitize "$2")"
  local task_file
  task_file="$(sanitize "$3")"

  local design_text="${task_count} tasks | ${task_file}"

  if ! bd_update "$issue_id" --design "$design_text" > /dev/null; then
    die "Failed to set design on issue ${issue_id}"
  fi

  echo "Design set on ${issue_id}: ${design_text}"
}

cmd_set_acceptance() {
  if [[ $# -lt 2 ]]; then
    echo "Usage: beads-context.sh set-acceptance <issue-id> \"<criteria-text>\"" >&2
    exit 1
  fi

  local issue_id="$1"
  local criteria
  criteria="$(sanitize "$2")"

  if ! bd_update "$issue_id" --acceptance "$criteria" > /dev/null; then
    die "Failed to set acceptance on issue ${issue_id}"
  fi

  echo "Acceptance criteria set on ${issue_id}"
}

cmd_update_progress() {
  if [[ $# -lt 7 ]]; then
    echo "Usage: beads-context.sh update-progress <issue-id> <task-num> <total> \"<title>\" <commit-sha> <test-count> <gate-count>" >&2
    exit 1
  fi

  local issue_id="$1"
  local task_num
  task_num="$(sanitize "$2")"
  local total
  total="$(sanitize "$3")"
  local title
  title="$(sanitize "$4")"
  local commit_sha
  commit_sha="$(sanitize "$5")"
  local test_count
  test_count="$(sanitize "$6")"
  local gate_count
  gate_count="$(sanitize "$7")"

  # Strip backslashes from progress fields only — these are read back via
  # printf '%b' in parse-progress, where \n/\t would expand into real escapes.
  # Other commands (set-design, set-acceptance, stage-transition) keep backslashes
  # intact to preserve Windows-style paths like docs\plans\tasks.md.
  task_num="${task_num//\\/}"
  total="${total//\\/}"
  title="${title//\\/}"
  commit_sha="${commit_sha//\\/}"
  test_count="${test_count//\\/}"
  gate_count="${gate_count//\\/}"

  local note="Task ${task_num}/${total} done: ${title} | ${test_count} tests | ${commit_sha} | ${gate_count} gates"

  if ! bd_update "$issue_id" --append-notes "$note" > /dev/null; then
    die "Failed to update progress on issue ${issue_id}"
  fi

  echo "Progress updated on ${issue_id}: Task ${task_num}/${total}"
}

cmd_parse_progress() {
  if [[ $# -lt 1 ]]; then
    echo "Usage: beads-context.sh parse-progress <issue-id>" >&2
    exit 1
  fi

  local issue_id="$1"
  local bd_cmd
  bd_cmd="$(get_bd_cmd)"

  # Get the issue JSON — detect non-existent issues
  local json
  json="$("$bd_cmd" show "$issue_id" --json 2>&1)" || die "Failed to show issue ${issue_id}"

  # bd show may exit 0 but print an error for non-existent issues
  # Match specific bd error patterns, not the word "error" in data fields
  if printf '%s' "$json" | grep -Eqi '^Error (fetching|resolving)'; then
    die "Issue not found: ${issue_id}"
  fi

  # bd show returns "[]" or empty for non-existent issues
  if [[ -z "$json" || "$json" == "[]" || "$json" == "null" ]]; then
    die "Issue not found: ${issue_id}"
  fi

  # Extract notes field from JSON — prefer jq if available, fall back to grep/sed
  local notes
  if command -v jq &>/dev/null; then
    # Handle both array ([{...}]) and object ({...}) responses from bd show
    notes="$(printf '%s' "$json" | jq -r 'if type == "array" then .[0].notes else .notes end // empty' 2>/dev/null || true)"
  else
    notes="$(printf '%s' "$json" | grep -o '"notes": *"[^"]*"' | head -1 | sed 's/^"notes": *"//;s/"$//' || true)"
  fi

  if [[ -z "$notes" ]]; then
    echo "No progress data"
    return 0
  fi

  # Split on literal \n (two chars: backslash + n) and count task lines
  # Use printf to expand the \n into actual newlines for grep (POSIX-compliant)
  local expanded
  expanded="$(printf '%b' "$notes")"

  local task_lines
  task_lines="$(echo "$expanded" | grep -c 'Task [0-9]*/[0-9]* done:' || true)"

  if [[ "$task_lines" -eq 0 ]]; then
    echo "No progress data"
    return 0
  fi

  # Get the last task line
  local last_line
  last_line="$(echo "$expanded" | grep 'Task [0-9]*/[0-9]* done:' | tail -1 || true)"

  # Extract total (N/M) from last line
  local total
  total="$(echo "$last_line" | grep -o '[0-9]*/[0-9]*' | head -1 | cut -d/ -f2)"

  # Extract last task title (between "done: " and " |")
  local last_title
  last_title="$(echo "$last_line" | sed 's/.*done: //;s/ |.*//')"

  # Extract commit sha — 4th pipe-separated field
  # Format: "Task N/M done: <title> | <test_count> tests | <sha> | <gate_count> gates"
  local last_sha
  # Use [|] character class for portable literal pipe matching across gawk and BSD awk
  last_sha="$(echo "$last_line" | awk -F ' [|] ' '{print $3}' | sed 's/^ *//;s/ *$//')"

  echo "${task_lines}/${total} tasks done | Last: ${last_title} (${last_sha})"
}

cmd_stage_transition() {
  if [[ $# -lt 3 ]]; then
    echo "Usage: beads-context.sh stage-transition <issue-id> <completed-stage> <next-stage> [--summary \"...\"] [--decisions \"...\"] [--artifacts \"...\"] [--next \"...\"] [--workflow-state \"{...}\"]" >&2
    exit 1
  fi

  local issue_id="$1"
  local completed
  completed="$(sanitize "$2")"
  local next
  next="$(sanitize "$3")"
  shift 3

  # Parse optional flags
  local flag_summary="" flag_decisions="" flag_artifacts="" flag_next="" flag_workflow_state=""
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --summary)
        shift
        flag_summary="$(sanitize "${1:-}")"
        ;;
      --decisions)
        shift
        flag_decisions="$(sanitize "${1:-}")"
        ;;
      --artifacts)
        shift
        flag_artifacts="$(sanitize "${1:-}")"
        ;;
      --next)
        shift
        flag_next="$(sanitize "${1:-}")"
        ;;
      --workflow-state)
        shift
        flag_workflow_state="$(sanitize_config_value "${1:-}")"
        ;;
      *)
        # Ignore unknown flags for forward compatibility
        ;;
    esac
    shift
  done

  # Build comment: header line always present
  local comment="Stage: ${completed} complete → ready for ${next}"

  # Append structured fields only if provided
  if [[ -n "$flag_summary" ]]; then
    comment="${comment}
Summary: ${flag_summary}"
  fi
  if [[ -n "$flag_decisions" ]]; then
    comment="${comment}
Decisions: ${flag_decisions}"
  fi
  if [[ -n "$flag_artifacts" ]]; then
    comment="${comment}
Artifacts: ${flag_artifacts}"
  fi
  if [[ -n "$flag_next" ]]; then
    comment="${comment}
Next: ${flag_next}"
  fi
  if [[ -n "$flag_workflow_state" ]]; then
    comment="${comment}
WorkflowState: ${flag_workflow_state}"
  fi

  if ! bd_comment "$issue_id" "$comment" > /dev/null; then
    die "Failed to record stage transition on issue ${issue_id}"
  fi

  echo "Stage transition recorded on ${issue_id}: ${completed} → ${next}"
}

cmd_validate() {
  if [[ $# -lt 1 ]]; then
    echo "Usage: beads-context.sh validate <issue-id>" >&2
    exit 1
  fi

  local issue_id="$1"
  local warnings=0
  local bd_cmd
  bd_cmd="$(get_bd_cmd)"

  # Get issue JSON
  local json
  json="$("$bd_cmd" show "$issue_id" --json 2>&1)" || {
    echo "Error: Failed to retrieve issue ${issue_id}" >&2
    exit 1
  }

  # Check for bd error patterns
  if printf '%s' "$json" | grep -Eqi '^Error|Error resolving|Error fetching'; then
    echo "Error: Issue not found: ${issue_id}" >&2
    exit 1
  fi

  if [[ -z "$json" || "$json" == "[]" || "$json" == "null" ]]; then
    echo "Error: Issue not found: ${issue_id}" >&2
    exit 1
  fi

  # Extract fields — prefer jq, fall back to grep/sed
  local description="" design=""
  if command -v jq &>/dev/null; then
    description="$(printf '%s' "$json" | jq -r 'if type == "array" then .[0].description else .description end // empty' 2>/dev/null || true)"
    design="$(printf '%s' "$json" | jq -r 'if type == "array" then .[0].design else .design end // empty' 2>/dev/null || true)"
  else
    description="$(printf '%s' "$json" | grep -o '"description": *"[^"]*"' | head -1 | sed 's/^"description": *"//;s/"$//' || true)"
    design="$(printf '%s' "$json" | grep -o '"design": *"[^"]*"' | head -1 | sed 's/^"design": *"//;s/"$//' || true)"
  fi

  # Check 1: Issue has description
  if [[ -z "$description" ]]; then
    echo "Warning: Issue ${issue_id} has no description"
    warnings=$((warnings + 1))
  fi

  # Get comments to check for stage transitions
  local comments
  comments="$("$bd_cmd" comments "$issue_id" 2>/dev/null || true)"

  # Check 2: At least one stage transition exists
  local has_transition=false
  if echo "$comments" | grep -q 'Stage:.*complete'; then
    has_transition=true
  fi

  if [[ "$has_transition" == "false" ]]; then
    echo "Warning: No stage transition found on issue ${issue_id}"
    warnings=$((warnings + 1))
  fi

  # Check 3: Most recent transition has summary
  # Isolate the last transition block to avoid false-positives from earlier summaries
  if [[ "$has_transition" == "true" ]]; then
    local has_summary=false
    local last_block
    last_block="$(echo "$comments" | awk '/Stage:.*complete/{found=1; block=""} found{block=block"\n"$0} END{print block}')"
    if echo "$last_block" | grep -q 'Summary:'; then
      has_summary=true
    fi
    if [[ "$has_summary" == "false" ]]; then
      echo "Warning: Most recent stage transition has no summary on issue ${issue_id}"
      warnings=$((warnings + 1))
    fi
  fi

  # Check 4: Design metadata is set if past plan stage
  # "Past plan" means there's a transition FROM plan or any later stage
  local past_plan=false
  if echo "$comments" | grep -q 'Stage: plan complete'; then
    past_plan=true
  fi
  if echo "$comments" | grep -Eq 'Stage: (dev|validate|ship|review|premerge) complete'; then
    past_plan=true
  fi

  if [[ "$past_plan" == "true" && -z "$design" ]]; then
    echo "Warning: Design metadata not set on issue ${issue_id} (past plan stage)"
    warnings=$((warnings + 1))
  fi

  # Summary
  if [[ $warnings -eq 0 ]]; then
    echo "All context fields present on issue ${issue_id}"
  else
    echo "${warnings} warning(s) found on issue ${issue_id}"
  fi

  # Always exit 0 — advisory only
  exit 0
}

# ── Main dispatcher ──────────────────────────────────────────────────────

if [[ $# -lt 1 ]]; then
  usage
fi

subcommand="$1"
shift

case "$subcommand" in
  set-design)       cmd_set_design "$@" ;;
  set-acceptance)   cmd_set_acceptance "$@" ;;
  update-progress)  cmd_update_progress "$@" ;;
  parse-progress)   cmd_parse_progress "$@" ;;
  stage-transition) cmd_stage_transition "$@" ;;
  validate)         cmd_validate "$@" ;;
  *)
    echo "Error: Unknown subcommand '${subcommand}'" >&2
    usage
    ;;
esac
