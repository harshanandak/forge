#!/usr/bin/env bash
# Usage: bash make-fake-git.sh <bin-dir>
#
# Copies the system `true` binary into <bin-dir> as `git` (`git.exe` on
# Windows): every call succeeds instantly and prints nothing. Used by
# setup-fixtures-marker.test.js; a native binary, not a bash script, keeps a
# whole forced fixture rebuild to a few seconds on Windows. A committed script
# (not `bash -c <string>`) means no command text is ever built at runtime.

src="$(type -P true)"; ext=""
case "$src" in *.exe) ext=".exe" ;; *) if [ -e "$src.exe" ]; then src="$src.exe"; ext=".exe"; fi ;; esac
cp "$src" "$1/git$ext"
