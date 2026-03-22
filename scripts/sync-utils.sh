#!/usr/bin/env bash
# sync-utils.sh — Shared utilities for multi-dev-awareness sync scripts.
#
# Source this file; do not execute directly.
# Cross-platform: works on Windows (Git Bash), macOS, and Linux.
# OWASP A03: All identity strings validated against strict allowlist regex.
# OWASP A03: All config values sanitized before use (no injection vectors).

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
    # Match: key: "value" or key: value (strip quotes)
    raw="$(grep -E "^${key}:" -- "$config_file" 2>/dev/null | head -1 | sed -e "s/^${key}:[[:space:]]*//" -e 's/^"//' -e 's/"$//' -e "s/^'//" -e "s/'$//")" || true
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

  # Determine which remote to check (use get_sync_remote logic but avoid recursion)
  local remote="origin"

  # 3. git symbolic-ref refs/remotes/<remote>/HEAD
  branch="$(git -C "$repo_dir" symbolic-ref -- "refs/remotes/${remote}/HEAD" 2>/dev/null)" || true
  if [ -n "$branch" ]; then
    # Strip refs/remotes/<remote>/ prefix
    branch="${branch#refs/remotes/${remote}/}"
    printf '%s' "$branch"
    return 0
  fi

  # 4. Try 'main' — check if remote has it
  if git -C "$repo_dir" rev-parse --verify -- "refs/remotes/${remote}/main" &>/dev/null; then
    printf '%s' "main"
    return 0
  fi

  # 5. Try 'master'
  if git -C "$repo_dir" rev-parse --verify -- "refs/remotes/${remote}/master" &>/dev/null; then
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
