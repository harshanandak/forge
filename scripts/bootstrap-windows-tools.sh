#!/usr/bin/env bash
# Shared Windows/WSL command bootstrap for bash entrypoints.

if [[ -n "${_FORGE_BOOTSTRAP_WINDOWS_TOOLS_LOADED:-}" ]]; then
  return 0 2>/dev/null || exit 0
fi
_FORGE_BOOTSTRAP_WINDOWS_TOOLS_LOADED=1

_forge_to_unix_path() {
  local raw="$1"
  if command -v wslpath >/dev/null 2>&1; then
    wslpath -u "$raw" 2>/dev/null && return 0
  fi
  if command -v cygpath >/dev/null 2>&1; then
    cygpath -u "$raw" 2>/dev/null && return 0
  fi
  printf '%s\n' "$raw"
}

_forge_resolve_tool() {
  local name="$1"
  local found=""

  found="$(command -v "$name" 2>/dev/null || true)"
  if [[ -n "$found" ]]; then
    printf '%s\n' "$found"
    return 0
  fi

  if command -v where.exe >/dev/null 2>&1; then
    found="$(where.exe "$name" 2>/dev/null | tr -d '\r' | head -n 1 || true)"
    if [[ -n "$found" ]]; then
      _forge_to_unix_path "$found"
      return 0
    fi
  fi

  return 1
}

if [[ -z "${BD_CMD:-}" ]]; then
  BD_CMD="$(_forge_resolve_tool bd || printf '%s\n' bd)"
  export BD_CMD
fi

if [[ -z "${JQ_CMD:-}" ]]; then
  JQ_CMD="$(_forge_resolve_tool jq || printf '%s\n' jq)"
  export JQ_CMD
fi

if [[ -z "${GH_CMD:-}" ]]; then
  GH_CMD="$(_forge_resolve_tool gh || printf '%s\n' gh)"
  export GH_CMD
fi

bd() {
  command "${BD_CMD:-bd}" "$@"
}

jq() {
  command "${JQ_CMD:-jq}" "$@"
}

gh() {
  command "${GH_CMD:-gh}" "$@"
}
