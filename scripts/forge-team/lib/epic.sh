#!/usr/bin/env bash
# scripts/forge-team/lib/epic.sh — Epic rollup view
#
# Shows epic progress with per-developer breakdown and blocked issue tracking.
#
# Functions:
#   cmd_epic  — Top-level dispatcher entry point
#
# Env overrides (for testing):
#   BD_CMD   — Path to bd binary
#
# This file does NOT set errexit/pipefail — callers manage their own shell options.

# Guard against double-sourcing
if [[ -n "${_EPIC_LIB_LOADED:-}" ]]; then
  return 0 2>/dev/null || true
fi
_EPIC_LIB_LOADED=1

# ── Internal helpers ─────────────────────────────────────────────────────

# _epic_get_bd — Returns the bd command path
_epic_get_bd() {
  printf '%s' "${BD_CMD:-bd}"
}

# _epic_parse_blocks <bd-show-output>
# Extracts child issue IDs from the BLOCKS section.
# Each line in BLOCKS looks like: ← ✓ forge-child1: Child 1 (closed)
# Returns one ID per line.
_epic_parse_blocks() {
  local bd_output="$1"
  local in_blocks=0

  while IFS= read -r line; do
    if [[ "$line" == "BLOCKS" ]]; then
      in_blocks=1
      continue
    fi
    # Stop at next section header (non-indented, non-empty line after BLOCKS)
    if [[ $in_blocks -eq 1 ]]; then
      if [[ -z "$line" ]]; then
        continue
      fi
      if [[ "$line" =~ ^[A-Z] ]]; then
        break
      fi
      # Extract issue ID: matches forge-XXXX pattern after the arrow+status marker
      local child_id
      child_id="$(printf '%s' "$line" | sed -n 's/.*← [^ ]* \([a-z0-9-]*\):.*/\1/p')"
      if [[ -n "$child_id" ]]; then
        printf '%s\n' "$child_id"
      fi
    fi
  done <<< "$bd_output"
}

# _epic_get_child_info <child-id>
# Returns: id|status|owner|title|blocked_by
_epic_get_child_info() {
  local child_id="$1"
  local bd_cmd
  bd_cmd="$(_epic_get_bd)"

  local child_output
  child_output="$("$bd_cmd" show "$child_id" 2>/dev/null)" || return 1

  local first_line
  first_line="$(printf '%s' "$child_output" | head -1)"

  # Parse status from the first character/marker
  local status="open"
  if [[ "$first_line" == *"CLOSED"* ]] || [[ "$first_line" == *"✓"* ]]; then
    status="closed"
  elif [[ "$first_line" == *"IN_PROGRESS"* ]] || [[ "$first_line" == *"◐"* ]]; then
    status="in_progress"
  fi

  # Parse title — between · and [
  local title
  title="$(printf '%s' "$first_line" | sed -n 's/^[^ ]* [^ ]* · \(.*\) \[.*/\1/p')"
  if [[ -z "$title" ]]; then
    title="$child_id"
  fi

  # Parse owner from "Owner: xxx" line
  local owner=""
  owner="$(printf '%s' "$child_output" | sed -n 's/^Owner: *//p' | head -1)"

  # Check for BLOCKED_BY section
  local blocked_by=""
  blocked_by="$(printf '%s' "$child_output" | sed -n '/^BLOCKED_BY$/,/^[A-Z]/{ /^  /{ s/.*→ \([a-z0-9-]*\):.*/\1/p; }; }')"

  printf '%s|%s|%s|%s|%s' "$child_id" "$status" "$owner" "$title" "$blocked_by"
}

# _epic_status_icon <status>
_epic_status_icon() {
  case "$1" in
    closed)      printf '%s' "✓" ;;
    in_progress) printf '%s' "◐" ;;
    *)           printf '%s' "○" ;;
  esac
}

# ── Public API ───────────────────────────────────────────────────────────

# cmd_epic <issue-id> [--format=json]
cmd_epic() {
  local issue_id="${1:-}"
  local format_flag="${2:-}"

  if [[ -z "$issue_id" ]]; then
    echo "ERROR: Usage: forge team epic <issue-id> [--format=json]" >&2
    return 1
  fi

  local bd_cmd
  bd_cmd="$(_epic_get_bd)"

  # 1. Get epic details
  local epic_output
  epic_output="$("$bd_cmd" show "$issue_id" 2>/dev/null)" || {
    echo "ERROR: Could not fetch epic $issue_id" >&2
    return 1
  }

  # Parse epic title from first line
  local epic_first_line
  epic_first_line="$(printf '%s' "$epic_output" | head -1)"
  local epic_title
  epic_title="$(printf '%s' "$epic_first_line" | sed -n 's/^[^ ]* [^ ]* · \(.*\) \[.*/\1/p')"
  if [[ -z "$epic_title" ]]; then
    epic_title="$issue_id"
  fi

  # 2. Parse BLOCKS section to find child issues
  local children_ids
  children_ids="$(_epic_parse_blocks "$epic_output")"

  # Handle empty epic
  if [[ -z "$children_ids" ]]; then
    if [[ "$format_flag" == "--format=json" ]]; then
      cat <<ENDJSON
{"epic_id":"$issue_id","title":"$epic_title","total":0,"done":0,"in_progress":0,"open_count":0,"percentage":0,"children":[],"by_developer":{},"blocked":[]}
ENDJSON
      return 0
    fi
    echo "Epic: $issue_id — $epic_title"
    echo "No child issues"
    return 0
  fi

  # 3. For each child: get status, assignee
  local total=0
  local done_count=0
  local in_progress_count=0
  local open_count=0
  local blocked_list=""

  # Arrays for child data (using indexed approach for bash 3 compat)
  local child_lines=""
  # Developer tracking: accumulate "dev:status" pairs
  local dev_entries=""

  while IFS= read -r child_id; do
    [[ -z "$child_id" ]] && continue

    local info
    info="$(_epic_get_child_info "$child_id")" || continue

    local c_id c_status c_owner c_title c_blocked
    IFS='|' read -r c_id c_status c_owner c_title c_blocked <<< "$info"

    total=$((total + 1))

    case "$c_status" in
      closed)      done_count=$((done_count + 1)) ;;
      in_progress) in_progress_count=$((in_progress_count + 1)) ;;
      *)           open_count=$((open_count + 1)) ;;
    esac

    # Track blocked children
    if [[ -n "$c_blocked" ]]; then
      if [[ -n "$blocked_list" ]]; then
        blocked_list="$blocked_list"$'\n'"$c_id blocked by $c_blocked"
      else
        blocked_list="$c_id blocked by $c_blocked"
      fi
    fi

    # Build child line for display
    local icon
    icon="$(_epic_status_icon "$c_status")"
    local display_owner="${c_owner:-unassigned}"
    child_lines="${child_lines}  $icon $c_id  [$display_owner]  $c_title ($c_status)"$'\n'

    # Track developer entries
    if [[ -n "$c_owner" ]]; then
      dev_entries="${dev_entries}${c_owner}:${c_status}"$'\n'
    fi
  done <<< "$children_ids"

  # 4. Calculate completion percentage
  local percentage=0
  if [[ $total -gt 0 ]]; then
    percentage=$(( (done_count * 100) / total ))
  fi

  # 5. Build per-developer breakdown
  # Collect unique developers
  local devs=""
  while IFS= read -r entry; do
    [[ -z "$entry" ]] && continue
    local dev="${entry%%:*}"
    if [[ -z "$devs" ]] || ! printf '%s' "$devs" | grep -qxF "$dev"; then
      if [[ -n "$devs" ]]; then
        devs="$devs"$'\n'"$dev"
      else
        devs="$dev"
      fi
    fi
  done <<< "$dev_entries"

  # JSON output
  if [[ "$format_flag" == "--format=json" ]]; then
    local children_json="["
    local first_child=1
    while IFS= read -r child_id; do
      [[ -z "$child_id" ]] && continue
      local info
      info="$(_epic_get_child_info "$child_id")" || continue
      local c_id c_status c_owner c_title c_blocked
      IFS='|' read -r c_id c_status c_owner c_title c_blocked <<< "$info"

      if [[ $first_child -eq 0 ]]; then
        children_json="$children_json,"
      fi
      first_child=0
      children_json="$children_json{\"id\":\"$c_id\",\"status\":\"$c_status\",\"owner\":\"$c_owner\",\"title\":\"$c_title\",\"blocked_by\":\"$c_blocked\"}"
    done <<< "$children_ids"
    children_json="$children_json]"

    local dev_json="{"
    local first_dev=1
    while IFS= read -r dev; do
      [[ -z "$dev" ]] && continue
      local d_done=0 d_in_progress=0 d_open=0 d_total=0
      while IFS= read -r entry; do
        [[ -z "$entry" ]] && continue
        local e_dev="${entry%%:*}"
        local e_status="${entry#*:}"
        if [[ "$e_dev" == "$dev" ]]; then
          d_total=$((d_total + 1))
          case "$e_status" in
            closed)      d_done=$((d_done + 1)) ;;
            in_progress) d_in_progress=$((d_in_progress + 1)) ;;
            *)           d_open=$((d_open + 1)) ;;
          esac
        fi
      done <<< "$dev_entries"

      if [[ $first_dev -eq 0 ]]; then
        dev_json="$dev_json,"
      fi
      first_dev=0
      dev_json="$dev_json\"$dev\":{\"total\":$d_total,\"done\":$d_done,\"in_progress\":$d_in_progress,\"open\":$d_open}"
    done <<< "$devs"
    dev_json="$dev_json}"

    local blocked_json="["
    if [[ -n "$blocked_list" ]]; then
      local first_blocked=1
      while IFS= read -r bline; do
        [[ -z "$bline" ]] && continue
        if [[ $first_blocked -eq 0 ]]; then
          blocked_json="$blocked_json,"
        fi
        first_blocked=0
        blocked_json="$blocked_json\"$bline\""
      done <<< "$blocked_list"
    fi
    blocked_json="$blocked_json]"

    printf '{"epic_id":"%s","title":"%s","total":%d,"done":%d,"in_progress":%d,"open_count":%d,"percentage":%d,"children":%s,"by_developer":%s,"blocked":%s}\n' \
      "$issue_id" "$epic_title" "$total" "$done_count" "$in_progress_count" "$open_count" "$percentage" \
      "$children_json" "$dev_json" "$blocked_json"
    return 0
  fi

  # Text output
  echo "Epic: $issue_id — $epic_title"
  echo "Progress: $done_count/$total ($percentage%)"
  printf '%s' "$child_lines"

  echo ""
  echo "By developer:"
  while IFS= read -r dev; do
    [[ -z "$dev" ]] && continue
    local d_done=0 d_in_progress=0 d_open=0 d_total=0
    while IFS= read -r entry; do
      [[ -z "$entry" ]] && continue
      local e_dev="${entry%%:*}"
      local e_status="${entry#*:}"
      if [[ "$e_dev" == "$dev" ]]; then
        d_total=$((d_total + 1))
        case "$e_status" in
          closed)      d_done=$((d_done + 1)) ;;
          in_progress) d_in_progress=$((d_in_progress + 1)) ;;
          *)           d_open=$((d_open + 1)) ;;
        esac
      fi
    done <<< "$dev_entries"

    local dev_parts=""
    dev_parts="$d_done/$d_total done"
    [[ $d_in_progress -gt 0 ]] && dev_parts="$dev_parts, $d_in_progress in progress"
    [[ $d_open -gt 0 ]] && dev_parts="$dev_parts, $d_open open"
    echo "  $dev: $dev_parts"
  done <<< "$devs"

  echo ""
  if [[ -n "$blocked_list" ]]; then
    echo "Blocked:"
    while IFS= read -r bline; do
      [[ -z "$bline" ]] && continue
      echo "  $bline"
    done <<< "$blocked_list"
  else
    echo "Blocked: none"
  fi
}
