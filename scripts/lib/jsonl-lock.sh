#!/usr/bin/env bash
# scripts/lib/jsonl-lock.sh — Atomic JSONL append with file locking
#
# Provides atomic_jsonl_append() for concurrent-safe JSONL file writes.
# Cross-platform: uses flock on Linux/WSL/Git Bash, mkdir-based fallback on macOS.
#
# Usage (source this file):
#   source scripts/lib/jsonl-lock.sh
#   atomic_jsonl_append "/path/to/file.jsonl" '{"key":"value"}'
#
# Exit codes: 0=success, 1=lock timeout or write failure
# Lock timeout: 5 seconds

# atomic_jsonl_append <jsonl_file> <json_line>
# Appends a JSON line to a JSONL file with file locking.
# Lock file: <jsonl_file>.lock (flock) or <jsonl_file>.lock.d (mkdir)
# Timeout: 5 seconds
# Exit codes: 0=success, 1=lock timeout or write failure
atomic_jsonl_append() {
  local jsonl_file="$1"
  local json_line="$2"

  mkdir -p "$(dirname "$jsonl_file")"

  if command -v flock &>/dev/null; then
    # flock-based locking (Linux, WSL, Git Bash)
    local lock_file="${jsonl_file}.lock"
    (
      flock -w 5 200 || { echo "Error: JSONL lock timeout after 5s" >&2; return 1; }
      printf '%s\n' "$json_line" >> "$jsonl_file"
    ) 200>"$lock_file"
  else
    # mkdir-based fallback (macOS, systems without flock)
    local lock_file="${jsonl_file}.lock.d"
    local attempts=0
    while ! mkdir "$lock_file" 2>/dev/null; do
      attempts=$((attempts + 1))
      if [[ $attempts -ge 50 ]]; then  # 50 * 0.1s = 5s timeout
        echo "Error: JSONL lock timeout after 5s" >&2
        return 1
      fi
      sleep 0.1
    done
    # Ensure cleanup on exit
    trap 'rmdir "$lock_file" 2>/dev/null' RETURN
    printf '%s\n' "$json_line" >> "$jsonl_file"
    rmdir "$lock_file" 2>/dev/null
    trap - RETURN
  fi
}
