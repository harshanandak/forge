# Decisions log

## Decision 1 — Keep markdown-it; fix its transitive linkify-it

**Date**: 2026-07-31
**Task**: Task 1 — Resolve fixed-compatible dependency versions
**Gap**: `markdown-it` is declared by `@forge/skills` but has no current source import; removing it would alter the published dependency surface even though it is not runtime-reachable by Forge's own code.
**Score**: 1/14 (touches dependency surface only; no public source signature, persistent data, or source behavior change)
**Route**: PROCEED
**Choice made**: Retain `markdown-it` and update within 14.x, while forcing its `linkify-it` dependency to a fixed 5.x release. This preserves the declaration and avoids an unnecessary major or source/API change.
**Status**: RESOLVED

## Decision 2 — Upgrade js-yaml within the existing major

**Date**: 2026-07-31
**Task**: Task 1 — Resolve fixed-compatible dependency versions
**Gap**: The reachable `js-yaml` dependency is on 5.1.0 and has high/moderate advisories; the required fixed resolution must be selected without changing the YAML API or safe-schema call sites.
**Score**: 2/14 (security-relevant dependency path; no source/API or schema changes)
**Route**: PROCEED
**Choice made**: Use `^5.2.2`, a same-major update beyond the listed vulnerable ranges, and retain the existing `yaml.JSON_SCHEMA` call sites unchanged.
**Status**: RESOLVED

## Decision 3 — Raise existing transitive overrides to first fixed compatible releases

**Date**: 2026-07-31
**Task**: Task 1 — Resolve fixed-compatible dependency versions
**Gap**: Existing overrides already pin `brace-expansion` and `fast-uri`, but their pinned versions remain inside current high advisory ranges.
**Score**: 1/14 (dependency-only; no source/API or persistent-data change)
**Route**: PROCEED
**Choice made**: Raise `brace-expansion` to 5.0.9 and `fast-uri` to the 3.1.4+ fixed line, avoiding unnecessary major upgrades and preserving the existing override strategy.
**Status**: RESOLVED

## Baseline and residual risk

Baseline evidence: fresh `bun audit --json` exited 1 with 14 advisories: 8 high, 5 moderate, 1 low, across `@babel/core`, `brace-expansion`, `fast-uri`, `js-yaml`, `linkify-it`, `markdown-it`, and `qs`.

Post-change evidence: fresh audit still exits 1, but reports zero critical, zero high, one moderate, and one low advisory. The low `@babel/core` finding and moderate `qs` finding are both reachable only through the root development dependency `@stryker-mutator/core`; neither is part of Forge's runtime or the published `@forge/skills` package path. They remain documented rather than forcing unrelated Stryker/Babel/typed-rest-client changes. The release requirement—zero high/critical advisories—is satisfied.

## Decision 4 — Do not override cosmiconfig across the js-yaml major boundary

**Date**: 2026-07-31
**Task**: Spec-review correction
**Gap**: A root-wide `js-yaml: ^5.2.2` override also forced `cosmiconfig@9.0.1`, which declares `js-yaml: ^4.1.0`, onto an incompatible major.
**Score**: 6/14 (security dependency path plus cross-major compatibility risk)
**Route**: SPEC-REVIEWER
**Choice made**: Remove the global override. Keep Forge's direct and `@forge/skills` dependencies on fixed `5.2.2`, while allowing `cosmiconfig` to resolve the semver-compatible fixed `4.3.0`. Fresh audit remains zero high/critical.
**Status**: RESOLVED
