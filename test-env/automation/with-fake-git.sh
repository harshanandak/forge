#!/usr/bin/env bash
# Usage: bash with-fake-git.sh <fake-git-dir> <script> [args...]
#
# Runs <script> under bash with <fake-git-dir> first on PATH. Used by
# setup-fixtures-marker.test.js. It exists because Git for Windows' bash.exe
# wrapper prepends its own bin dirs to PATH, so a PATH set by the caller loses
# to the real git; the fake git has to be prepended inside bash, right before
# exec'ing the script. A committed script (not `bash -c <string>`) means no
# command text is ever built at runtime.

dir="$1"
shift
if command -v cygpath > /dev/null 2>&1; then dir="$(cygpath -u "$dir")"; fi
PATH="$dir:$PATH"
export PATH
exec bash "$@"
