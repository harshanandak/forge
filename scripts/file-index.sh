#!/usr/bin/env bash
# file-index.sh — File index JSONL helpers for multi-developer awareness.
#
# Manages .beads/file-index.jsonl — an append-only log of which developer
# is working on which files/modules, keyed by issue_id.
#
# Functions (source this file):
#   file_index_add    <issue_id> <developer> <files_json> <modules_json>
#   file_index_remove <issue_id>
#   file_index_read
#   file_index_get    <issue_id>
#
# Uses jq for all JSON construction (never string concatenation).
# OWASP A03: All inputs validated and shell-injection patterns stripped.

# Only set errexit/pipefail when run as a script, not when sourced
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
  set -euo pipefail
fi

# ── Helpers ──────────────────────────────────────────────────────────────

# Resolve the JSONL file path.
# FILE_INDEX_ROOT can be overridden for testing.
_file_index_path() {
  local root="${FILE_INDEX_ROOT:-.}"
  printf '%s' "$root/.beads/file-index.jsonl"
}

# Sanitize a string: strip shell-injection patterns (OWASP A03)
# Reused from dep-guard.sh pattern.
# Removes: double quotes, $(...), backticks, semicolons, and newlines
sanitize() {
  local val="$1"
  # Remove double quotes
  val="${val//\"/}"
  # Remove $(...) command substitution patterns (loop handles nested)
  val="$(printf '%s' "$val" | sed -e ':loop' -e 's/\$([^()]*)//g' -e 't loop')"
  # Remove backtick command substitution
  val="${val//\`/}"
  # Remove semicolons (command chaining)
  val="${val//;/}"
  # Replace newlines with spaces
  val="$(printf '%s' "$val" | tr '\n' ' ')"
  printf '%s' "$val"
}

# Validate issue_id: alphanumeric + hyphens only
_validate_issue_id() {
  local id="$1"
  if [[ ! "$id" =~ ^[a-zA-Z0-9-]+$ ]]; then
    echo "Error: invalid issue_id format: must be alphanumeric + hyphens only" >&2
    return 1
  fi
}

# Validate developer identity: ^[a-zA-Z0-9._@+-]+$
_validate_developer() {
  local dev="$1"
  if [[ ! "$dev" =~ ^[a-zA-Z0-9._@+\-]+$ ]]; then
    echo "Error: invalid developer format: must match ^[a-zA-Z0-9._@+-]+$" >&2
    return 1
  fi
}

# ── Public functions ─────────────────────────────────────────────────────

# file_index_add <issue_id> <developer> <files_json> <modules_json>
# Append an entry to the file index JSONL.
# files_json and modules_json must be valid JSON arrays.
file_index_add() {
  local raw_issue_id="$1"
  local raw_developer="$2"
  local files_json="$3"
  local modules_json="$4"

  # Sanitize inputs
  local issue_id
  issue_id="$(sanitize "$raw_issue_id")"
  # Trim whitespace produced by sanitize
  issue_id="$(printf '%s' "$issue_id" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')"

  local developer
  developer="$(sanitize "$raw_developer")"
  developer="$(printf '%s' "$developer" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')"

  # Validate formats (after sanitization — catches injection that was stripped)
  _validate_issue_id "$issue_id" || return 1
  _validate_developer "$developer" || return 1

  # Validate files_json and modules_json are valid JSON arrays
  if ! printf '%s' "$files_json" | jq 'if type == "array" then empty else error end' 2>/dev/null; then
    echo "Error: files_json must be a valid JSON array" >&2
    return 1
  fi
  if ! printf '%s' "$modules_json" | jq 'if type == "array" then empty else error end' 2>/dev/null; then
    echo "Error: modules_json must be a valid JSON array" >&2
    return 1
  fi

  # Generate timestamp
  local updated_at
  updated_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

  # Build JSON using jq (never string concatenation)
  local json_line
  json_line="$(jq -n -c \
    --arg id "$issue_id" \
    --arg dev "$developer" \
    --argjson files "$files_json" \
    --argjson modules "$modules_json" \
    --arg ts "$updated_at" \
    '{
      issue_id: $id,
      developer: $dev,
      files: $files,
      modules: $modules,
      updated_at: $ts,
      tombstone: false
    }')"

  # Append to JSONL file
  local jsonl_path
  jsonl_path="$(_file_index_path)"

  # Ensure parent directory exists
  mkdir -p "$(dirname "$jsonl_path")"

  printf '%s\n' "$json_line" >> "$jsonl_path"
}

# file_index_remove <issue_id>
# Append a tombstone entry for the given issue.
file_index_remove() {
  local raw_issue_id="$1"

  # Sanitize and validate
  local issue_id
  issue_id="$(sanitize "$raw_issue_id")"
  issue_id="$(printf '%s' "$issue_id" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')"
  _validate_issue_id "$issue_id" || return 1

  # Generate timestamp
  local updated_at
  updated_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

  # Build tombstone JSON using jq
  local json_line
  json_line="$(jq -n -c \
    --arg id "$issue_id" \
    --arg ts "$updated_at" \
    '{
      issue_id: $id,
      developer: "",
      files: [],
      modules: [],
      updated_at: $ts,
      tombstone: true
    }')"

  # Append to JSONL file
  local jsonl_path
  jsonl_path="$(_file_index_path)"
  mkdir -p "$(dirname "$jsonl_path")"
  printf '%s\n' "$json_line" >> "$jsonl_path"
}

# file_index_read
# Read all entries, resolve LWW per issue_id, output active entries as JSON array.
# Returns "[]" if the file is missing or empty.
file_index_read() {
  local jsonl_path
  jsonl_path="$(_file_index_path)"

  # Handle missing or empty file
  if [[ ! -f "$jsonl_path" ]] || [[ ! -s "$jsonl_path" ]]; then
    printf '%s' "[]"
    return 0
  fi

  # Use jq to:
  # 1. Slurp all lines into an array
  # 2. Group by issue_id
  # 3. For each group, sort by updated_at and take the last (LWW)
  # 4. Filter out tombstoned entries
  jq -s -c '
    group_by(.issue_id)
    | map(sort_by(.updated_at) | last)
    | map(select(.tombstone == false))
  ' "$jsonl_path"
}

# file_index_get <issue_id>
# Get a single issue's file entry (after LWW resolution).
# Returns "null" if not found or tombstoned.
file_index_get() {
  local raw_issue_id="$1"

  # Sanitize and validate
  local issue_id
  issue_id="$(sanitize "$raw_issue_id")"
  issue_id="$(printf '%s' "$issue_id" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')"
  _validate_issue_id "$issue_id" || return 1

  local jsonl_path
  jsonl_path="$(_file_index_path)"

  # Handle missing or empty file
  if [[ ! -f "$jsonl_path" ]] || [[ ! -s "$jsonl_path" ]]; then
    printf '%s' "null"
    return 0
  fi

  # Use jq to filter by issue_id, resolve LWW, check tombstone
  jq -s -c --arg id "$issue_id" '
    map(select(.issue_id == $id))
    | sort_by(.updated_at)
    | last
    | if . == null then null
      elif .tombstone == true then null
      else .
      end
  ' "$jsonl_path"
}

# ── Main dispatcher (when run as a script) ────────────────────────────────

if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
  if [[ $# -lt 1 ]]; then
    cat >&2 <<'EOF'
Usage: file-index.sh <subcommand> [args...]

Subcommands:
  add     <issue_id> <developer> <files_json> <modules_json>
  remove  <issue_id>
  read
  get     <issue_id>
EOF
    exit 1
  fi

  subcommand="$1"
  shift

  case "$subcommand" in
    add)    file_index_add "$@" ;;
    remove) file_index_remove "$@" ;;
    read)   file_index_read ;;
    get)    file_index_get "$@" ;;
    *)
      echo "Error: Unknown subcommand '${subcommand}'" >&2
      exit 1
      ;;
  esac
fi
