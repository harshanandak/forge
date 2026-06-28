#!/usr/bin/env bash
set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [ -f "$SCRIPT_DIR/bootstrap-windows-tools.sh" ]; then
  source "$SCRIPT_DIR/bootstrap-windows-tools.sh"
fi

FORGE_CLI="$SCRIPT_DIR/../bin/forge.js"

exit_code=0
have_gh=0

ok() {
  printf 'OK %s - %s\n' "$1" "$2"
}

fixed() {
  printf 'FIXED %s - %s\n' "$1" "$2"
  if [ "$exit_code" -lt 1 ]; then
    exit_code=1
  fi
}

action() {
  printf 'ACTION %s - %s\n' "$1" "$2"
  exit_code=2
}

is_windows_shell() {
  case "$(uname -s 2>/dev/null || printf unknown)" in
    MINGW*|MSYS*|CYGWIN*)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

check_tool() {
  tool="$1"
  hint="$2"

  if command -v "$tool" >/dev/null 2>&1; then
    ok "tool $tool" "found $(command -v "$tool")"
    return 0
  fi

  action "tool $tool" "missing"
  if is_windows_shell; then
    printf '  Windows hint: %s\n' "$hint"
  else
    printf '  Install hint: %s\n' "$hint"
  fi
  return 1
}

check_tools() {
  check_tool "node" "install Node.js (https://nodejs.org)" || true
  check_tool "jq" "winget install jqlang.jq" || true

  if check_tool "gh" "winget install GitHub.cli"; then
    have_gh=1
  fi
}

check_github_auth() {
  if [ "$have_gh" -ne 1 ]; then
    return 0
  fi

  if gh auth status >/dev/null 2>&1; then
    ok "github-auth" "gh auth status succeeded"
    return 0
  fi

  action "github-auth" "not logged in; run: gh auth login"
}

# Validate the Forge Kernel issue store. The kernel DB is a single-machine
# SQLite store in the git common dir; any kernel issue command auto-migrates it
# via broker.initialize(), so the ensure step is just a kernel read. `forge
# doctor` then reports the filesystem class of that DB path (D19) — it only
# reports, it does not init, which is why the ensure step runs first.
check_kernel() {
  if node "$FORGE_CLI" issue list --json >/dev/null 2>&1; then
    ok "kernel-init" "Kernel issue store is readable"
  else
    action "kernel-init" "kernel issue store not initializable; inspect: node bin/forge.js doctor"
    return 0
  fi

  if node "$FORGE_CLI" doctor >/dev/null 2>&1; then
    ok "kernel-doctor" "forge doctor reports a healthy filesystem for the kernel database"
  else
    action "kernel-doctor" "forge doctor reports an unhealthy filesystem; inspect the kernel database path"
  fi
}

main() {
  check_tools
  check_github_auth
  check_kernel
  exit "$exit_code"
}

main "$@"
