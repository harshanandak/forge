#!/usr/bin/env bash
# conflict-detect.sh — Detect file/module overlaps between in-progress issues.
#
# Usage:
#   conflict-detect.sh --issue <id>              Check overlaps for a given issue
#   conflict-detect.sh --files <file1,file2,...>  Check arbitrary files against index
#   conflict-detect.sh --issue <id> --detail      Drill down to file-level overlap
#   conflict-detect.sh --files <f1,f2> --detail   Drill down to file-level overlap
#
# Exit codes:
#   0 = no conflicts found
#   1 = conflicts found (or validation error)
#
# OWASP A03: All inputs validated; shell variables quoted; jq --arg used.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Source file-index helpers (file_index_read, file_index_get)
source "$SCRIPT_DIR/file-index.sh"

# Source sync-utils (get_session_identity, sanitize_config_value)
# Only source if available (tests may not need all utils)
if [[ -f "$SCRIPT_DIR/sync-utils.sh" ]]; then
  source "$SCRIPT_DIR/sync-utils.sh"
fi

# ── Input Validation ─────────────────────────────────────────────────────

# Validate issue_id: alphanumeric + hyphens only
_validate_issue_id_arg() {
  local id="$1"
  if [[ ! "$id" =~ ^[a-zA-Z0-9-]+$ ]]; then
    echo "Error: invalid issue_id format: must be alphanumeric + hyphens only" >&2
    return 1
  fi
}

# Validate a file path: no shell injection patterns
# Allows: alphanumeric, dots, hyphens, underscores, forward slashes
_validate_file_path() {
  local path="$1"
  if [[ ! "$path" =~ ^[a-zA-Z0-9./_@[:space:]-]+$ ]]; then
    echo "Error: invalid file path — contains disallowed characters: $path" >&2
    return 1
  fi
}

# ── Stale Sync Check ─────────────────────────────────────────────────────

# Check if .beads/.last-sync is older than 15 minutes (900 seconds).
# Prints a warning to stderr if stale.
_check_stale_sync() {
  local root="${FILE_INDEX_ROOT:-.}"
  local last_sync_file="$root/.beads/.last-sync"

  if [[ ! -f "$last_sync_file" ]]; then
    # No sync file — skip warning (first run)
    return 0
  fi

  local last_sync_ts
  last_sync_ts="$(cat "$last_sync_file" 2>/dev/null | tr -d '[:space:]')"

  if [[ -z "$last_sync_ts" ]]; then
    return 0
  fi

  # .last-sync stores Unix epoch seconds (written by sync-utils.sh)
  local last_epoch now_epoch
  if [[ "$last_sync_ts" =~ ^[0-9]+$ ]]; then
    last_epoch="$last_sync_ts"
  else
    # Fallback: try parsing as ISO 8601 (GNU date, then BSD date)
    last_epoch="$(date -d "$last_sync_ts" +%s 2>/dev/null || date -jf "%Y-%m-%dT%H:%M:%SZ" "$last_sync_ts" +%s 2>/dev/null || echo 0)"
  fi
  now_epoch="$(date +%s)"

  local diff=$(( now_epoch - last_epoch ))

  if [[ "$diff" -gt 900 ]]; then
    echo "WARNING: File index may be stale (last sync: ${last_sync_ts}, ${diff}s ago > 900s threshold)" >&2
  fi
}

# ── Module Extraction ────────────────────────────────────────────────────

# Given a file path, derive its module directory (parent directory + /).
# e.g., "src/lib/status.ts" -> "src/lib/"
_derive_module() {
  local filepath="$1"
  local dir
  dir="$(dirname "$filepath")"
  # Ensure trailing slash
  if [[ "$dir" == "." ]]; then
    printf '%s' "./"
  else
    printf '%s/' "$dir"
  fi
}

# ── Core Conflict Detection ──────────────────────────────────────────────

# Check for conflicts between a set of modules/files and all entries in the index.
# Arguments:
#   $1 — JSON array of modules to check
#   $2 — JSON array of files to check
#   $3 — issue_id to exclude from comparison (empty string for --files mode)
#   $4 — "true" or "false" for detail mode
# Outputs conflict report to stdout.
# Returns 0 if no conflicts, 1 if conflicts found.
_detect_conflicts() {
  local check_modules="$1"
  local check_files="$2"
  local exclude_issue="$3"
  local detail="$4"

  # Read all active entries from file index
  local all_entries
  all_entries="$(file_index_read)"

  if [[ "$all_entries" == "[]" ]]; then
    echo "No conflicts found. File index is empty."
    return 0
  fi

  local conflicts_found=0
  local output=""

  # Iterate over each entry in the index
  local entry_count
  entry_count="$(printf '%s' "$all_entries" | jq '. | length')"

  local i=0
  while [[ "$i" -lt "$entry_count" ]]; do
    local entry
    entry="$(printf '%s' "$all_entries" | jq -c ".[$i]")"

    local entry_issue_id
    entry_issue_id="$(printf '%s' "$entry" | jq -r '.issue_id')"

    # Skip the issue we're checking (don't conflict with yourself)
    if [[ -n "$exclude_issue" ]] && [[ "$entry_issue_id" == "$exclude_issue" ]]; then
      i=$((i + 1))
      continue
    fi

    local entry_developer
    entry_developer="$(printf '%s' "$entry" | jq -r '.developer')"

    local entry_modules
    entry_modules="$(printf '%s' "$entry" | jq -c '.modules')"

    local entry_files
    entry_files="$(printf '%s' "$entry" | jq -c '.files')"

    # Check module overlap
    local module_overlaps
    module_overlaps="$(jq -n -c \
      --argjson a "$check_modules" \
      --argjson b "$entry_modules" \
      '[$a[] as $m | $b[] | select(. == $m)] | unique')"

    local module_overlap_count
    module_overlap_count="$(printf '%s' "$module_overlaps" | jq '. | length')"

    if [[ "$module_overlap_count" -gt 0 ]]; then
      conflicts_found=1
      local overlapping_modules_str
      overlapping_modules_str="$(printf '%s' "$module_overlaps" | jq -r '.[]' | tr '\n' ', ' | sed 's/,$//')"

      output+="CONFLICT: Issue ${entry_issue_id} (developer: ${entry_developer})"$'\n'
      output+="  Overlapping modules: ${overlapping_modules_str}"$'\n'

      # Detail mode: show file-level overlap
      if [[ "$detail" == "true" ]]; then
        local file_overlaps
        file_overlaps="$(jq -n -c \
          --argjson a "$check_files" \
          --argjson b "$entry_files" \
          '[$a[] as $f | $b[] | select(. == $f)] | unique')"

        local file_overlap_count
        file_overlap_count="$(printf '%s' "$file_overlaps" | jq '. | length')"

        if [[ "$file_overlap_count" -gt 0 ]]; then
          local overlapping_files_str
          overlapping_files_str="$(printf '%s' "$file_overlaps" | jq -r '.[]' | tr '\n' ', ' | sed 's/,$//')"
          output+="  Overlapping files: ${overlapping_files_str}"$'\n'
        else
          output+="  No exact file overlaps (module-level only)"$'\n'
        fi
      fi
    fi

    i=$((i + 1))
  done

  if [[ "$conflicts_found" -eq 1 ]]; then
    printf '%s' "$output"
    return 1
  else
    echo "No conflicts found."
    return 0
  fi
}

# ── Main ─────────────────────────────────────────────────────────────────

main() {
  local mode=""        # "issue" or "files"
  local issue_id=""
  local files_arg=""
  local detail="false"

  # Parse arguments
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --issue)
        mode="issue"
        shift
        if [[ $# -eq 0 ]]; then
          echo "Error: --issue requires an argument" >&2
          exit 1
        fi
        issue_id="$1"
        shift
        ;;
      --files)
        mode="files"
        shift
        if [[ $# -eq 0 ]]; then
          echo "Error: --files requires an argument" >&2
          exit 1
        fi
        files_arg="$1"
        shift
        ;;
      --detail)
        detail="true"
        shift
        ;;
      *)
        echo "Error: unknown argument '$1'" >&2
        echo "Usage: conflict-detect.sh --issue <id> [--detail]" >&2
        echo "       conflict-detect.sh --files <file1,file2,...> [--detail]" >&2
        exit 1
        ;;
    esac
  done

  # Require at least one mode
  if [[ -z "$mode" ]]; then
    echo "Usage: conflict-detect.sh --issue <id> [--detail]" >&2
    echo "       conflict-detect.sh --files <file1,file2,...> [--detail]" >&2
    exit 1
  fi

  # Check for stale sync
  _check_stale_sync

  if [[ "$mode" == "issue" ]]; then
    # Validate issue_id
    _validate_issue_id_arg "$issue_id" || exit 1

    # Get the issue's entry from the file index
    local entry
    entry="$(file_index_get "$issue_id")"

    if [[ "$entry" == "null" ]]; then
      echo "Info: issue '$issue_id' not yet in file index — no conflicts possible." >&2
      exit 0
    fi

    local check_modules check_files
    check_modules="$(printf '%s' "$entry" | jq -c '.modules')"
    check_files="$(printf '%s' "$entry" | jq -c '.files')"

    _detect_conflicts "$check_modules" "$check_files" "$issue_id" "$detail"

  elif [[ "$mode" == "files" ]]; then
    # Parse comma-separated file list
    local IFS=','
    local -a file_list
    read -ra file_list <<< "$files_arg"

    # Validate each file path
    local -a valid_files=()
    local -a derived_modules=()
    for f in "${file_list[@]}"; do
      # Trim whitespace
      f="$(printf '%s' "$f" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')"
      _validate_file_path "$f" || exit 1
      valid_files+=("$f")

      # Derive module from file path
      local mod
      mod="$(_derive_module "$f")"
      derived_modules+=("$mod")
    done

    # Build JSON arrays using jq
    local files_json modules_json
    files_json="$(printf '%s\n' "${valid_files[@]}" | jq -R '.' | jq -s -c '.')"
    # Deduplicate modules
    modules_json="$(printf '%s\n' "${derived_modules[@]}" | jq -R '.' | jq -s -c 'unique')"

    _detect_conflicts "$modules_json" "$files_json" "" "$detail"
  fi
}

main "$@"
