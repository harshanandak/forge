# Decisions

## D1: Treat `dolt_database` As The Recovery Database Name

`.beads/metadata.json` contains both `database` and `dolt_database`; `database` describes the backend, while `dolt_database` names the Dolt database. Recovery must use `dolt_database`.

## D2: Limit `forge-ujq.2` To Existing Setup Surface

This slice may verify that `forge worktree create` runs package install for hook dependencies. It will not add global lefthook installation, nonce policy changes, or unrelated hook enforcement.

## D3: Use Shared Sourced Helper For Bash Entrypoints

Windows/WSL command discovery belongs in `scripts/bootstrap-windows-tools.sh`; scripts should source it rather than reimplementing `where.exe`/path conversion logic.
