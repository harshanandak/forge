# Design: Quality Gate Honesty + CI Path Filter Gaps

- **Feature**: quality-gates
- **Date**: 2026-03-20
- **Status**: approved
- **Beads**: forge-mr0l, forge-ypeh (combined PR)

## Purpose

The local quality gate (validate.sh) misleads developers by reporting "Type check passed" when no type checking occurs. CI workflows have path filter gaps that cause unnecessary runs on docs-only PRs and miss runs on workspace package changes.

## Success Criteria

1. `validate.sh` step 1 prints "SKIPPED (no TypeScript)" instead of "passed"
2. `test.yml` triggers on `packages/**` changes
3. `eslint.yml` has path filters scoped to JS/config files, weekly schedule removed
4. `codeql.yml` has code-only path filters on push/PR, weekly schedule retained
5. `size-check.yml` has package-relevant path filters
6. `dependency-review.yml` scoped to `package.json`
7. `yaml-lint.yml` uses `setup-bun@v2`
8. All existing CI tests still pass

## Out of Scope

- Adding real TypeScript type checking (no TS in project yet)
- Creating a cross-platform `validate.js` Node script (future work)
- Documenting local gate in CONTRIBUTING (separate issue)
- Modifying lefthook.yml or pre-push hooks
- Changing mutation testing schedule or config

## Approach Selected

Direct edits to validate.sh and 6 workflow YAML files. No new files created. Minimal, targeted changes per file.

### validate.sh
- Change step 1 from `bun run typecheck` (which is just an echo) to an honest skip message using `print_warning`
- Keep the 4-step numbering so the slot is ready when TypeScript is added

### test.yml
- Add `packages/**` to both push and pull_request path filters

### eslint.yml
- Add path filters: `bin/**`, `lib/**`, `scripts/**`, `test/**`, `packages/**`, `package.json`, `.github/workflows/**`, `*.js` (root config files), `.claude/**/*.js`
- Remove weekly `schedule` trigger (redundant — runs on every PR already)

### codeql.yml
- Add path filters on push/PR: `bin/**`, `lib/**`, `scripts/**`, `packages/**`, `.github/workflows/**`
- Keep weekly schedule for full security scans

### size-check.yml
- Add path filters: `package.json`, `bin/**`, `lib/**`, `packages/**`

### dependency-review.yml
- Add path filter: `package.json`

### yaml-lint.yml
- Bump `setup-bun@v1` to `@v2`

## Constraints

- No new files — edits only
- Path filters must be additive (never remove existing valid paths)
- Weekly CodeQL schedule must be preserved
- All changes must be valid YAML

## Edge Cases

- **Root-level JS files** (e.g., `eslint.config.js`): included in eslint.yml path filters via `*.js` glob
- **`.claude/**/*.js` scripts**: included in eslint.yml paths since ESLint scans them
- **Workflow file changes**: already in test.yml paths (`.github/workflows/**`), added to eslint/codeql too

## Ambiguity Policy

Use rubric scoring against success criteria. If an unexpected issue scores below 70% alignment with success criteria, pause and ask the user. Otherwise, make a conservative fix and document in the commit.

## Technical Research

### OWASP Top 10 Analysis

This PR touches CI config and a local shell script — minimal attack surface:
- **A05:2021 Security Misconfiguration**: Path filters could accidentally exclude security-relevant paths. Mitigation: CodeQL keeps weekly full scan; path filters are additive only.
- **A08:2021 Software and Data Integrity**: CI workflow changes could weaken the quality gate. Mitigation: no checks are removed, only triggers are refined.
- Other OWASP categories not applicable (no user input, no auth, no data handling).

### TDD Test Scenarios

1. **Happy path**: validate.sh runs, step 1 prints skip warning, steps 2-4 execute normally
2. **CI trigger test**: PR touching only `packages/skills/index.js` triggers test.yml (currently doesn't)
3. **CI skip test**: PR touching only `docs/README.md` does NOT trigger eslint.yml (currently does)
4. **YAML validity**: All modified workflow files parse as valid YAML
5. **Path filter completeness**: Every `.js` file in the repo is covered by at least one CI workflow's path filter

### DRY Check

No new code or abstractions being created — all changes are edits to existing files. DRY gate cleared.

### Blast Radius

Changes touch:
- `scripts/validate.sh` (local dev only)
- 6 workflow files in `.github/workflows/` (CI only)
- No runtime code, no dependencies, no exports
