# Security dependency remediation

- **Issue**: `f061a532-65f4-4168-922a-f64da1e32424`
- **Date**: 2026-07-31
- **Classification**: Critical / security
- **Base**: `72a7db07fbed4f0cbd17b008540fb713fcb8015a`
- **Status**: In progress

## Purpose

Resolve the current Bun audit high/critical advisories before 0.1.0 without changing Forge runtime source APIs or broadening the lane beyond dependency metadata, the root lockfile, and unique audit evidence.

## Baseline evidence

A fresh `bun audit --json` on the base exited 1 and reported 14 advisories across seven package keys: 8 high, 5 moderate, and 1 low. High findings were attached to `brace-expansion`, `fast-uri`, `js-yaml`, and `linkify-it`; the `markdown-it` finding was moderate.

## Runtime and distribution triage

- `@forge/skills` imports `js-yaml` from `src/commands/validate.js` and `src/commands/publish.js`; this is a reachable runtime dependency and must remain available.
- `@forge/skills` declares `markdown-it`, but no shipped source file imports or references it. It is nevertheless retained to avoid changing the package's declared distribution surface; update it within 14.x instead of removing it.
- `linkify-it` is pulled by `markdown-it` (`^5.0.0`) and is not directly imported by Forge source. A root override to the fixed 5.x line preserves the dependency contract while removing the high advisory.
- `brace-expansion` and `fast-uri` are transitive development/tooling paths already constrained by root overrides. Raise only to the first fixed versions identified by the advisory ranges, avoiding major upgrades.

## Selected approach

1. Update `js-yaml` in the root and `@forge/skills` manifests from `^5.1.0` to `^5.2.2` (same major; 5.2.2 is beyond all listed vulnerable ranges).
2. Update `markdown-it` in `@forge/skills` from `^14.1.1` to `^14.1.2` (same major) and add a root `linkify-it` override at `^5.0.2` (same major; beyond both listed vulnerable ranges).
3. Raise root overrides to `brace-expansion: 5.0.9` and `fast-uri: ^3.1.4` (same major; beyond the listed vulnerable ranges).
4. Regenerate only the root `bun.lock` with Bun's lockfile-only install/update path.

## Success criteria

- Fresh `bun audit --json` reports zero high and zero critical advisories. Bun may still exit 1 for explicitly documented moderate/low findings.
- `bun pm why` confirms expected runtime reachability and fixed resolved versions for `js-yaml`, `markdown-it`, and `linkify-it`.
- `packages/skills` focused tests, root package checks, manifest/lockfile consistency, and required lint/build/type checks pass.
- No source/API changes, unnecessary major upgrades, push, PR, merge, or issue close.

## Out of scope

No edits to shared source files, `CHANGELOG.md`, `README.md`, `AGENTS.md`, protected Forge runtime files, other worktrees, or package-specific lockfiles. Residual moderate/low advisories are documented rather than addressed by unrelated upgrades unless a compatible lockfile resolution removes them incidentally.

## Ambiguity policy

Dependency-only scope is explicit. If zero high/critical requires a major version or source/API change outside the owned files, stop and record the decision gap rather than broadening scope. Reviewers must independently verify runtime reachability, package-distribution compatibility, and audit evidence.
