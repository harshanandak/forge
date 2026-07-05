# 0.0.16 Upgrade Safety Foundation

**Date**: 2026-05-16  
**Status**: planned  
**Branch**: `codex/0.0.16-upgrade-safety`  
**Issues**: `forge-besw.8`, `forge-besw.11`

## Purpose

Add the minimum lockfile, trust, upgrade dry-run, and self-heal foundation needed for safe 0.0.16 upgrades. The work must make extension/source integrity reviewable before upgrade planning consumes it.

## Success Criteria

- `forge add` writes a reviewable `forge.lock` entry and `.forge/log.jsonl` audit entry.
- Untrusted sources are refused by default and accepted only with `--allow-untrusted`.
- Lock entries contain integrity metadata that `forge audit verify` can re-check.
- Tampered local source content with mismatched SRI is refused by verification.
- `forge upgrade --dry-run` consumes resolved runtime config, patch intent status, and lock/trust state, then renders a non-mutating upgrade plan.
- Upgrade dry-run reports recoverable failures with a self-heal hint.
- `forge upgrade --self-heal` performs only safe, recoverable repair steps and stays idempotent.

## Out Of Scope

- Rollback snapshots, backup retention, and full restore flow.
- Marketplace allowlists and name-collision policy.
- Real package installation from npm, GitHub, gist, or HTTPS.
- Applying patch intent diffs to managed files.
- Overwriting user-managed surfaces during upgrade.

If rollback snapshots become necessary for self-heal, stop and report scope expansion instead of implementing them.

## Approach Selected

Implement a small local trust foundation rather than a full installer:

1. Add `lib/forge-lock.js` for `forge.lock` parsing/writing, source trust classification, SRI calculation, audit-log append, and verification.
2. Add registry commands:
   - `forge add <source> [--name <id>] [--allow-untrusted]`
   - `forge audit verify`
   - `forge upgrade [--dry-run] [--self-heal]`
3. Keep source resolution conservative:
   - local filesystem paths are trusted and integrity-verifiable;
   - remote/package locator strings are untrusted and require explicit opt-in;
   - unsupported remote verification remains a clear limitation in dry-run output.
4. Reuse current `options` graph lint/diff and `patch` status behavior indirectly through library functions where possible.
5. Make self-heal repair only missing safe metadata directories/files such as `.forge/` and `.forge/log.jsonl`; do not snapshot or restore.

## Constraints

- `forge-besw.8` must be usable before `forge-besw.11` implementation relies on it.
- All dry-run behavior must be report-only unless `--self-heal` is explicitly present.
- `--allow-untrusted` must never become the default.
- Audit entries must be JSONL and reviewable.
- Tests must cover trusted/untrusted sources, lockfile behavior, upgrade dry-run output, and self-heal recovery.

## Validation Plan

- Targeted tests during TDD:
  - `bun test test/forge-lock.test.js`
  - `bun test test/commands/add.test.js test/commands/audit.test.js`
  - `bun test test/commands/upgrade.test.js`
- Full validation:
  - `bun run typecheck`
  - `bun run lint`
  - `bun test`
  - `bun run check`
