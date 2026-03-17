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
    json="$(printf '%s' "$json" | jq 'if type == "array" then .[0] else . end' 2>/dev/null)" || true
  fi

  printf '%s' "$json"
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
  results="$(grep -rn "$pattern" \
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

  local issue_id="$1"
  local contracts="$2"

  if [[ -z "$contracts" ]]; then
    die "Contracts string cannot be empty"
  fi

  contracts="$(sanitize "$contracts")"

  # Validate issue exists
  bd_show_json "$issue_id" > /dev/null

  # Store contracts metadata
  if ! bd_update "$issue_id" --append-notes "contracts: ${contracts}" > /dev/null; then
    die "Failed to store contracts on issue ${issue_id}"
  fi

  echo "Contracts stored on ${issue_id}"
}

cmd_extract_contracts() {
  if [[ $# -lt 1 ]]; then
    echo "Usage: dep-guard.sh extract-contracts <file-path>" >&2
    exit 1
  fi

  echo "Not implemented: extract-contracts" >&2
  exit 1
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
