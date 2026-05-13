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
  BD_CMD="$(_forge_resolve_tool bd || true)"
fi
if [[ -n "${BD_CMD:-}" ]]; then
  export BD_CMD
fi

if [[ -z "${JQ_CMD:-}" ]]; then
  JQ_CMD="$(_forge_resolve_tool jq || true)"
fi
if [[ -n "${JQ_CMD:-}" ]]; then
  export JQ_CMD
fi

if [[ -z "${GH_CMD:-}" ]]; then
  GH_CMD="$(_forge_resolve_tool gh || true)"
fi
if [[ -n "${GH_CMD:-}" ]]; then
  export GH_CMD
fi

if [[ -n "${BD_CMD:-}" ]]; then
  bd() {
    command "$BD_CMD" "$@"
  }
fi

if [[ -n "${JQ_CMD:-}" ]]; then
  jq() {
    command "$JQ_CMD" "$@"
  }
fi

if [[ -n "${GH_CMD:-}" ]]; then
  gh() {
    command "$GH_CMD" "$@"
  }
fi
