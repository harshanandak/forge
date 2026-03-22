#!/usr/bin/env bash
# sync-utils.sh — Shared utilities for multi-dev-awareness sync scripts.
#
# Source this file or execute directly with a subcommand.
# Cross-platform: works on Windows (Git Bash), macOS, and Linux.
# OWASP A03: All identity strings validated against strict allowlist regex.
# OWASP A03: All config values sanitized before use (no injection vectors).

# Only set errexit/pipefail when run as a script, not when sourced
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
  set -euo pipefail
fi

# ── Session Identity ───────────────────────────────────────────────────

# Validates a session identity string against the allowlist regex.
# Returns 0 if valid, 1 if invalid.
# Usage: validate_session_identity "user@hostname"
validate_session_identity() {
  local identity="${1:-}"
  if [[ -z "$identity" ]]; then
    return 1
  fi
  # OWASP A03: strict allowlist — only alphanumeric, dot, underscore, @, +, hyphen
  if [[ "$identity" =~ ^[a-zA-Z0-9._@+-]+$ ]]; then
    return 0
  fi
  return 1
}

# Returns a session identity string in the format: <user>@<hostname>
# Uses git config user.email if available, falls back to git config user.name.
# Validates the result against OWASP A03 allowlist regex.
# Outputs the identity via printf (not echo) and returns 0 on success, 1 on failure.
# Usage: identity="$(get_session_identity)"
get_session_identity() {
  local user_part=""
  local host_part=""

  # Try email first, fall back to user.name
  user_part="$(git config user.email 2>/dev/null)" || true
  if [[ -z "$user_part" ]]; then
    user_part="$(git config user.name 2>/dev/null)" || true
  fi

  if [[ -z "$user_part" ]]; then
    echo "Error: No git user.email or user.name configured" >&2
    return 1
  fi

  # Get short hostname — cross-platform:
  #   Linux/macOS: hostname -s works
  #   Windows Git Bash: hostname -s may fail, fall back to hostname + strip domain
  host_part="$(hostname -s 2>/dev/null)" || true
  if [[ -z "$host_part" ]]; then
    host_part="$(hostname 2>/dev/null)" || true
    # Strip domain suffix if present (e.g., "host.domain.com" -> "host")
    host_part="${host_part%%.*}"
  fi
  if [[ -z "$host_part" ]]; then
    echo "Error: Could not determine hostname" >&2
    return 1
  fi

  # Replace spaces with hyphens (common in git user.name like "John Doe")
  user_part="${user_part// /-}"
  host_part="${host_part// /-}"
  local identity="${user_part}@${host_part}"

  # OWASP A03: validate before returning
  if ! validate_session_identity "$identity"; then
    echo "Error: Session identity contains invalid characters: $identity" >&2
    return 1
  fi

  printf '%s' "$identity"
}

# ── Input Sanitization ─────────────────────────────────────────────────

# Sanitize a config value: strip shell-injection patterns (OWASP A03).
# Removes: backticks, $(...), semicolons, pipes, newlines.
# Usage: sanitized="$(sanitize_config_value "$raw")"
sanitize_config_value() {
  local val="$1"
  # Remove backtick command substitution
  val="${val//\`/}"
  # Remove $(...) command substitution patterns (loop handles nested)
  val="$(printf '%s' "$val" | sed -e ':loop' -e 's/\$([^()]*)//g' -e 't loop')"
  # Remove semicolons (command chaining)
  val="${val//;/}"
  # Remove pipes (command chaining)
  val="${val//|/}"
  # Collapse newlines to spaces
  val="$(printf '%s' "$val" | tr '\n' ' ')"
  # Trim leading/trailing whitespace
  val="$(printf '%s' "$val" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')"
  printf '%s' "$val"
}

# ── Config Reading ─────────────────────────────────────────────────────

# Read a key from .beads/config.json (JSON format).
# Usage: value="$(_read_config_json "/path/to/repo" "sync_branch")"
# Returns empty string if file missing or key absent.
_read_config_json() {
  local repo_dir="$1"
  local key="$2"
  local config_file="$repo_dir/.beads/config.json"
  if [ -f "$config_file" ] && command -v jq &>/dev/null; then
    local raw
    raw="$(jq -r --arg k "$key" '.[$k] // empty' -- "$config_file" 2>/dev/null)" || true
    if [ -n "$raw" ]; then
      sanitize_config_value "$raw"
      return 0
    fi
  fi
  printf ''
}

# Read a key from .beads/config.yaml (YAML format, simple grep-based).
# Only supports top-level scalar keys (no nesting).
# Usage: value="$(_read_config_yaml "/path/to/repo" "sync-branch")"
# Returns empty string if file missing or key absent.
_read_config_yaml() {
  local repo_dir="$1"
  local key="$2"
  local config_file="$repo_dir/.beads/config.yaml"
  if [ -f "$config_file" ]; then
    local raw
    # Escape regex metacharacters in key for safe use in grep/sed
    local escaped_key
    escaped_key="$(printf '%s' "$key" | sed 's/[][\\.^$*+?(){}|/]/\\&/g')"
    # Match: key: "value" or key: value (strip quotes)
    raw="$(grep -E "^${escaped_key}:" -- "$config_file" 2>/dev/null | head -1 | sed -e "s/^${escaped_key}:[[:space:]]*//" -e 's/^"//' -e 's/"$//' -e "s/^'//" -e "s/'$//")" || true
    if [ -n "$raw" ]; then
      sanitize_config_value "$raw"
      return 0
    fi
  fi
  printf ''
}

# Read a sync config value with fallback: config.json > config.yaml.
# Supports both JSON key (underscore) and YAML key (hyphen) conventions.
# Usage: value="$(_read_sync_config "/path/to/repo" "sync_branch" "sync-branch")"
_read_sync_config() {
  local repo_dir="$1"
  local json_key="$2"
  local yaml_key="$3"
  local value

  # Try JSON config first
  value="$(_read_config_json "$repo_dir" "$json_key")"
  if [ -n "$value" ]; then
    printf '%s' "$value"
    return 0
  fi

  # Try YAML config
  value="$(_read_config_yaml "$repo_dir" "$yaml_key")"
  if [ -n "$value" ]; then
    printf '%s' "$value"
    return 0
  fi

  printf ''
}

# ── Sync Branch Detection ─────────────────────────────────────────────

# Detect the sync branch with a fallback chain:
#   1. Config file (.beads/config.json sync_branch or .beads/config.yaml sync-branch)
#   2. Environment variable BD_SYNC_BRANCH
#   3. git symbolic-ref refs/remotes/<remote>/HEAD
#   4. Try 'main' branch on remote
#   5. Try 'master' branch on remote
#
# Usage: branch="$(get_sync_branch "/path/to/repo")"
# Arguments:
#   $1 — repo directory (optional, defaults to current directory)
get_sync_branch() {
  local repo_dir="${1:-.}"
  local branch

  # 1. Config file takes priority
  branch="$(_read_sync_config "$repo_dir" "sync_branch" "sync-branch")"
  if [ -n "$branch" ]; then
    printf '%s' "$branch"
    return 0
  fi

  # 2. Environment variable
  if [ -n "${BD_SYNC_BRANCH:-}" ]; then
    printf '%s' "$BD_SYNC_BRANCH"
    return 0
  fi

  # Determine which remote to check (respects sync_remote config)
  local remote
  remote="$(get_sync_remote "$repo_dir")"

  # 3. git symbolic-ref refs/remotes/<remote>/HEAD
  # Note: symbolic-ref accepts -- before ref names, but rev-parse --verify
  # does NOT — after --, rev-parse treats arguments as paths, not revisions.
  branch="$(git -C "$repo_dir" symbolic-ref "refs/remotes/${remote}/HEAD" 2>/dev/null)" || true
  if [ -n "$branch" ]; then
    # Strip refs/remotes/<remote>/ prefix
    branch="${branch#refs/remotes/${remote}/}"
    printf '%s' "$branch"
    return 0
  fi

  # 4. Try 'main' — check if remote has it
  # Note: no -- before ref; rev-parse --verify treats post--- args as paths
  if git -C "$repo_dir" rev-parse --verify "refs/remotes/${remote}/main" &>/dev/null; then
    printf '%s' "main"
    return 0
  fi

  # 5. Try 'master'
  if git -C "$repo_dir" rev-parse --verify "refs/remotes/${remote}/master" &>/dev/null; then
    printf '%s' "master"
    return 0
  fi

  # Last resort: return 'main' as default
  printf '%s' "main"
}

# ── Sync Remote Detection ─────────────────────────────────────────────

# Detect the sync remote with a fallback chain:
#   1. Config file (.beads/config.json sync_remote or .beads/config.yaml sync-remote)
#   2. Environment variable BD_SYNC_REMOTE
#   3. Detect 'upstream' remote (fork-based workflow)
#   4. Default to 'origin'
#
# Usage: remote="$(get_sync_remote "/path/to/repo")"
# Arguments:
#   $1 — repo directory (optional, defaults to current directory)
get_sync_remote() {
  local repo_dir="${1:-.}"
  local remote

  # 1. Config file takes priority
  remote="$(_read_sync_config "$repo_dir" "sync_remote" "sync-remote")"
  if [ -n "$remote" ]; then
    printf '%s' "$remote"
    return 0
  fi

  # 2. Environment variable
  if [ -n "${BD_SYNC_REMOTE:-}" ]; then
    printf '%s' "$BD_SYNC_REMOTE"
    return 0
  fi

  # 3. Detect 'upstream' remote (common in fork-based workflows)
  if git -C "$repo_dir" remote get-url -- upstream &>/dev/null; then
    printf '%s' "upstream"
    return 0
  fi

  # 4. Default to 'origin'
  printf '%s' "origin"
}

# ── Auto Sync ──────────────────────────────────────────────────────────

# Staleness threshold in seconds (15 minutes)
_SYNC_STALENESS_THRESHOLD=900

# auto_sync [repo_dir]
# Runs `bd sync` to pull/push latest beads state.
# On failure: warns but continues (non-blocking, always returns 0).
# On success: records Unix epoch timestamp to .beads/.last-sync
#             and updates file index from all in-progress issues' task files.
#
# Environment overrides (for testing):
#   BD_SYNC_CMD — command to run instead of `bd sync` (default: "bd sync")
#   FILE_INDEX_ROOT — root directory for file-index.sh (default: repo_dir)
auto_sync() {
  local repo_dir="${1:-.}"
  local sync_cmd="${BD_SYNC_CMD:-bd sync}"
  local last_sync_file="$repo_dir/.beads/.last-sync"

  # Ensure .beads directory exists
  mkdir -p "$repo_dir/.beads"

  # Run bd sync (or mock) — use $sync_cmd without eval to prevent injection
  # shellcheck disable=SC2086
  if $sync_cmd >/dev/null 2>&1; then
    # Success: record timestamp
    date +%s > "$last_sync_file"

    # Update file index from in-progress issues' task files
    _auto_sync_update_file_index "$repo_dir"
  else
    # Failure: warn but continue (non-blocking)
    local last_ts="unknown"
    if [[ -f "$last_sync_file" ]]; then
      last_ts="$(cat "$last_sync_file")"
      if [[ "$last_ts" =~ ^[0-9]+$ ]]; then
        local mins=$(( ($(date +%s) - last_ts) / 60 ))
        last_ts="${mins}m ago"
      fi
    fi
    echo "Warning: sync failed, working with local data (last sync: $last_ts)" >&2
  fi

  return 0
}

# _auto_sync_update_file_index [repo_dir]
# After a successful sync, iterate over in-progress issues and update the file index.
# Uses file_index_update_from_tasks from file-index.sh.
_auto_sync_update_file_index() {
  local repo_dir="${1:-.}"

  # Source file-index.sh if file_index_update_from_tasks is not defined
  if ! command -v file_index_update_from_tasks &>/dev/null; then
    local script_dir
    script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
    if [[ -f "$script_dir/file-index.sh" ]]; then
      source "$script_dir/file-index.sh"
    else
      return 0
    fi
  fi

  # Export FILE_INDEX_ROOT so file-index.sh uses the right directory
  export FILE_INDEX_ROOT="${FILE_INDEX_ROOT:-$repo_dir}"

  # Find in-progress issues by scanning .beads/issues.jsonl
  local issues_file="$repo_dir/.beads/issues.jsonl"
  if [[ ! -f "$issues_file" ]] || [[ ! -s "$issues_file" ]]; then
    return 0
  fi

  # Check jq is available
  if ! command -v jq &>/dev/null; then
    return 0
  fi

  # Extract in-progress issue IDs (LWW resolution: group by id, take last, filter in_progress)
  local issue_ids
  issue_ids="$(jq -s -r '
    sort_by(.id)
    | group_by(.id)
    | map(sort_by(.updated_at) | last)
    | map(select(.status == "in_progress"))
    | .[].id
  ' "$issues_file" 2>/dev/null)" || true

  if [[ -z "$issue_ids" ]]; then
    return 0
  fi

  # For each in-progress issue, find its task file and update the file index
  local issue_id
  while IFS= read -r issue_id; do
    if [[ -z "$issue_id" ]]; then
      continue
    fi

    # Look for this issue's task file
    # 1. Try beads design metadata (set by beads-context.sh set-design)
    local task_file=""
    local design_meta
    design_meta="$(bd show "$issue_id" 2>/dev/null | grep -A1 'DESIGN' | tail -1 | sed 's/.*| //')" || true
    # OWASP A04: reject paths that escape the repo root
    case "$design_meta" in
      *../*|..*) design_meta="" ;;
    esac
    if [[ -n "$design_meta" ]] && [[ -f "$repo_dir/$design_meta" ]]; then
      task_file="$repo_dir/$design_meta"
    fi

    # 2. Fall back to known locations with issue-specific naming
    if [[ -z "$task_file" ]]; then
      for candidate in \
        "$repo_dir/.beads/tasks/${issue_id}.md" \
        "$repo_dir/.beads/tasks/${issue_id}-tasks.md"; do
        if [[ -f "$candidate" ]]; then
          task_file="$candidate"
          break
        fi
      done
    fi

    # Update file index (file_index_update_from_tasks handles missing task files gracefully)
    file_index_update_from_tasks "$issue_id" "$task_file" "in_progress" 2>/dev/null || true
  done <<< "$issue_ids"

  # Tombstone closed issues: find indexed entries no longer in_progress
  local indexed_ids
  indexed_ids="$(file_index_read 2>/dev/null | jq -r '.[].issue_id' 2>/dev/null)" || true
  if [[ -n "$indexed_ids" ]]; then
    while IFS= read -r indexed_id; do
      [[ -z "$indexed_id" ]] && continue
      # If this issue is not in the in_progress list, tombstone it
      if ! printf '%s' "$issue_ids" | grep -qF "$indexed_id"; then
        file_index_remove "$indexed_id" 2>/dev/null || true
      fi
    done <<< "$indexed_ids"
  fi

  return 0
}

# check_sync_staleness [repo_dir]
# Reads .beads/.last-sync and warns if the last sync is older than 15 minutes.
# Always returns 0 (non-blocking).
# Outputs:
#   - Nothing if sync is fresh (<= 900 seconds)
#   - Warning to stderr if stale (> 900 seconds)
#   - Warning to stderr if .last-sync is missing (never synced)
check_sync_staleness() {
  local repo_dir="${1:-.}"
  local last_sync_file="$repo_dir/.beads/.last-sync"

  if [[ ! -f "$last_sync_file" ]]; then
    echo "Warning: beads sync has never been run (no .last-sync record)" >&2
    return 0
  fi

  local last_ts
  last_ts="$(cat "$last_sync_file")"

  # Validate it's a number
  if [[ ! "$last_ts" =~ ^[0-9]+$ ]]; then
    echo "Warning: .last-sync contains invalid timestamp" >&2
    return 0
  fi

  local now
  now="$(date +%s)"
  local age=$(( now - last_ts ))

  if [[ "$age" -gt "$_SYNC_STALENESS_THRESHOLD" ]]; then
    local minutes=$(( age / 60 ))
    echo "Warning: beads data is stale (last sync: ${minutes}m ago, threshold: 15m)" >&2
  fi

  return 0
}

# ── CLI Dispatcher ─────────────────────────────────────────────────────

if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
  case "${1:-}" in
    auto-sync) shift; auto_sync "$@" ;;
    check-staleness) shift; check_sync_staleness "$@" ;;
    identity) get_session_identity ;;
    sync-branch) shift; get_sync_branch "$@" ;;
    sync-remote) shift; get_sync_remote "$@" ;;
    *) echo "Usage: sync-utils.sh <auto-sync|check-staleness|identity|sync-branch|sync-remote>" >&2; exit 1 ;;
  esac
fi
