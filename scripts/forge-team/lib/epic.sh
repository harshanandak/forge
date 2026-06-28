#!/usr/bin/env bash
# scripts/forge-team/lib/epic.sh — Epic rollup view
#
# Shows epic progress with per-developer breakdown and blocked issue tracking.
# All data comes from a SINGLE `forge issue children <id> --json` call: the kernel
# computes the rollup (done-only percentage, per-status counts) and emits each child
# with its assignee + blocked_by, so this layer only renders.
#
# Functions:
#   cmd_epic  — Top-level dispatcher entry point
#
# Env overrides (for testing):
#   FORGE_CMD   — Path to forge binary (default: forge)
#
# This file does NOT set errexit/pipefail — callers manage their own shell options.

# Guard against double-sourcing
if [[ -n "${_EPIC_LIB_LOADED:-}" ]]; then
  return 0 2>/dev/null || true
fi
_EPIC_LIB_LOADED=1

# ── Internal helpers ─────────────────────────────────────────────────────

# _epic_status_icon <status>  (kernel status vocabulary: open|in_progress|review|done|cancelled)
_epic_status_icon() {
  case "$1" in
    done)        printf '%s' "✓" ;;
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

  local forge_cmd
  forge_cmd="${FORGE_CMD:-forge}"

  # 1. Single query: epic header + direct children + kernel-computed rollup. A missing
  #    or invalid id makes `forge issue children` fail (empty stdout) — treat as not found.
  local response
  response="$("$forge_cmd" issue children "$issue_id" --json 2>/dev/null)" || {
    echo "ERROR: Could not fetch epic $issue_id" >&2
    return 1
  }
  if [[ -z "$response" ]]; then
    echo "ERROR: Could not fetch epic $issue_id" >&2
    return 1
  fi

  # 2. Epic title (fall back to the id when the header carries no title).
  local epic_title
  epic_title="$(printf '%s' "$response" | jq -r '.data.epic.title // empty' | tr -d '\r')"
  [[ -z "$epic_title" ]] && epic_title="$issue_id"

  # 3. Rollup counts (kernel-computed). open_count keeps the historical invariant
  #    total = done + in_progress + open_count (the catch-all bucket also absorbs the
  #    kernel review/cancelled statuses), so downstream consumers see a stable shape.
  local total done_count in_progress_count open_count percentage
  total="$(printf '%s' "$response" | jq -r '.data.rollup.total // 0' | tr -d '\r')"
  done_count="$(printf '%s' "$response" | jq -r '.data.rollup.done // 0' | tr -d '\r')"
  in_progress_count="$(printf '%s' "$response" | jq -r '.data.rollup.in_progress // 0' | tr -d '\r')"
  percentage="$(printf '%s' "$response" | jq -r '.data.rollup.percentage // 0' | tr -d '\r')"
  open_count=$((total - done_count - in_progress_count))

  # 4. Empty epic → no children.
  if [[ "$total" -eq 0 ]]; then
    if [[ "$format_flag" == "--format=json" ]]; then
      # Build via jq --arg so a title containing quotes/backslashes stays valid
      # JSON (parity with the non-empty path below).
      jq -cn --arg epic_id "$issue_id" --arg title "$epic_title" \
        '{epic_id:$epic_id,title:$title,total:0,done:0,in_progress:0,open_count:0,percentage:0,children:[],by_developer:{},blocked:[]}'
      return 0
    fi
    echo "Epic: $issue_id — $epic_title"
    echo "No child issues"
    return 0
  fi

  # 5. JSON output — one jq transform from the kernel response. Preserves the historical
  #    cmd_epic shape (epic_id,title,total,done,in_progress,open_count,percentage,
  #    children,by_developer,blocked). Unassigned children are excluded from by_developer
  #    (matches the prior behavior), and per-dev open is the same total-done-in_progress
  #    catch-all.
  if [[ "$format_flag" == "--format=json" ]]; then
    printf '%s' "$response" | jq -c \
      --arg epic_id "$issue_id" \
      --arg title "$epic_title" '
      (.data.children // []) as $children
      | {
          epic_id: $epic_id,
          title: $title,
          total: (.data.rollup.total // 0),
          done: (.data.rollup.done // 0),
          in_progress: (.data.rollup.in_progress // 0),
          open_count: ((.data.rollup.total // 0) - (.data.rollup.done // 0) - (.data.rollup.in_progress // 0)),
          percentage: (.data.rollup.percentage // 0),
          children: [ $children[] | {
            id: .id,
            status: .status,
            owner: (.assignee // ""),
            title: (.title // .id),
            blocked_by: ((.blocked_by // []) | join(","))
          } ],
          by_developer: (
            [ $children[] | select((.assignee // "") != "") ]
            | group_by(.assignee)
            | map(
                (.[0].assignee) as $dev
                | length as $t
                | ([.[] | select(.status == "done")] | length) as $d
                | ([.[] | select(.status == "in_progress")] | length) as $ip
                | { key: $dev, value: { total: $t, done: $d, in_progress: $ip, open: ($t - $d - $ip) } }
              )
            | from_entries
          ),
          blocked: [ $children[] | select(.blocked == true) | "\(.id) blocked by \((.blocked_by // []) | join(","))" ]
        }' | tr -d '\r'
    return 0
  fi

  # 6. Text output.
  echo "Epic: $issue_id — $epic_title"
  echo "Progress: $done_count/$total ($percentage%)"
  while IFS=$'\t' read -r c_id c_status c_owner c_title; do
    [[ -z "$c_id" ]] && continue
    local icon
    icon="$(_epic_status_icon "$c_status")"
    echo "  $icon $c_id  [${c_owner:-unassigned}]  $c_title ($c_status)"
  done < <(printf '%s' "$response" | jq -r '.data.children[] | [.id, .status, (.assignee // ""), (.title // .id)] | @tsv' | tr -d '\r')

  echo ""
  echo "By developer:"
  printf '%s' "$response" | jq -r '
    [ (.data.children // [])[] | select((.assignee // "") != "") ]
    | group_by(.assignee)
    | map(
        (.[0].assignee) as $dev
        | length as $t
        | ([.[] | select(.status == "done")] | length) as $d
        | ([.[] | select(.status == "in_progress")] | length) as $ip
        | ($t - $d - $ip) as $op
        | "  \($dev): \($d)/\($t) done"
          + (if $ip > 0 then ", \($ip) in progress" else "" end)
          + (if $op > 0 then ", \($op) open" else "" end)
      )
    | .[]' | tr -d '\r'

  echo ""
  local blocked_lines
  blocked_lines="$(printf '%s' "$response" | jq -r '.data.children[] | select(.blocked == true) | "  \(.id) blocked by \((.blocked_by // []) | join(","))"' | tr -d '\r')"
  if [[ -n "$blocked_lines" ]]; then
    echo "Blocked:"
    printf '%s\n' "$blocked_lines"
  else
    echo "Blocked: none"
  fi
}
