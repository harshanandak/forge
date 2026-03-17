#!/usr/bin/env bash
# dep-guard.sh — Dependency-guard helper for pre-change impact analysis.
#
# Subcommands:
#   find-consumers     <file-path>                Find files that import/require a given module
#   check-ripple       <issue-id>                  Check ripple impact via keyword matching
#   store-contracts    <issue-id> <contracts-string> Store contract metadata on a Beads issue
#   extract-contracts  <file-path>                  Extract public API contracts from a file
#
# Cross-platform: works on Windows (Git Bash), macOS, and Linux.
# OWASP A03: All variables properly quoted to prevent shell injection.

set -euo pipefail

# ── Helpers ──────────────────────────────────────────────────────────────

usage() {
  cat >&2 <<'EOF'
Usage: dep-guard.sh <subcommand> [args...]

Subcommands:
  find-consumers     <file-path>                Find files that import/require a given module
  check-ripple       <issue-id>                  Check ripple impact via keyword matching
  store-contracts    <issue-id> <contracts-string> Store contract metadata on a Beads issue
  extract-contracts  <file-path>                  Extract public API contracts from a file
EOF
  exit 1
}

die() {
  echo "Error: $1" >&2
  exit 1
}

# Sanitize a string: strip shell-injection patterns (OWASP A03)
# Removes: double quotes, $(...), backticks, semicolons, and newlines
sanitize() {
  local val="$1"
  # Remove double quotes
  val="${val//\"/}"
  # Remove $(...) command substitution patterns (loop handles nested)
  # Use newline-separated commands for BSD sed compatibility (macOS)
  val="$(printf '%s' "$val" | sed -e ':loop' -e 's/\$([^()]*)//g' -e 't loop')"
  # Remove backtick command substitution
  val="${val//\`/}"
  # Remove semicolons (command chaining)
  val="${val//;/}"
  # Replace newlines with spaces
  val="$(printf '%s' "$val" | tr '\n' ' ')"
  printf '%s' "$val"
}

# Run bd update and check for errors in both exit code and output.
# bd update exits 0 even for non-existent issues, so we check stdout too.
bd_update() {
  local output
  output="$(${BD_CMD:-bd} update "$@" 2>&1)"
  local rc=$?

  if [[ $rc -ne 0 ]]; then
    echo "$output" >&2
    return 1
  fi

  # bd prints "Error resolving/updating ..." to stdout for non-existent issues
  # Use specific patterns to avoid false positives from data containing "error"
  if printf '%s' "$output" | grep -Eqi '^Error|Error resolving|Error updating'; then
    echo "$output" >&2
    return 1
  fi

  echo "$output"
  return 0
}

# Run bd show <id> --json and return the JSON string.
# Handles both array and object JSON responses.
bd_show_json() {
  local issue_id="$1"

  local json
  json="$(${BD_CMD:-bd} show "$issue_id" --json 2>&1)" || die "Failed to show issue ${issue_id}"

  # bd show may exit 0 but print an error for non-existent issues
  if printf '%s' "$json" | grep -Eqi '^Error (fetching|resolving)'; then
    die "Issue not found: ${issue_id}"
  fi

  # bd show returns "[]" or empty for non-existent issues
  if [[ -z "$json" || "$json" == "[]" || "$json" == "null" ]]; then
    die "Issue not found: ${issue_id}"
  fi

  # Normalize: if the response is an array, extract the first element
  if command -v jq &>/dev/null; then
    local normalized
    normalized="$(printf '%s' "$json" | jq 'if type == "array" then .[0] else . end' 2>/dev/null)" || true
    if [[ -n "$normalized" && "$normalized" != "null" ]]; then
      json="$normalized"
    fi
  fi

  printf '%s' "$json"
}

# Emit contract lines from files and description text.
# Args: $1 = comma-separated file paths, $2 = "What to implement" text
# Output: lines of "<file>:<function>(modified)" to stdout
emit_contracts() {
  local files_str="$1"
  local what_str="$2"

  if [[ -z "$files_str" || -z "$what_str" ]]; then
    return
  fi

  # Extract word() patterns from the what section
  local funcs
  funcs="$(printf '%s' "$what_str" | grep -oE '[a-zA-Z_][a-zA-Z0-9_]*\(\)' || true)"

  if [[ -z "$funcs" ]]; then
    return
  fi

  # Parse comma-separated file paths, strip backticks and whitespace
  local IFS=','
  local file_list
  read -ra file_list <<< "$files_str"

  local fp fn
  for fp in "${file_list[@]}"; do
    # Strip leading/trailing whitespace and backticks
    fp="$(printf '%s' "$fp" | sed 's/^[[:space:]`]*//;s/[[:space:]`]*$//')"
    [[ -z "$fp" ]] && continue

    while IFS= read -r fn; do
      [[ -z "$fn" ]] && continue
      # Strip the trailing () from the function name
      fn="${fn%()}"
      printf '%s\n' "${fp}:${fn}(modified)"
    done <<< "$funcs"
  done
}

# ── Subcommands ──────────────────────────────────────────────────────────

cmd_find_consumers() {
  if [[ $# -lt 1 || -z "$1" ]]; then
    echo "Usage: dep-guard.sh find-consumers <function-or-pattern>" >&2
    exit 1
  fi

  local pattern
  pattern="$(sanitize "$1")"

  # Build list of directories that actually exist
  local dirs=()
  for d in lib/ scripts/ bin/ .claude/commands/ .forge/hooks/; do
    [[ -d "$d" ]] && dirs+=("$d")
  done

  if [[ ${#dirs[@]} -eq 0 ]]; then
    echo "No consumers found"
    return 0
  fi

  # Grep across key directories, excluding noise
  local results
  results="$(grep -rn -e "$pattern" \
    --include='*.js' --include='*.sh' --include='*.md' --include='*.ts' --include='*.json' \
    --exclude-dir=node_modules --exclude-dir=.worktrees --exclude-dir=test --exclude-dir=test-env \
    --exclude='dep-guard.sh' \
    "${dirs[@]}" 2>/dev/null || true)"

  if [[ -z "$results" ]]; then
    echo "No consumers found"
    return 0
  fi

  echo "$results"
  return 0
}

cmd_check_ripple() {
  if [[ $# -lt 1 || -z "$1" ]]; then
    echo "Usage: dep-guard.sh check-ripple <issue-id>" >&2
    exit 1
  fi

  local issue_id
  issue_id="$(sanitize "$1")"

  # ── Step 1: Validate issue exists ──────────────────────────────────────
  local src_json
  src_json="$(bd_show_json "$issue_id")"

  # ── Step 2: Extract source title ───────────────────────────────────────
  local src_title=""
  if command -v jq &>/dev/null; then
    src_title="$(printf '%s' "$src_json" | jq -r '.title // ""' 2>/dev/null)" || true
  fi
  # Fallback: grep for title in JSON
  if [[ -z "$src_title" ]]; then
    src_title="$(printf '%s' "$src_json" | grep -oE '"title"[[:space:]]*:[[:space:]]*"[^"]*"' | head -1 | sed 's/^"title"[[:space:]]*:[[:space:]]*"//;s/"$//')" || true
  fi

  if [[ -z "$src_title" ]]; then
    echo "⚠️  Warning: could not extract title for ${issue_id} — ripple check skipped" >&2
    return 0
  fi

  echo ""
  printf '%s\n' "📋 Ripple check for ${issue_id}..."
  echo ""

  # ── Step 3: Collect active issues ──────────────────────────────────────
  # Run bd list for open and in_progress separately, combine results
  local list_output=""
  local open_list=""
  local ip_list=""
  open_list="$(${BD_CMD:-bd} list --status=open 2>/dev/null)" || true
  ip_list="$(${BD_CMD:-bd} list --status=in_progress 2>/dev/null)" || true

  # Combine and deduplicate (in case bd list returns overlapping results)
  local combined=""
  if [[ -n "$open_list" && -n "$ip_list" ]]; then
    combined="${open_list}"$'\n'"${ip_list}"
  elif [[ -n "$open_list" ]]; then
    combined="$open_list"
  elif [[ -n "$ip_list" ]]; then
    combined="$ip_list"
  fi

  # Deduplicate by unique lines (preserves order via awk)
  if [[ -n "$combined" ]]; then
    list_output="$(printf '%s\n' "$combined" | awk '!seen[$0]++')"
  fi

  if [[ -z "$list_output" ]]; then
    echo "⚠️  Warning: could not fetch active issue list — ripple check skipped" >&2
    return 0
  fi

  # ── Step 4: Parse each active issue (excluding source) ─────────────────
  # Format: ○ forge-xxx [● P2] [feature] - Title of the issue
  #         ◐ forge-yyy [● P1] [task] - Another issue title
  local overlap_count=0
  local overlap_report=""

  # Stop words to exclude from keyword matching
  local stop_words=" the a an and or is in to for of with on at by from add fix update implement create remove delete make use get set run test check all this that it be as not no but if do we they are was were been have has had will would could should may can each every both also into than then when where which what how why who its new first last same other "

  # Tokenize source title: lowercase, split on non-alpha, filter stop words + short terms
  local src_terms=""
  src_terms="$(printf '%s' "$src_title" | tr '[:upper:]' '[:lower:]' | tr -cs '[:alpha:]' '\n' | sort -u)"

  # Filter source terms
  local filtered_src_terms=""
  while IFS= read -r term; do
    [[ -z "$term" ]] && continue
    # Skip terms < 3 characters
    [[ ${#term} -lt 3 ]] && continue
    # Skip stop words
    if [[ "$stop_words" == *" ${term} "* ]]; then
      continue
    fi
    filtered_src_terms="${filtered_src_terms} ${term}"
  done <<< "$src_terms"

  # Process each line in list_output
  while IFS= read -r line; do
    [[ -z "$line" ]] && continue

    # Extract issue ID (forge-xxx pattern)
    local cand_id=""
    cand_id="$(printf '%s' "$line" | grep -oE 'forge-[a-z0-9]+' | head -1)" || continue
    [[ -z "$cand_id" ]] && continue

    # Skip the source issue itself
    [[ "$cand_id" == "$issue_id" ]] && continue

    # Extract status symbol and map to label
    local cand_status="open"
    if printf '%s' "$line" | grep -q '◐'; then
      cand_status="in_progress"
    fi

    # Extract priority (P1, P2, P3, etc.)
    local cand_priority=""
    cand_priority="$(printf '%s' "$line" | grep -oE 'P[0-9]+' | head -1)" || true
    [[ -z "$cand_priority" ]] && cand_priority="P2"

    # Extract title (everything after " - ")
    local cand_title=""
    cand_title="$(printf '%s' "$line" | sed 's/^.*] - //')" || continue
    [[ -z "$cand_title" ]] && continue

    # Tokenize candidate title
    local cand_terms=""
    cand_terms="$(printf '%s' "$cand_title" | tr '[:upper:]' '[:lower:]' | tr -cs '[:alpha:]' '\n' | sort -u)"

    # Filter candidate terms
    local filtered_cand_terms=""
    while IFS= read -r term; do
      [[ -z "$term" ]] && continue
      [[ ${#term} -lt 3 ]] && continue
      if [[ "$stop_words" == *" ${term} "* ]]; then
        continue
      fi
      filtered_cand_terms="${filtered_cand_terms} ${term}"
    done <<< "$cand_terms"

    # ── Step 6: Find shared meaningful terms ───────────────────────────────
    local shared_terms=""
    local shared_count=0
    for src_t in $filtered_src_terms; do
      for cand_t in $filtered_cand_terms; do
        if [[ "$src_t" == "$cand_t" ]]; then
          if [[ -z "$shared_terms" ]]; then
            shared_terms="\"${src_t}\""
          else
            shared_terms="${shared_terms}, \"${src_t}\""
          fi
          shared_count=$((shared_count + 1))
          break
        fi
      done
    done

    # ── Step 7: Report if >= 2 shared terms ────────────────────────────────
    if [[ $shared_count -ge 2 ]]; then
      overlap_count=$((overlap_count + 1))
      overlap_report="${overlap_report}  ${cand_id} (${cand_status}, ${cand_priority}): \"${cand_title}\""$'\n'
      overlap_report="${overlap_report}  Overlap: keyword match — ${shared_terms}"$'\n'
      overlap_report="${overlap_report}  Confidence: LOW (keyword only, no contract data)"$'\n'
      overlap_report="${overlap_report}"$'\n'
      overlap_report="${overlap_report}  Options:"$'\n'
      overlap_report="${overlap_report}  (a) Add dependency: bd dep add ${issue_id} ${cand_id}"$'\n'
      overlap_report="${overlap_report}  (b) Proceed — no real conflict"$'\n'
      overlap_report="${overlap_report}  (c) Investigate: bd show ${cand_id}"$'\n'
      overlap_report="${overlap_report}"$'\n'
    fi

  done <<< "$list_output"

  # ── Step 8: Output final report ──────────────────────────────────────
  if [[ $overlap_count -gt 0 ]]; then
    printf '%s\n' "⚠️  Potential overlap with ${overlap_count} issue(s):"
    echo ""
    printf '%s' "$overlap_report"
  else
    printf '%s\n' "✅ No conflicts detected"
  fi

  return 0
}

cmd_store_contracts() {
  if [[ $# -lt 2 ]]; then
    echo "Usage: dep-guard.sh store-contracts <issue-id> <contracts-string>" >&2
    exit 1
  fi

  local issue_id
  issue_id="$(sanitize "$1")"
  local contracts="$2"

  if [[ -z "$contracts" ]]; then
    die "Contracts string cannot be empty"
  fi

  contracts="$(sanitize "$contracts")"

  # Validate issue exists
  bd_show_json "$issue_id" > /dev/null

  # Store contracts metadata with timestamp for deduplication.
  # bd only supports --append-notes (no replace), so we prefix with a timestamp.
  # Consumers (check-ripple) should use the LATEST contracts: line and ignore older ones.
  local ts
  ts="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  if ! bd_update "$issue_id" --append-notes "contracts@${ts}: ${contracts}" > /dev/null; then
    die "Failed to store contracts on issue ${issue_id}"
  fi

  echo "Contracts stored on ${issue_id} (${ts})"
}

cmd_extract_contracts() {
  if [[ $# -lt 1 ]]; then
    echo "Usage: dep-guard.sh extract-contracts <file-path>" >&2
    exit 1
  fi

  local task_file="$1"

  # Validate file exists
  if [[ ! -f "$task_file" ]]; then
    die "File does not exist: ${task_file}"
  fi

  # Check that file contains at least one ## Task header
  if ! grep -q '^## Task' "$task_file"; then
    die "No tasks found in ${task_file}"
  fi

  # Parse task blocks using line-by-line bash processing.
  # For each task: collect File(s) paths and function names from "What to implement".
  local current_files=""
  local current_what=""
  local in_what=0
  local all_contracts=""

  while IFS= read -r line || [[ -n "$line" ]]; do
    # New task block — flush previous
    if [[ "$line" =~ ^##\ Task ]]; then
      local _emitted
      _emitted="$(emit_contracts "$current_files" "$current_what")"
      [[ -n "$_emitted" ]] && all_contracts="${all_contracts}${_emitted}"$'\n'
      current_files=""
      current_what=""
      in_what=0
      continue
    fi

    # File(s): line
    if [[ "$line" =~ ^File\(s\): ]]; then
      current_files="${line#File(s):}"
      current_files="$(printf '%s' "$current_files" | sed 's/^[[:space:]]*//')"
      in_what=0
      continue
    fi

    # What to implement: line
    if [[ "$line" =~ ^What\ to\ implement: ]]; then
      current_what="${line#What to implement:}"
      current_what="$(printf '%s' "$current_what" | sed 's/^[[:space:]]*//')"
      in_what=1
      continue
    fi

    # Continue what section (stop at section boundaries)
    if [[ $in_what -eq 1 ]]; then
      if [[ "$line" =~ ^(##\ Task|File\(s\):|What\ to\ implement:|TDD\ |Expected\ output|---) ]]; then
        in_what=0
        continue
      fi
      current_what="${current_what} ${line}"
      continue
    fi
  done < "$task_file"

  # Flush the last task block
  local _emitted
  _emitted="$(emit_contracts "$current_files" "$current_what")"
  [[ -n "$_emitted" ]] && all_contracts="${all_contracts}${_emitted}"$'\n'

  # Deduplicate and sort
  local contracts
  contracts="$(printf '%s' "$all_contracts" | grep -v '^$' | sort -u)"

  if [[ -z "$contracts" ]]; then
    echo "No contracts found" >&2
    exit 1
  fi

  printf '%s\n' "$contracts"
}

# ── Main dispatcher ──────────────────────────────────────────────────────

if [[ $# -lt 1 ]]; then
  usage
fi

subcommand="$1"
shift

case "$subcommand" in
  find-consumers)     cmd_find_consumers "$@" ;;
  check-ripple)       cmd_check_ripple "$@" ;;
  store-contracts)    cmd_store_contracts "$@" ;;
  extract-contracts)  cmd_extract_contracts "$@" ;;
  *)
    echo "Error: Unknown subcommand '${subcommand}'" >&2
    usage
    ;;
esac
