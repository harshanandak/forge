#!/usr/bin/env bash
# beads-context.sh — Helper script to manage Beads issue context
# for the Forge 7-stage workflow.
#
# Subcommands:
#   set-design       <issue-id> <task-count> <task-file-path>
#   set-acceptance   <issue-id> "<criteria-text>"
#   update-progress  <issue-id> <task-num> <total> "<title>" <commit-sha> <test-count> <gate-count>
#   parse-progress   <issue-id>
#   stage-transition <issue-id> <completed-stage> <next-stage>
#
# Cross-platform: works on Windows (Git Bash), macOS, and Linux.
# OWASP A03: All variables properly quoted to prevent shell injection.

set -euo pipefail

# ── Helpers ──────────────────────────────────────────────────────────────

usage() {
  cat >&2 <<'EOF'
Usage: beads-context.sh <subcommand> [args...]

Subcommands:
  set-design       <issue-id> <task-count> <task-file-path>
  set-acceptance   <issue-id> "<criteria-text>"
  update-progress  <issue-id> <task-num> <total> "<title>" <commit-sha> <test-count> <gate-count>
  parse-progress   <issue-id>
  stage-transition <issue-id> <completed-stage> <next-stage>
EOF
  exit 1
}

die() {
  echo "Error: $1" >&2
  exit 1
}

# Sanitize a string: strip double quotes and replace newlines with spaces
sanitize() {
  local val="$1"
  # Remove double quotes
  val="${val//\"/}"
  # Replace newlines with spaces
  val="$(printf '%s' "$val" | tr '\n' ' ')"
  printf '%s' "$val"
}

# Run bd update and check for errors in both exit code and output.
# bd update exits 0 even for non-existent issues, so we check stdout too.
bd_update() {
  local output
  output="$(bd update "$@" 2>&1)"
  local rc=$?

  if [[ $rc -ne 0 ]]; then
    echo "$output" >&2
    return 1
  fi

  # bd prints "Error resolving ..." to stdout for non-existent issues
  if printf '%s' "$output" | grep -qi 'error'; then
    echo "$output" >&2
    return 1
  fi

  echo "$output"
  return 0
}

# Run bd comments add and check for errors similarly.
bd_comment() {
  local output
  output="$(bd comments add "$@" 2>&1)"
  local rc=$?

  if [[ $rc -ne 0 ]]; then
    echo "$output" >&2
    return 1
  fi

  if printf '%s' "$output" | grep -qi 'error'; then
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
  local task_count="$2"
  local task_file="$3"

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
  local criteria="$2"

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
  local task_num="$2"
  local total="$3"
  local raw_title="$4"
  local commit_sha="$5"
  local test_count="$6"
  local gate_count="$7"

  # Sanitize the title (OWASP A03)
  local title
  title="$(sanitize "$raw_title")"

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

  # Get the issue JSON
  local json
  json="$(bd show "$issue_id" --json 2>&1)" || die "Failed to show issue ${issue_id}"

  # Extract notes field from JSON (handle both compact and pretty-printed)
  # The JSON notes field contains literal \n between entries
  local notes
  notes="$(printf '%s' "$json" | grep -o '"notes": *"[^"]*"' | head -1 | sed 's/^"notes": *"//;s/"$//' || true)"

  if [[ -z "$notes" ]]; then
    echo "No progress data"
    return 0
  fi

  # Split on literal \n (two chars: backslash + n) and count task lines
  # Use echo -e to expand the \n into actual newlines for grep
  local expanded
  expanded="$(echo -e "$notes")"

  local task_lines
  task_lines="$(echo "$expanded" | grep -c 'Task [0-9]*/[0-9]* done:' || true)"

  if [[ "$task_lines" -eq 0 ]]; then
    echo "No progress data"
    return 0
  fi

  # Get the last task line
  local last_line
  last_line="$(echo "$expanded" | grep 'Task [0-9]*/[0-9]* done:' | tail -1)"

  # Extract total (N/M) from last line
  local total
  total="$(echo "$last_line" | grep -o '[0-9]*/[0-9]*' | head -1 | cut -d/ -f2)"

  # Extract last task title (between "done: " and " |")
  local last_title
  last_title="$(echo "$last_line" | sed 's/.*done: //;s/ |.*//')"

  # Extract commit sha — 4th pipe-separated field
  # Format: "Task N/M done: <title> | <test_count> tests | <sha> | <gate_count> gates"
  local last_sha
  last_sha="$(echo "$last_line" | awk -F ' \\| ' '{print $3}' | sed 's/^ *//;s/ *$//')"

  echo "${task_lines}/${total} tasks done | Last: ${last_title} (${last_sha})"
}

cmd_stage_transition() {
  if [[ $# -lt 3 ]]; then
    echo "Usage: beads-context.sh stage-transition <issue-id> <completed-stage> <next-stage>" >&2
    exit 1
  fi

  local issue_id="$1"
  local completed="$2"
  local next="$3"

  local comment="Stage: ${completed} complete → ready for ${next}"

  if ! bd_comment "$issue_id" "$comment" > /dev/null; then
    die "Failed to record stage transition on issue ${issue_id}"
  fi

  echo "Stage transition recorded on ${issue_id}: ${completed} → ${next}"
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
  *)
    echo "Error: Unknown subcommand '${subcommand}'" >&2
    usage
    ;;
esac
