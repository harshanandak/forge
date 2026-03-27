# agent-prompt.sh — Shared library for structured agent communication
# All user-facing output from `forge team` goes through these helpers.
# Uses non-guessable prefix to prevent injection from GitHub data.
#
# Usage: source this file from other scripts.
# This library does NOT set errexit/pipefail.

readonly FORGE_AGENT_PREFIX="FORGE_AGENT_7f3a"

# Output a prompt for the AI agent to ask the user.
# Format: FORGE_AGENT_7f3a:PROMPT: <message> (to stderr)
agent_prompt() {
  echo "${FORGE_AGENT_PREFIX}:PROMPT: $1" >&2
}

# Informational output.
# Format: FORGE_AGENT_7f3a:INFO: <message> (to stderr)
agent_info() {
  echo "${FORGE_AGENT_PREFIX}:INFO: $1" >&2
}

# Error output.
# Format: FORGE_AGENT_7f3a:ERROR: <message> (to stderr)
agent_error() {
  echo "${FORGE_AGENT_PREFIX}:ERROR: $1" >&2
}

# Strip any occurrence of the FORGE_AGENT_7f3a: prefix from input strings.
# Prevents injection from GitHub issue titles or other external data.
# Takes input via stdin or as $1 arg, outputs sanitized text to stdout.
sanitize_for_agent() {
  local input
  if [[ $# -gt 0 ]]; then
    input="$1"
  else
    input="$(cat)"
  fi
  printf '%s\n' "${input//${FORGE_AGENT_PREFIX}:/}"
}
