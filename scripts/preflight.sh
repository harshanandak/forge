#!/usr/bin/env bash
set -u

exit_code=0
have_bd=0
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

snapshot_hooks_dir() {
  hooks_dir="$1"
  hooks_snapshot_dir="$(mktemp -d 2>/dev/null || mktemp -d -t forge-preflight-hooks)"

  if [ -d "$hooks_dir" ]; then
    cp -pR "$hooks_dir"/. "$hooks_snapshot_dir"/
  fi
}

restore_hooks_dir() {
  hooks_dir="$1"
  mkdir -p "$hooks_dir"

  find "$hooks_dir" -mindepth 1 -maxdepth 1 -exec rm -rf {} +

  if [ -d "$hooks_snapshot_dir" ]; then
    cp -pR "$hooks_snapshot_dir"/. "$hooks_dir"/
    rm -rf "$hooks_snapshot_dir"
  fi
}

write_beads_config() {
  mkdir -p .beads
  {
    printf '%s\n' 'issue-prefix: forge'
    printf '\n'
    printf '%s\n' 'database:'
    printf '%s\n' '  backend: dolt'
    printf '\n'
  } > .beads/config.yaml
}

write_beads_gitignore() {
  mkdir -p .beads
  {
    printf '%s\n' '# Dolt database files (binary, not suitable for git)'
    printf '%s\n' 'dolt/'
    printf '%s\n' '*.db'
    printf '%s\n' '*.lock'
    printf '\n'
  } > .beads/.gitignore
}

safe_bd_init() {
  hooks_dir="$(git rev-parse --git-path hooks 2>/dev/null || printf '.git/hooks')"
  write_beads_config
  write_beads_gitignore
  snapshot_hooks_dir "$hooks_dir"

  bd init --database forge --prefix forge >/dev/null 2>&1
  init_status=$?

  restore_hooks_dir "$hooks_dir"
  return "$init_status"
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
  if check_tool "bd" "install Forge/Beads tooling, then rerun: bunx forge setup --quick"; then
    have_bd=1
  fi

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

check_beads() {
  if [ "$have_bd" -ne 1 ]; then
    return 0
  fi

  init_ok=0
  if bd list --json --limit 1 >/dev/null 2>&1; then
    ok "beads-init" "Beads database is readable"
    init_ok=1
  else
    if safe_bd_init; then
      fixed "beads-init" "ran hook-preserving bd init --database forge --prefix forge"
      init_ok=1
    else
      action "beads-init" "bd init failed; inspect Beads setup manually"
    fi
  fi

  if [ "$init_ok" -ne 1 ]; then
    return 0
  fi

  doctor_output="$(bd doctor --fix --yes 2>&1)"
  doctor_status=$?
  if [ "$doctor_status" -eq 0 ]; then
    doctor_output_lower="$(printf '%s' "$doctor_output" | tr '[:upper:]' '[:lower:]')"
    if [ "$exit_code" -eq 1 ] ||
      [[ "$doctor_output_lower" == *fix* ]] ||
      [[ "$doctor_output_lower" == *repair* ]] ||
      [[ "$doctor_output_lower" == *migrat* ]] ||
      [[ "$doctor_output_lower" == *updat* ]]; then
      fixed "beads-doctor" "ran bd doctor --fix --yes after Beads repair"
    else
      ok "beads-doctor" "bd doctor --fix --yes succeeded"
    fi
  else
    action "beads-doctor" "bd doctor --fix --yes failed; inspect Beads manually"
  fi
}

main() {
  check_tools
  check_github_auth
  check_beads
  exit "$exit_code"
}

main "$@"
