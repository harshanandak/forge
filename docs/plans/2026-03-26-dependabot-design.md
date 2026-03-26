# Dependabot Configuration — Design Doc

**Feature**: dependabot
**Date**: 2026-03-26
**Status**: planning
**Issue**: forge-bkgg

---

## Purpose

No automated dependency monitoring exists. Breaking changes (like beads SQLite to Dolt migration) can land undetected. Add Dependabot for npm dependency updates and GitHub Actions version pinning.

## Success Criteria

1. `.github/dependabot.yml` exists with npm and github-actions ecosystems
2. Weekly schedule (Monday 7am UTC)
3. npm updates grouped: production deps separate from dev deps
4. GitHub Actions updates grouped into single PR
5. TOOLCHAIN.md documents minimum bd version
6. PR labels auto-applied for easy filtering

## Out of Scope

- Renovate (Dependabot is simpler, native GitHub, right-sized for 2 prod + 8 dev deps)
- Auto-merge workflow
- bd version pinning in project config
- Custom Dependabot reviewers/assignees

## Approach

Dependabot with grouped updates + TOOLCHAIN.md documentation update.

- **npm ecosystem**: Weekly Monday 7am UTC. Production deps grouped separately from dev deps. Labels: `dependencies`.
- **github-actions ecosystem**: Weekly Monday 7am UTC. All actions grouped into single PR. Labels: `github-actions`, `dependencies`.

## Constraints

- Must not conflict with existing `dependency-review.yml` workflow
- Must use conventional labels (`dependencies`, `github-actions`)

## Edge Cases

1. **Dependabot PR conflicts with feature branches** — Low risk. `dependabot/` prefix avoids branch name collision with `feat/`, `fix/`, `docs/` prefixes.
2. **Major version bump** — Dependabot creates separate PR with breaking change note. Grouped updates only apply to minor/patch.
3. **Multiple grouped updates in same week** — Dependabot handles natively, creating one PR per group.

## Ambiguity Policy

7-dimension rubric scoring. >= 80% confidence: proceed and document. < 80%: stop and ask user.

---

## Technical Research

### OWASP Top 10 Analysis

| OWASP ID | Category | Relevance | Notes |
|----------|----------|-----------|-------|
| A06:2021 | Vulnerable and Outdated Components | **PRIMARY MOTIVATION** | Dependabot directly addresses this by flagging outdated deps with known CVEs. Security advisories trigger immediate PRs outside the weekly schedule. |
| A05:2021 | Security Misconfiguration | LOW | Ensure `dependabot.yml` doesn't expose internal config patterns. Mitigated: file is purely declarative YAML with no secrets, tokens, or internal paths. |
| A01-A04, A07-A10 | All others | N/A | Config file addition only. No runtime code, no authentication, no injection surfaces. |

### Existing Workflow Compatibility

- `dependency-review.yml` — runs on PRs to review dependency changes. Dependabot PRs will trigger this workflow, providing an additional safety layer. No conflict.
- `yaml-lint.yml` — will validate `dependabot.yml` syntax. Must ensure file passes yamllint.

### Current Dependencies (from package.json)

- **Production (2)**: `@babel/parser`, `fastest-levenshtein`
- **Dev (8)**: `@commitlint/cli`, `@commitlint/config-conventional`, `@eslint/js`, `@microsoft/eslint-formatter-sarif`, `@stryker-mutator/core`, `c8`, `eslint`, `globals`, `js-yaml`, `lefthook`, `yaml`
- **Peer (1, optional)**: `lefthook`

---

## TDD Test Scenarios

| # | Type | Scenario | Expected |
|---|------|----------|----------|
| 1 | Happy path | `.github/dependabot.yml` is valid YAML with correct structure | File parses without error, has `version: 2` |
| 2 | Happy path | npm ecosystem configured with weekly schedule and groups | `package-ecosystem: npm`, `schedule.interval: weekly`, `schedule.day: monday`, `groups` key present with production and development groups |
| 3 | Happy path | github-actions ecosystem configured with weekly schedule | `package-ecosystem: github-actions`, `schedule.interval: weekly` |
| 4 | Validation | dependabot.yml passes yaml parsing (existing yaml-lint.yml workflow) | No YAML syntax errors |
| 5 | Edge | TOOLCHAIN.md mentions minimum bd version | File contains "bd" or "beads" version reference |
| 6 | Integration | dependency-review.yml continues to work (no conflicts) | Both files coexist in `.github/` without interfering |
