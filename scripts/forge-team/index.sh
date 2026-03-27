#!/usr/bin/env bash
# forge-team — Team orchestration plugin for Forge.
#
# Subcommands:
#   workload    Show team workload by developer
#   epic        Epic progress rollup
#   dashboard   Team health dashboard
#   add         Add developer to team map
#   verify      Check 1:1 Beads<>GitHub enforcement
#   sync        Manual GitHub<>Beads sync
#   claim       Claim an issue with pre-check
#   help        Show usage
#
# Exit codes: 0=success, 1=error, 2=validation error

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Source libs (graceful if missing — stubs used in early dev)
[[ -f "$SCRIPT_DIR/lib/agent-prompt.sh" ]] && source "$SCRIPT_DIR/lib/agent-prompt.sh"
[[ -f "$SCRIPT_DIR/lib/identity.sh" ]] && source "$SCRIPT_DIR/lib/identity.sh"
[[ -f "$SCRIPT_DIR/lib/workload.sh" ]] && source "$SCRIPT_DIR/lib/workload.sh"
[[ -f "$SCRIPT_DIR/lib/epic.sh" ]] && source "$SCRIPT_DIR/lib/epic.sh"
[[ -f "$SCRIPT_DIR/lib/dashboard.sh" ]] && source "$SCRIPT_DIR/lib/dashboard.sh"
[[ -f "$SCRIPT_DIR/lib/hooks.sh" ]] && source "$SCRIPT_DIR/lib/hooks.sh"
[[ -f "$SCRIPT_DIR/lib/verify.sh" ]] && source "$SCRIPT_DIR/lib/verify.sh"
[[ -f "$SCRIPT_DIR/lib/claim.sh" ]] && source "$SCRIPT_DIR/lib/claim.sh"

# Source shared forge utilities
FORGE_SCRIPTS="$(cd "$SCRIPT_DIR/.." && pwd)"
[[ -f "$FORGE_SCRIPTS/lib/sanitize.sh" ]] && source "$FORGE_SCRIPTS/lib/sanitize.sh"

# ── Stub implementations ──
# cmd_workload provided by lib/workload.sh
# cmd_epic provided by lib/epic.sh
# cmd_dashboard provided by lib/dashboard.sh
cmd_add() { auto_detect_identity "$@"; }
# cmd_verify provided by lib/verify.sh
cmd_sync() { forge_team_sync "$@"; }
cmd_claim() { forge_team_claim "$@"; }

cmd_help() {
  cat <<'EOF'
Usage: forge team <subcommand> [args...]

Subcommands:
  workload [--developer=<user>] [--me]  Show team workload
  epic <issue-id>                        Epic progress rollup
  dashboard                              Team health dashboard
  add [--github=<user>]                  Add developer to team map
  verify                                 Check 1:1 Beads<>GitHub sync
  sync                                   Manual GitHub<>Beads sync
  claim <issue-id> [--force]             Claim issue with pre-check
  help                                   Show this message
EOF
}

# ── Main dispatcher ──
main() {
  if [[ $# -lt 1 ]]; then
    cmd_help >&2
    exit 1
  fi

  local subcommand="$1"
  shift

  case "$subcommand" in
    workload)   cmd_workload "$@" ;;
    epic)       cmd_epic "$@" ;;
    dashboard)  cmd_dashboard "$@" ;;
    add)        cmd_add "$@" ;;
    verify)     cmd_verify "$@" ;;
    sync)       cmd_sync "$@" ;;
    claim)      cmd_claim "$@" ;;
    help)       cmd_help ;;
    *)
      echo "Error: unknown subcommand '$subcommand'" >&2
      cmd_help >&2
      exit 1
      ;;
  esac
}

main "$@"
