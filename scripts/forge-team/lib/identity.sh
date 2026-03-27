#!/usr/bin/env bash
# scripts/forge-team/lib/identity.sh — GitHub-username-only identity mapping
#
# Auto-detects developer via `gh api user`. Stores identity in
# .beads/team-map.jsonl (append-only, LWW per GitHub username).
#
# Functions:
#   get_github_user       — Current dev's GitHub username (cached)
#   team_map_add          — Add/update entry in team-map.jsonl
#   team_map_read         — Read all entries with LWW resolution
#   team_map_get          — Get single entry by GitHub username
#   is_bot                — Check if username is a bot
#   auto_detect_identity  — Auto-detect and register identity
#
# Env overrides:
#   GH_CMD          — Path to gh binary (for testing)
#   TEAM_MAP_ROOT   — Root dir for .beads/team-map.jsonl (default: .)
#
# This file does NOT set errexit/pipefail — callers manage their own shell options.

# Guard against double-sourcing
if [[ -n "${_IDENTITY_LIB_LOADED:-}" ]]; then
  return 0 2>/dev/null || true
fi
_IDENTITY_LIB_LOADED=1

_IDENTITY_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Source shared libraries (graceful fallback if missing)
# sanitize.sh — from scripts/lib/
_SANITIZE_PATH="$_IDENTITY_DIR/../../lib/sanitize.sh"
if [[ -f "$_SANITIZE_PATH" ]]; then
  source "$_SANITIZE_PATH"
fi

# jsonl-lock.sh — from scripts/lib/
_JSONL_LOCK_PATH="$_IDENTITY_DIR/../../lib/jsonl-lock.sh"
if [[ -f "$_JSONL_LOCK_PATH" ]]; then
  source "$_JSONL_LOCK_PATH"
fi

# agent-prompt.sh — from forge-team/lib/ (Task 1, may not exist yet)
if [[ -f "$_IDENTITY_DIR/agent-prompt.sh" ]]; then
  source "$_IDENTITY_DIR/agent-prompt.sh"
fi

# ── Internal helpers ─────────────────────────────────────────────────────

# _identity_error <message>
# Output error via agent_error if available, otherwise stderr
_identity_error() {
  if declare -f agent_error &>/dev/null; then
    agent_error "$1"
  else
    echo "ERROR: $1" >&2
  fi
}

# _identity_prompt <message>
# Output prompt via agent_prompt if available, otherwise stderr
_identity_prompt() {
  if declare -f agent_prompt &>/dev/null; then
    agent_prompt "$1"
  else
    echo "PROMPT: $1" >&2
  fi
}

# _team_map_file — Returns the path to team-map.jsonl
_team_map_file() {
  local root="${TEAM_MAP_ROOT:-.}"
  printf '%s' "$root/.beads/team-map.jsonl"
}

# _validate_github_username <username>
# GitHub usernames: alphanumeric + hyphens, cannot start with hyphen
_validate_github_username() {
  local name="${1:-}"
  if [[ -z "$name" ]]; then
    _identity_error "GitHub username cannot be empty"
    return 1
  fi
  # Allow [bot] suffix for bot accounts
  local check_name="$name"
  check_name="${check_name%\[bot\]}"
  if [[ -z "$check_name" ]]; then
    _identity_error "Invalid GitHub username: $name"
    return 1
  fi
  if [[ ! "$check_name" =~ ^[a-zA-Z0-9][a-zA-Z0-9-]*$ ]]; then
    _identity_error "Invalid GitHub username format: $name"
    return 1
  fi
  return 0
}

# ── Public API ───────────────────────────────────────────────────────────

# get_github_user — Returns current developer's GitHub username.
# Caches in _GITHUB_USER_CACHE for session. Uses GH_CMD env override for testing.
# Exit: 0 on success, 1 if gh not authenticated.
get_github_user() {
  # Return cached value if available
  if [[ -n "${_GITHUB_USER_CACHE:-}" ]]; then
    printf '%s' "$_GITHUB_USER_CACHE"
    return 0
  fi

  local gh_cmd="${GH_CMD:-gh}"
  local user
  if ! user="$("$gh_cmd" api user --jq .login 2>/dev/null)"; then
    _identity_error "GitHub CLI not authenticated. Run 'gh auth login' first."
    return 1
  fi

  if [[ -z "$user" ]]; then
    _identity_error "GitHub CLI returned empty username."
    return 1
  fi

  _GITHUB_USER_CACHE="$user"
  printf '%s' "$user"
  return 0
}

# team_map_add <github-user> [display-name]
# Adds/updates entry in .beads/team-map.jsonl.
# Schema: {"github":"<user>","display_name":"<name>","updated_at":"<ts>","is_bot":false}
team_map_add() {
  local github_user="${1:-}"
  local display_name="${2:-$github_user}"

  # Validate username
  if ! _validate_github_username "$github_user"; then
    return 1
  fi

  local mapfile
  mapfile="$(_team_map_file)"

  # Determine bot status
  local bot_flag="false"
  if is_bot "$github_user"; then
    bot_flag="true"
  fi

  # Build JSON entry using jq
  local ts
  ts="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
  local json_line
  json_line="$(jq -n -c \
    --arg gh "$github_user" \
    --arg dn "$display_name" \
    --arg ts "$ts" \
    --argjson bot "$bot_flag" \
    '{github: $gh, display_name: $dn, updated_at: $ts, is_bot: $bot}')"

  # Append atomically
  if declare -f atomic_jsonl_append &>/dev/null; then
    atomic_jsonl_append "$mapfile" "$json_line"
  else
    mkdir -p "$(dirname "$mapfile")"
    printf '%s\n' "$json_line" >> "$mapfile"
  fi
}

# team_map_read — Read all entries with LWW resolution.
# Groups by github username, sorts by updated_at, takes last per user.
# Returns JSON array. Returns [] if file missing/empty.
team_map_read() {
  local mapfile
  mapfile="$(_team_map_file)"

  if [[ ! -f "$mapfile" ]] || [[ ! -s "$mapfile" ]]; then
    echo "[]"
    return 0
  fi

  # LWW resolution: group by github, sort by updated_at, take last per user
  # Filter out tombstones (entries with "tombstone":true)
  jq -s '
    [ .[] | select(.tombstone != true) ]
    | group_by(.github)
    | map(sort_by(.updated_at) | last)
  ' "$mapfile"
}

# team_map_get <github-username>
# Gets single entry by GitHub username. Returns JSON object or "null".
team_map_get() {
  local username="${1:-}"
  if [[ -z "$username" ]]; then
    echo "null"
    return 0
  fi

  local all
  all="$(team_map_read)"
  local result
  result="$(echo "$all" | jq -c --arg u "$username" '[.[] | select(.github == $u)] | if length > 0 then .[0] else null end')"
  printf '%s' "${result:-null}"
}

# is_bot <username>
# Returns 0 if username ends with [bot], 1 otherwise.
is_bot() {
  local username="${1:-}"
  if [[ "$username" == *"[bot]" ]]; then
    return 0
  fi
  return 1
}

# auto_detect_identity — Runs get_github_user(), checks if already in
# team-map, adds if missing. Silent on success (exit 0).
# On failure, outputs agent prompt.
auto_detect_identity() {
  local user
  if ! user="$(get_github_user)"; then
    _identity_prompt "Could not detect GitHub identity. Run 'gh auth login'."
    return 1
  fi

  # Check if already in team map
  local existing
  existing="$(team_map_get "$user")"
  if [[ "$existing" != "null" ]] && [[ -n "$existing" ]]; then
    # Already registered, silent success
    return 0
  fi

  # Add to team map
  team_map_add "$user" "$user"
  return 0
}
