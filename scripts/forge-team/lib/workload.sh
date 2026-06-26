#!/usr/bin/env bash
# scripts/forge-team/lib/workload.sh — Per-developer active issue views
#
# Shows team workload grouped by developer, with stale/blocked flags.
#
# Functions:
#   cmd_workload  — Main entry point for `forge team workload`
#
# Env overrides (for testing):
#   FORGE_CMD       — Path to forge binary
#   GH_CMD          — Path to gh binary
#   WORKLOAD_NOW    — Override "now" timestamp for testing (ISO 8601)
#
# This file does NOT set errexit/pipefail — callers manage their own shell options.

# Guard against double-sourcing
if [[ -n "${_WORKLOAD_LIB_LOADED:-}" ]]; then
  return 0 2>/dev/null || true
fi
_WORKLOAD_LIB_LOADED=1

_WORKLOAD_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Source dependencies
if [[ -f "$_WORKLOAD_DIR/agent-prompt.sh" ]]; then
  source "$_WORKLOAD_DIR/agent-prompt.sh"
fi

if [[ -f "$_WORKLOAD_DIR/identity.sh" ]]; then
  source "$_WORKLOAD_DIR/identity.sh"
fi

# ── Internal helpers ─────────────────────────────────────────────────────

# _workload_error <message>
_workload_error() {
  if declare -f agent_error &>/dev/null; then
    agent_error "$1"
  else
    echo "ERROR: $1" >&2
  fi
}

# _workload_now_epoch — Returns current epoch seconds (overridable via WORKLOAD_NOW)
_workload_now_epoch() {
  if [[ -n "${WORKLOAD_NOW:-}" ]]; then
    date -d "$WORKLOAD_NOW" '+%s' 2>/dev/null || date -j -f '%Y-%m-%dT%H:%M:%SZ' "$WORKLOAD_NOW" '+%s' 2>/dev/null
  else
    date '+%s'
  fi
}

# _parse_epoch <iso-timestamp> — Convert ISO 8601 to epoch seconds
_parse_epoch() {
  local ts="$1"
  date -d "$ts" '+%s' 2>/dev/null || date -j -f '%Y-%m-%dT%H:%M:%SZ' "$ts" '+%s' 2>/dev/null
}

# _hours_since <iso-timestamp> — Hours elapsed since given timestamp
_hours_since() {
  local ts="$1"
  local now_epoch ts_epoch diff_seconds
  now_epoch="$(_workload_now_epoch)"
  ts_epoch="$(_parse_epoch "$ts")"
  diff_seconds=$(( now_epoch - ts_epoch ))
  echo $(( diff_seconds / 3600 ))
}

# _status_icon <status> — Return display icon for status
_status_icon() {
  local status="$1"
  case "${status^^}" in
    IN_PROGRESS) echo "◐" ;;
    OPEN)        echo "○" ;;
    BLOCKED)     echo "⚠" ;;
    *)           echo "○" ;;
  esac
}

_json_escape() {
  local value="${1:-}"
  value="${value//\\/\\\\}"
  value="${value//\"/\\\"}"
  value="${value//$'\n'/\\n}"
  value="${value//$'\r'/\\r}"
  value="${value//$'\t'/\\t}"
  printf '%s' "$value"
}

# _collect_issues — Gather all open/in_progress issues with details
# Outputs lines: id|title|status|owner|updated|depends_on
#
# The Kernel list filter does not accept comma-joined statuses, so query each
# active status separately and concatenate the JSON issue arrays. Every field
# the workload view needs (status, assignee, updated_at, dependencies) is
# present in `issue list --json`, so no per-issue lookup is required.
_collect_issues() {
  local forge_cmd="${FORGE_CMD:-forge}"
  local open_json inprog_json issues_json

  open_json="$("$forge_cmd" issue list --status=open --json 2>/dev/null)" || open_json=""
  inprog_json="$("$forge_cmd" issue list --status=in_progress --json 2>/dev/null)" || inprog_json=""

  issues_json="$(jq -n \
    --argjson a "${open_json:-null}" \
    --argjson b "${inprog_json:-null}" \
    '((($a.data.issues) // []) + (($b.data.issues) // []))' 2>/dev/null)" || issues_json="[]"

  # A Kernel issue's `.dependencies` lists the issues it BLOCKS (outgoing), so
  # depends_on (the issues that block THIS one) is a reverse scan: issues within
  # the active set whose `.dependencies` include this issue.
  printf '%s' "$issues_json" | jq -r '
    . as $all
    | $all[]
    | . as $x
    | [ $x.id,
        ($x.title // ""),
        (($x.status // "open") | ascii_upcase),
        ($x.assignee // $x.claimed_by // "unassigned"),
        (($x.updated_at // "") | sub("\\.[0-9]+Z$"; "Z")),
        ( [ $all[]
            | select( (.dependencies // [])
                | map(if type == "object" then (.id // .to // "") else . end)
                | any(. == $x.id) )
            | .id ]
          | join(",") )
      ]
    | join("|")' | tr -d '\r'
}

# ── Public API ───────────────────────────────────────────────────────────

# cmd_workload [--developer=<user>] [--me] [--format=json]
# Shows team workload grouped by developer.
cmd_workload() {
  local filter_developer=""
  local format="text"

  # Parse arguments
  while [[ $# -gt 0 ]]; do
    local arg="${1%$'\r'}"
    case "$arg" in
      --developer=*)
        filter_developer="${arg#--developer=}"
        shift
        ;;
      --me)
        local me
        if ! me="$(get_github_user)"; then
          _workload_error "Cannot determine current user. Run 'gh auth login'."
          return 1
        fi
        filter_developer="$me"
        shift
        ;;
      --format=json)
        format="json"
        shift
        ;;
      --format=*)
        _workload_error "Unsupported format: ${arg#--format=}"
        return 1
        ;;
      *)
        _workload_error "Unknown argument: $arg"
        return 1
        ;;
    esac
  done

  # Collect all issues
  local issues_data
  issues_data="$(_collect_issues)"

  # Check if no issues
  if [[ -z "$issues_data" ]] || [[ -z "$(echo "$issues_data" | tr -d '[:space:]')" ]]; then
    if [[ "$format" == "json" ]]; then
      echo "{}"
    else
      echo "No active work"
    fi
    return 0
  fi

  # Build associative arrays: developer -> list of issues
  # Using temp files for portability (associative arrays need bash 4+)
  local work_dir
  work_dir="$(mktemp -d)"

  while IFS='|' read -r issue_id title status owner updated depends_on; do
    [[ -z "$issue_id" ]] && continue

    # Apply developer filter
    if [[ -n "$filter_developer" ]] && [[ "$owner" != "$filter_developer" ]]; then
      continue
    fi

    # Build display line
    local icon hours_ago stale_flag blocked_flag display_status
    icon="$(_status_icon "$status")"
    display_status="$status"

    # Check stale (>48h since last update)
    stale_flag=""
    if [[ -n "$updated" ]]; then
      hours_ago="$(_hours_since "$updated")"
      if [[ "$hours_ago" -gt 48 ]]; then
        stale_flag=" (stale: ${hours_ago}h)"
      fi
    fi

    # Check blocked
    blocked_flag=""
    if [[ -n "$depends_on" ]]; then
      blocked_flag=" (blocked by ${depends_on})"
    fi

    # Format the issue line
    local formatted_title="${title}${stale_flag}${blocked_flag}"
    local issue_line="  ${icon} ${issue_id}  ${display_status}  ${formatted_title}"

    # Store in temp file per developer
    mkdir -p "$work_dir/devs"
    echo "$issue_line" >> "$work_dir/devs/${owner}"

    # Store structured data for JSON output
    if [[ "$format" == "json" ]]; then
      mkdir -p "$work_dir/json"
      local stale_bool="false"
      [[ -n "$stale_flag" ]] && stale_bool="true"
      local blocked_ids=""
      [[ -n "$depends_on" ]] && blocked_ids="$depends_on"
      printf '{"id":"%s","title":"%s","status":"%s","updated":"%s","stale":%s,"blocked_by":"%s"}\n' \
        "$(_json_escape "$issue_id")" \
        "$(_json_escape "$title")" \
        "$(_json_escape "$status")" \
        "$(_json_escape "$updated")" \
        "$stale_bool" \
        "$(_json_escape "$blocked_ids")" \
        >> "$work_dir/json/${owner}"
    fi
  done <<< "$issues_data"

  # Check if filter yielded no results
  if [[ ! -d "$work_dir/devs" ]] || [[ -z "$(ls -A "$work_dir/devs" 2>/dev/null)" ]]; then
    if [[ "$format" == "json" ]]; then
      echo "{}"
    else
      echo "No active work"
    fi
    rm -rf "$work_dir"
    return 0
  fi

  # Output
  if [[ "$format" == "json" ]]; then
    # Build JSON object: { "devone": [...], "devtwo": [...] }
    local first_dev="true"
    printf '{'
    for dev_file in "$work_dir/json"/*; do
      local dev_name
      dev_name="$(basename "$dev_file")"
      local first_issue="true"
      if [[ "$first_dev" == "true" ]]; then
        first_dev="false"
      else
        printf ','
      fi
      printf '"%s":[' "$(_json_escape "$dev_name")"
      while IFS= read -r issue_json; do
        [[ -z "$issue_json" ]] && continue
        if [[ "$first_issue" == "true" ]]; then
          first_issue="false"
        else
          printf ','
        fi
        printf '%s' "$issue_json"
      done < "$dev_file"
      printf ']'
    done
    printf '}\n'
  else
    local first_dev=true
    for dev_file in "$work_dir/devs"/*; do
      local dev_name
      dev_name="$(basename "$dev_file")"
      if [[ "$first_dev" == "true" ]]; then
        first_dev=false
      else
        echo ""
      fi
      echo "Developer: ${dev_name}"
      cat "$dev_file"
    done
  fi

  rm -rf "$work_dir"
  return 0
}
