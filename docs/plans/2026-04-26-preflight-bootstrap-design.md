# Preflight Bootstrap Script Design

**Feature:** preflight-bootstrap
**Issue:** forge-byvq (local Beads issue; run `bd show forge-byvq`)
**Date:** 2026-04-26
**Status:** Planned

## Purpose

Create a first-run bootstrap check for developers before `/status` so missing CLIs, GitHub auth, and Beads schema/setup problems fail with actionable output instead of surfacing later in Forge workflow commands.

## Success criteria

- `scripts/preflight.sh` checks `bd`, `jq`, and `gh` availability.
- Missing tools produce Windows install hints and exit code 2.
- `gh auth status` is checked and unauthenticated sessions exit code 2 with `gh auth login` guidance.
- Beads schema repair runs through `bd doctor --fix --yes`.
- If Beads is not initialized, the script runs `bd init --database forge --prefix forge`.
- Exit codes are stable: 0 means all good, 1 means fixable issues were repaired during the run, 2 means manual action is needed.
- `test/scripts/preflight.test.js` covers happy path, fixable repair/init path, and manual-action failures.

## Out of scope

- Installing tools automatically.
- Starting or managing a Dolt server.
- Changing `/status`, `forge status`, or Beads core behavior.
- Replacing the existing smart-status recovery flow.

## Approach selected

Use a Bash script in `scripts/preflight.sh` because this repo already keeps workflow bootstrap and validation scripts under `scripts/*.sh`. The script will keep command execution simple and mockable:

- `command -v` for tool availability.
- `gh auth status` for GitHub login state.
- `bd show --json forge-byvq` as a low-impact initialization probe.
- `bd init --database forge --prefix forge` only when the probe fails.
- `bd doctor --fix --yes` for schema health after initialization is available.
- A small status accumulator where repaired Beads state sets exit code 1 unless a manual-action failure sets exit code 2.

Rejected alternatives:

- Node script: easier unit injection, but this request explicitly asks for `scripts/preflight.sh`.
- Silent best-effort repairs: rejected because the exit code contract must tell callers whether the run changed local state.

## Output format

The script prints one line per check:

- `OK <check> - <detail>` for passing checks.
- `FIXED <check> - <detail>` for repairs that ran successfully.
- `ACTION <check> - <detail>` for manual-action blockers.

Install hints are printed directly under missing-tool lines and remain Windows-focused:

- `winget install GitHub.cli`
- `winget install jqlang.jq`
- `bd`: install Forge/Beads tooling, then rerun `bunx forge setup --quick`.

## Constraints

- Must be runnable from a worktree.
- Must not assume interactive input.
- Must avoid destructive Beads operations.
- Must keep output deterministic enough for tests.

## Edge cases

- Missing `bd`: skip Beads probes and doctor because manual installation is required.
- Missing `gh`: skip auth status because auth cannot be checked.
- `gh auth status` non-zero: exit 2 and print `gh auth login`.
- `bd init` succeeds: mark the run fixable with exit 1.
- `bd doctor --fix --yes` succeeds: mark the run fixable with exit 1, because the script may have repaired schema state.
- `bd doctor --fix --yes` fails: exit 2.

## Ambiguity policy

Use the `/dev` 7-dimension decision gate. Proceed without asking only for score 0-3, document the choice in the decisions log, and stop for developer input on score 8+ or any security/schema/public API override.

## Technical Research

Codebase checks performed:

- Existing shell workflow scripts live in `scripts/`, including `smart-status.sh`, `validate.sh`, and Beads helper scripts.
- Existing script tests under `test/scripts/` use `bun:test`, temporary mock command directories, and Bash execution.
- Existing issue data for `forge-byvq` describes the requested preflight checks and the same target files.

OWASP analysis:

- A05 Security Misconfiguration applies: missing tools or broken Beads setup can cause users to bypass workflow checks. Mitigation: fail closed with explicit manual-action output.
- A07 Identification and Authentication Failures applies to GitHub CLI auth. Mitigation: check `gh auth status` before workflow commands need GitHub access.
- A09 Security Logging and Monitoring does not require new logging because this is a local preflight script with deterministic console output.

TDD scenarios:

- Happy path: all tools available, GitHub auth succeeds, Beads initialized, doctor succeeds, exit 0.
- Fixable path: Beads is uninitialized, `bd init --database forge --prefix forge` runs, doctor succeeds, exit 1.
- Manual path: missing `gh` or failed `gh auth status` prints Windows/login hints and exits 2.
