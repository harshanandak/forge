#!/usr/bin/env bash
# dashboard.sh — Team health dashboard for forge-team.
#
# Provides cmd_dashboard [--format=json] which aggregates team issue data
# from the Forge issue backend and displays per-developer stats, stale
# assignments, and blocked issues.

# ── Dependencies ─────────────────────────────────────────────────────────
# FORGE_CMD — path to forge binary (default: forge)
FORGE_CMD="${FORGE_CMD:-forge}"

# FORGE_NOW — override current epoch for testing (default: real time)
_now() {
  if [[ -n "${FORGE_NOW:-}" ]]; then
    echo "$FORGE_NOW"
  else
    date +%s
  fi
}

# Convert ISO8601 timestamp to epoch seconds
_iso_to_epoch() {
  local ts="$1"
  # Remove trailing Z and replace T with space for date parsing
  local clean="${ts%Z}"
  clean="${clean//T/ }"
  # Use date -d for GNU date (Linux/Git Bash)
  if date -d "$clean UTC" +%s 2>/dev/null; then
    return
  fi
  # Fallback: manual parse YYYY-MM-DD HH:MM:SS
  # This handles the common case in Git Bash on Windows
  local year month day hour min sec
  IFS='-: ' read -r year month day hour min sec <<< "$clean"
  # Use python if available
  if command -v python3 &>/dev/null; then
    python3 -c "import calendar,datetime; print(int(calendar.timegm(datetime.datetime($year,$month,$day,$hour,$min,$sec).timetuple())))"
  elif command -v python &>/dev/null; then
    python -c "import calendar,datetime; print(int(calendar.timegm(datetime.datetime($year,$month,$day,$hour,$min,$sec).timetuple())))"
  else
    # Last resort: approximate with GNU date
    echo 0
  fi
}

# ── Data Collection ──────────────────────────────────────────────────────

# _forge_active_issues_json — Merged JSON array of open + in_progress issues.
# The Kernel list filter does not accept comma-joined statuses, so query each
# status separately and concatenate the issue arrays.
_forge_active_issues_json() {
  local open_json inprog_json
  open_json="$("$FORGE_CMD" issue list --status=open --json 2>/dev/null)" || open_json=""
  inprog_json="$("$FORGE_CMD" issue list --status=in_progress --json 2>/dev/null)" || inprog_json=""
  jq -n \
    --argjson a "${open_json:-null}" \
    --argjson b "${inprog_json:-null}" \
    '(((($a.data.issues) // []) + (($b.data.issues) // [])))' 2>/dev/null || echo "[]"
}

# _issue_detail_lines <issues-json>
# Emit one pipe-delimited line per issue:
#   id|title|STATUS|owner|updated_iso|blocked_by
# STATUS is the upper-cased Kernel status; owner is assignee/claimed_by; and
# blocked_by is a comma-joined list of dependency ids.
_issue_detail_lines() {
  printf '%s' "$1" | jq -r '
    .[]
    | [ .id,
        (.title // ""),
        ((.status // "open") | ascii_upcase),
        (.assignee // .claimed_by // ""),
        ((.updated_at // "") | sub("\\.[0-9]+Z$"; "Z")),
        ((.dependencies // [])
          | map(if type == "object" then (.id // .to // "") else . end)
          | map(select(. != ""))
          | join(","))
      ]
    | join("|")' | tr -d '\r'
}

# ── Dashboard Command ────────────────────────────────────────────────────

cmd_dashboard() {
  local format="text"

  # Parse args
  local arg
  for arg in "$@"; do
    case "$arg" in
      --format=json) format="json" ;;
      --format=*) echo "Error: unsupported format '${arg#--format=}'" >&2; return 1 ;;
    esac
  done

  # 1. Get all open/in_progress issues as a merged JSON array
  local issues_json
  issues_json="$(_forge_active_issues_json)"

  # Check for empty
  local active_count
  active_count="$(printf '%s' "$issues_json" | jq 'length' 2>/dev/null || echo 0)"
  if [[ "$active_count" -eq 0 ]]; then
    if [[ "$format" == "json" ]]; then
      echo '{"developers":{},"total":0,"stale":[],"blocked":[],"message":"No active issues — team is clear"}'
    else
      echo "No active issues — team is clear"
    fi
    return 0
  fi

  # 2. Build per-issue detail lines: id|title|STATUS|owner|updated_iso|blocked_by
  local issues=()
  while IFS= read -r entry; do
    [[ -z "$entry" ]] && continue
    issues+=("$entry")
  done <<< "$(_issue_detail_lines "$issues_json")"

  # 3. Collect details for each issue
  local now_epoch
  now_epoch="$(_now)"
  local stale_threshold=172800  # 48h in seconds

  # Associative arrays for per-developer aggregation
  declare -A dev_open dev_inprogress dev_blocked dev_stale

  # Lists for stale and blocked sections
  local stale_entries=()
  local blocked_entries=()
  local total_open=0 total_inprogress=0 total_blocked=0 total_stale=0

  for entry in "${issues[@]}"; do
    IFS='|' read -r _id _title _status _owner _updated_iso _blocked_by <<< "$entry"

    local _updated_epoch=0
    if [[ -n "$_updated_iso" ]]; then
      _updated_epoch="$(_iso_to_epoch "$_updated_iso")"
    fi

    # Default owner if empty
    [[ -z "$_owner" ]] && _owner="unassigned"

    # Initialize developer counters
    [[ -z "${dev_open[$_owner]:-}" ]] && dev_open[$_owner]=0
    [[ -z "${dev_inprogress[$_owner]:-}" ]] && dev_inprogress[$_owner]=0
    [[ -z "${dev_blocked[$_owner]:-}" ]] && dev_blocked[$_owner]=0
    [[ -z "${dev_stale[$_owner]:-}" ]] && dev_stale[$_owner]=0

    # Count by status
    case "$_status" in
      OPEN)
        dev_open[$_owner]=$(( ${dev_open[$_owner]} + 1 ))
        total_open=$((total_open + 1))
        ;;
      IN_PROGRESS)
        dev_inprogress[$_owner]=$(( ${dev_inprogress[$_owner]} + 1 ))
        total_inprogress=$((total_inprogress + 1))
        ;;
      BLOCKED)
        dev_blocked[$_owner]=$(( ${dev_blocked[$_owner]} + 1 ))
        total_blocked=$((total_blocked + 1))
        ;;
    esac

    # Check for blocked (has DEPENDS ON with open deps)
    if [[ -n "$_blocked_by" ]]; then
      dev_blocked[$_owner]=$(( ${dev_blocked[$_owner]} + 1 ))
      total_blocked=$((total_blocked + 1))
      blocked_entries+=("$_id|$_owner|$_title|$_blocked_by")
    fi

    # Check for stale (>48h since last update)
    if [[ "$_updated_epoch" -gt 0 ]]; then
      local age=$(( now_epoch - _updated_epoch ))
      if [[ $age -gt $stale_threshold ]]; then
        local hours=$(( age / 3600 ))
        dev_stale[$_owner]=$(( ${dev_stale[$_owner]} + 1 ))
        total_stale=$((total_stale + 1))
        stale_entries+=("$_id|$_owner|$_title|${hours}h since last update")
      fi
    fi
  done

  local total_issues=${#issues[@]}

  # 4. Output
  if [[ "$format" == "json" ]]; then
    _dashboard_json "$total_issues"
  else
    _dashboard_text "$total_issues"
  fi
}

# ── Text Output ──────────────────────────────────────────────────────────

_dashboard_text() {
  local total_issues="$1"

  echo "Team Dashboard"
  echo "══════════════"
  echo ""

  # Header
  printf "%-16s %4s  %11s  %7s  %5s\n" "Developer" "Open" "In Progress" "Blocked" "Stale"

  # Get sorted list of developers
  local devs=()
  local dev
  for dev in "${!dev_open[@]}"; do
    devs+=("$dev")
  done
  # Sort developers
  IFS=$'\n' devs=($(sort <<< "${devs[*]}")); unset IFS

  for dev in "${devs[@]}"; do
    printf "%-16s %4d  %11d  %7d  %5d\n" \
      "$dev" \
      "${dev_open[$dev]:-0}" \
      "${dev_inprogress[$dev]:-0}" \
      "${dev_blocked[$dev]:-0}" \
      "${dev_stale[$dev]:-0}"
  done

  echo ""

  # Build total summary parts
  local parts=()
  [[ $total_inprogress -gt 0 ]] && parts+=("$total_inprogress in progress")
  [[ $total_blocked -gt 0 ]] && parts+=("$total_blocked blocked")
  [[ $total_stale -gt 0 ]] && parts+=("$total_stale stale")
  [[ $total_open -gt 0 ]] && parts+=("$total_open open")

  local summary=""
  if [[ ${#parts[@]} -gt 0 ]]; then
    summary=" ($(IFS=', '; echo "${parts[*]}"))"
  fi
  echo "Total: $total_issues issues${summary}"

  # Stale section
  if [[ ${#stale_entries[@]} -gt 0 ]]; then
    echo ""
    echo "Stale assignments (>48h):"
    local entry
    for entry in "${stale_entries[@]}"; do
      IFS='|' read -r _id _owner _title _age <<< "$entry"
      echo "  ⚠ $_id [$_owner] — $_title ($_age)"
    done
  fi

  # Blocked section
  if [[ ${#blocked_entries[@]} -gt 0 ]]; then
    echo ""
    echo "Blocked issues:"
    local entry
    for entry in "${blocked_entries[@]}"; do
      IFS='|' read -r _id _owner _title _deps <<< "$entry"
      echo "  ⚠ $_id [$_owner] — $_title (blocked by $_deps)"
    done
  fi
}

# ── JSON Output ──────────────────────────────────────────────────────────

_dashboard_json() {
  local total_issues="$1"

  # Build developers JSON
  local dev_json="{"
  local first=1
  local devs=()
  local dev
  for dev in "${!dev_open[@]}"; do
    devs+=("$dev")
  done
  IFS=$'\n' devs=($(sort <<< "${devs[*]}")); unset IFS

  for dev in "${devs[@]}"; do
    [[ $first -eq 0 ]] && dev_json+=","
    first=0
    dev_json+="\"$dev\":{\"open\":${dev_open[$dev]:-0},\"in_progress\":${dev_inprogress[$dev]:-0},\"blocked\":${dev_blocked[$dev]:-0},\"stale\":${dev_stale[$dev]:-0}}"
  done
  dev_json+="}"

  # Build stale JSON array
  local stale_json="["
  first=1
  local entry
  for entry in "${stale_entries[@]}"; do
    [[ $first -eq 0 ]] && stale_json+=","
    first=0
    IFS='|' read -r _id _owner _title _age <<< "$entry"
    stale_json+="$(jq -n -c --arg id "$_id" --arg owner "$_owner" --arg title "$_title" --arg age "$_age" '{id:$id,owner:$owner,title:$title,age:$age}')"
  done
  stale_json+="]"

  # Build blocked JSON array
  local blocked_json="["
  first=1
  for entry in "${blocked_entries[@]}"; do
    [[ $first -eq 0 ]] && blocked_json+=","
    first=0
    IFS='|' read -r _id _owner _title _deps <<< "$entry"
    blocked_json+="$(jq -n -c --arg id "$_id" --arg owner "$_owner" --arg title "$_title" --arg deps "$_deps" '{id:$id,owner:$owner,title:$title,blocked_by:$deps}')"
  done
  blocked_json+="]"

  echo "{\"developers\":$dev_json,\"total\":$total_issues,\"in_progress\":$total_inprogress,\"blocked\":$total_blocked,\"stale\":$total_stale,\"stale_entries\":$stale_json,\"blocked_entries\":$blocked_json}"
}
