# Design: Stage Naming Consistency + COMMANDS Array Fix

**Feature**: stage-naming-commands
**Date**: 2026-03-20
**Status**: Approved
**Beads**: forge-7lvz (P1) + forge-b262 (P1) — combined PR

## Purpose

The project renamed `/check` to `/validate` and `/merge` to `/premerge`, but several files still use the old names. The COMMANDS array in `bin/forge.js` is hardcoded and stale — it doesn't match the actual `.claude/commands/*.md` files. This causes silent copy failures and misleading output counts.

## Success Criteria

1. Zero occurrences of `/check` as a stage name in shipped files
2. Zero occurrences of `/merge` as a stage name in shipped files
3. COMMANDS list derived from filesystem (`.claude/commands/*.md`), not hardcoded
4. Accurate copy/convert counts in console output
5. User-visible warning when a command source file is missing
6. All existing tests pass

## Out of Scope

- Rewriting `bin/forge.js` structure (that's forge-0ht2)
- Fixing setup code path divergence (that's forge-cpnj)
- Changing command file contents

## Approach Selected

**Filesystem-derived command list**: Replace the hardcoded `COMMANDS` array with a function that scans `.claude/commands/*.md` at runtime. This matches the acceptance criteria and prevents future staleness.

## Constraints

- Must work cross-platform (Windows, macOS, Linux)
- Must not break `npm postinstall` (which runs `minimalInstall()`)
- The package ships `.claude/commands/*.md` — so scanning the package directory works

## Edge Cases

1. **No `.claude/commands/` directory**: Fall back to empty array, warn user
2. **Non-.md files in directory**: Filter to only `*.md`
3. **Command file exists but is empty**: Copy anyway (copyFile handles this)

## Ambiguity Policy

Make conservative choice and document in commit message.

## Files to Modify

1. `bin/forge.js` — COMMANDS array (L254), CURSOR_RULE (L476, L479), hardcoded "9" counts (L1888, L1933, L2345), copyFile warning
2. `.cursorrules` — 4 stale `/check` references (L12, L21, L41, L70)

## OWASP Top 10

This feature is local CLI tooling (filesystem reads, string replacements). Risk assessment per category:

- **A01 Broken Access Control**: N/A — no auth, no access control
- **A02 Cryptographic Failures**: N/A — no crypto, no secrets
- **A03 Injection**: Low — `getWorkflowCommands()` uses `fs.readdirSync` + `path.join` with controlled directory, no user input in paths
- **A04 Insecure Design**: N/A — read-only filesystem scan, no state changes
- **A05 Security Misconfiguration**: N/A — no configuration surfaces exposed
- **A06 Vulnerable Components**: N/A — no new dependencies added
- **A07 Authentication Failures**: N/A — no authentication
- **A08 Data Integrity Failures**: N/A — no serialization, no data pipelines
- **A09 Logging & Monitoring Failures**: N/A — local CLI, no monitoring needed
- **A10 SSRF**: N/A — no network requests

## TDD Scenarios

1. **Happy path**: Command list matches `.claude/commands/*.md` files
2. **Missing directory**: Returns empty array with warning
3. **Stale name check**: No `/check` or `/merge` in CURSOR_RULE or .cursorrules
