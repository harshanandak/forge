#!/usr/bin/env bash
# scripts/forge-team/lib/verify.sh — 1:1 enforcement and orphan detection
#
# Functions:
#   cmd_verify  — Check 5 health conditions and report results
#
# Checks:
#   1. gh auth status (GitHub CLI authenticated)
#   2. Identity mapped in team-map.jsonl
#   3. Orphan Beads issues (Beads without GitHub counterpart)
#   4. Orphan GitHub issues (GitHub without Beads counterpart)
#   5. Assignee consistency between Beads and GitHub
#
# Env overrides (for testing):
#   GH_CMD              — Path to gh binary (default: gh)
#   BD_CMD              — Path to bd binary (default: bd)
#   TEAM_MAP_ROOT       — Root dir for .beads/ and .github/ (default: .)
#   VERIFY_MAPPING_FILE — Path to beads-mapping.json (default: $TEAM_MAP_ROOT/.github/beads-mapping.json)
#
# This file does NOT set errexit/pipefail — callers manage their own shell options.

# Guard against double-sourcing
if [[ -n "${_VERIFY_LIB_LOADED:-}" ]]; then
  return 0 2>/dev/null || true
fi
_VERIFY_LIB_LOADED=1

_VERIFY_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Source shared libraries (graceful fallback if missing)
if [[ -f "$_VERIFY_DIR/agent-prompt.sh" ]]; then
  source "$_VERIFY_DIR/agent-prompt.sh"
fi
if [[ -f "$_VERIFY_DIR/identity.sh" ]]; then
  source "$_VERIFY_DIR/identity.sh"
fi

# ── Internal helpers ─────────────────────────────────────────────────────

_verify_error() {
  if declare -f agent_error &>/dev/null; then
    agent_error "$1"
  else
    echo "ERROR: $1" >&2
  fi
}

_verify_prompt() {
  if declare -f agent_prompt &>/dev/null; then
    agent_prompt "$1"
  else
    echo "PROMPT: $1" >&2
  fi
}

_verify_info() {
  if declare -f agent_info &>/dev/null; then
    agent_info "$1"
  else
    echo "INFO: $1" >&2
  fi
}

_mapping_file() {
  local root="${TEAM_MAP_ROOT:-.}"
  printf '%s' "${VERIFY_MAPPING_FILE:-$root/.github/beads-mapping.json}"
}

# ── _extract_beads_ids ───────────────────────────────────────────────────
# Parse bd list output to extract beads IDs.
# Input format: "◐ forge-aaa · Feature A" or "○ forge-bbb · Feature B"
# Output: one ID per line
_extract_beads_ids() {
  local input="${1:-}"
  if [[ -z "$input" ]]; then
    return 0
  fi
  printf '%s\n' "$input" | grep -oP '(forge-[a-zA-Z0-9]+(\.[a-zA-Z0-9]+)*)' || true
}

# ── Public API ───────────────────────────────────────────────────────────

# cmd_verify — Run all 5 health checks and report results.
# Exit 0 if all clean, exit 1 if any issues found.
cmd_verify() {
  local gh_cmd="${GH_CMD:-gh}"
  local bd_cmd="${BD_CMD:-bd}"
  local issues_found=0

  echo "forge team verify"
  echo "═════════════════"
  echo ""

  # ── Check 1: gh auth status ──────────────────────────────────────────
  local gh_auth_output
  if gh_auth_output="$("$gh_cmd" auth status 2>&1)"; then
    # Extract username from auth status output
    local gh_user
    gh_user="$(printf '%s' "$gh_auth_output" | grep -oP 'account\s+\K\S+' | head -1)"
    if [[ -z "$gh_user" ]]; then
      gh_user="$(printf '%s' "$gh_auth_output" | grep -oP 'Logged in to \S+ account \K\S+' | head -1)"
    fi
    echo "✓ GitHub CLI: authenticated${gh_user:+ as $gh_user}"
  else
    echo "✗ GitHub CLI: not authenticated"
    _verify_error "GitHub CLI not authenticated. Run: gh auth login"
    issues_found=$((issues_found + 1))
    # Cannot proceed with other checks without auth
    echo ""
    echo "Result: $issues_found issue found — action needed"
    return 1
  fi

  # ── Check 2: Identity mapped ────────────────────────────────────────
  unset _GITHUB_USER_CACHE
  local identity_user
  if identity_user="$(get_github_user 2>/dev/null)"; then
    local existing
    existing="$(team_map_get "$identity_user" 2>/dev/null)"
    if [[ "$existing" != "null" ]] && [[ -n "$existing" ]]; then
      echo "✓ Identity: mapped in team-map.jsonl"
    else
      echo "✗ Identity: not found in team-map.jsonl"
      _verify_prompt "Run: forge team add"
      issues_found=$((issues_found + 1))
    fi
  else
    echo "✗ Identity: could not detect"
    _verify_prompt "Run: forge team add"
    issues_found=$((issues_found + 1))
  fi

  # ── Check 3: Orphan Beads issues (Beads without GitHub) ─────────────
  local bd_output
  bd_output="$("$bd_cmd" list --status=open,in_progress 2>/dev/null)" || bd_output=""

  local beads_ids
  beads_ids="$(_extract_beads_ids "$bd_output")"

  local beads_total=0
  local beads_synced=0
  local beads_orphans=()

  if [[ -n "$beads_ids" ]]; then
    while IFS= read -r bid; do
      [[ -z "$bid" ]] && continue
      beads_total=$((beads_total + 1))

      # Check if this beads issue has github_issue state
      local show_output
      show_output="$("$bd_cmd" show "$bid" 2>/dev/null)" || show_output=""
      if printf '%s' "$show_output" | grep -qP 'github_issue:\d+'; then
        beads_synced=$((beads_synced + 1))
      else
        beads_orphans+=("$bid")
      fi
    done <<< "$beads_ids"
  fi

  if [[ ${#beads_orphans[@]} -eq 0 ]]; then
    echo "✓ Beads→GitHub: ${beads_synced}/${beads_total} issues synced"
  else
    echo "✗ Beads→GitHub: ${#beads_orphans[@]} orphan issues found"
    for orphan in "${beads_orphans[@]}"; do
      _verify_prompt "${orphan} has no GitHub issue. Run: forge team sync-issue ${orphan}"
    done
    issues_found=$((issues_found + ${#beads_orphans[@]}))
  fi

  # ── Check 4: Orphan GitHub issues (GitHub without Beads) ────────────
  local mapping_file
  mapping_file="$(_mapping_file)"

  local gh_issues_json
  gh_issues_json="$("$gh_cmd" issue list --state open --json number,title --limit 100 2>/dev/null)" || gh_issues_json="[]"

  local gh_issue_count
  gh_issue_count="$(printf '%s' "$gh_issues_json" | jq 'length')"

  local gh_orphans=()

  if [[ "$gh_issue_count" -gt 0 ]] && [[ -f "$mapping_file" ]]; then
    local mapping_content
    mapping_content="$(cat "$mapping_file")"

    local i=0
    while [[ $i -lt $gh_issue_count ]]; do
      local issue_num
      issue_num="$(printf '%s' "$gh_issues_json" | jq -r ".[$i].number")"

      # Check if this GitHub issue number is a key in the mapping
      local mapped
      mapped="$(printf '%s' "$mapping_content" | jq -r --arg n "$issue_num" '.[$n] // empty')"

      if [[ -z "$mapped" ]]; then
        gh_orphans+=("$issue_num")
      fi
      i=$((i + 1))
    done
  elif [[ "$gh_issue_count" -gt 0 ]] && [[ ! -f "$mapping_file" ]]; then
    # No mapping file — all GitHub issues are orphans
    local i=0
    while [[ $i -lt $gh_issue_count ]]; do
      local issue_num
      issue_num="$(printf '%s' "$gh_issues_json" | jq -r ".[$i].number")"
      gh_orphans+=("$issue_num")
      i=$((i + 1))
    done
  fi

  if [[ ${#gh_orphans[@]} -eq 0 ]]; then
    local mapped_count=$((gh_issue_count))
    echo "✓ GitHub→Beads: ${mapped_count}/${mapped_count} issues mapped"
  else
    echo "✗ GitHub→Beads: ${#gh_orphans[@]} orphan issues found"
    for orphan_num in "${gh_orphans[@]}"; do
      _verify_prompt "GitHub #${orphan_num} has no Beads issue. Run: forge team import #${orphan_num}"
    done
    issues_found=$((issues_found + ${#gh_orphans[@]}))
  fi

  # ── Check 5: Assignee consistency ───────────────────────────────────
  local assignee_mismatches=()

  if [[ -f "$mapping_file" ]] && [[ "$gh_issue_count" -gt 0 ]]; then
    local mapping_content
    mapping_content="$(cat "$mapping_file")"

    local i=0
    while [[ $i -lt $gh_issue_count ]]; do
      local issue_num
      issue_num="$(printf '%s' "$gh_issues_json" | jq -r ".[$i].number")"

      # Check if issue is in mapping
      local mapped_entry
      mapped_entry="$(printf '%s' "$mapping_content" | jq -r --arg n "$issue_num" '.[$n] // empty')"

      if [[ -n "$mapped_entry" ]]; then
        local beads_assignee beads_id
        beads_id="$(printf '%s' "$mapping_content" | jq -r --arg n "$issue_num" '.[$n].beads_id // empty')"
        beads_assignee="$(printf '%s' "$mapping_content" | jq -r --arg n "$issue_num" '.[$n].assignee // empty')"

        if [[ -n "$beads_assignee" ]]; then
          # Get GitHub assignee
          local gh_assignee_json
          gh_assignee_json="$("$gh_cmd" issue view "$issue_num" --json assignees 2>/dev/null)" || gh_assignee_json="{}"
          local gh_assignee
          gh_assignee="$(printf '%s' "$gh_assignee_json" | jq -r '.assignees[0].login // empty')"

          if [[ -n "$gh_assignee" ]] && [[ "$beads_assignee" != "$gh_assignee" ]]; then
            assignee_mismatches+=("${beads_id:-issue-$issue_num}|$beads_assignee|$gh_assignee")
          fi
        fi
      fi
      i=$((i + 1))
    done
  fi

  if [[ ${#assignee_mismatches[@]} -eq 0 ]]; then
    echo "✓ Assignees: all consistent"
  else
    echo "✗ Assignees: ${#assignee_mismatches[@]} mismatches found"
    for mismatch in "${assignee_mismatches[@]}"; do
      local m_id m_beads m_github
      m_id="$(printf '%s' "$mismatch" | cut -d'|' -f1)"
      m_beads="$(printf '%s' "$mismatch" | cut -d'|' -f2)"
      m_github="$(printf '%s' "$mismatch" | cut -d'|' -f3)"
      _verify_info "${m_id} assignee mismatch: Beads=${m_beads}, GitHub=${m_github}"
    done
    issues_found=$((issues_found + ${#assignee_mismatches[@]}))
  fi

  # ── Summary ─────────────────────────────────────────────────────────
  echo ""
  if [[ $issues_found -eq 0 ]]; then
    echo "Result: all checks passed"
    return 0
  else
    local noun="issue"
    [[ $issues_found -gt 1 ]] && noun="issues"
    echo "Result: $issues_found $noun found — action needed"
    return 1
  fi
}
