# v0.0.11 Canonical Documentation Overhaul

Date: 2026-05-23
Status: In progress
Branch: codex/docs-v0.0.11-canonical-overhaul

## Purpose

Make the repository itself the canonical source for Forge v0.0.11 public-release documentation. DeepWiki is a generated downstream view over the repository, so README, CHANGELOG, user guides, support docs, reference docs, command examples, tests, and release notes must carry the current product framing.

Forge should be positioned as a local runtime control plane for AI-assisted engineering. The default TDD-first workflow remains important, but it is one template over runtime building blocks rather than the whole product identity.

## Success Criteria

- README explains Forge in plain language for solo builders, teams, and technical users.
- README includes the DeepWiki badge and describes DeepWiki as generated, not authoritative.
- CHANGELOG has a v0.0.11 release-note draft with user value, migration notes, experimental areas, known limits, rollback path, adapter compatibility, and DeepWiki refresh checklist.
- docs/INDEX.md becomes the public docs map across tutorials, how-to guides, explanation, and reference.
- First-run docs cover install, quickstart, forge init, setup, common commands, protected state surfaces, adapters, Beads/GitHub sync, status/team surfaces, validation/review/verify flow, release flow, and migration from older versions.
- Support docs cover FAQ, troubleshooting, known limitations, rollback/recovery, branch protection, worktrees, and Beads/Dolt recovery notes.
- Public v0.0.11 release language is separated from internal roadmap labels such as 0.0.19.
- Stale docs are rewritten, redirected, or clearly marked as historical when they conflict with current behavior.
- Validation includes docs/link validation if available, bun run check, and npm pack --dry-run.
- The PR is pushed and reviewed for CI/review feedback.

## Out Of Scope

- Publishing v0.0.11 to npm or creating a GitHub Release.
- Implementing new product features.
- Starting 0.0.20 issue graph work.
- Treating DeepWiki generated text as source of truth.
- Repairing local Beads/Dolt runtime state unless required to complete the PR.

## Verified Constraints

- The repository default branch is master.
- The current package version before this work is 0.0.10.
- The package exposes forge, forge-workflow, and forge-preflight binaries.
- package.json includes bun run check, bun run lint, bun run typecheck, bun test, and validate:yaml.
- Existing README leads with TDD-first workflow framing and includes several absolute claims that need softer, evidence-backed wording.
- Existing docs/INDEX.md already points toward configurable workflow/runtime building blocks and should inform the public framing.
- forge issue creation is blocked in this worktree because Beads/Dolt reports: `database "forge" not found on Dolt server at 127.0.0.1:62561`.

## Approach

Use a small set of canonical public docs instead of spreading release-critical facts across many historical work docs:

- README.md: product positioning, quickstart, what is ready now, support/debug links, DeepWiki badge.
- CHANGELOG.md: v0.0.11 draft release notes.
- docs/INDEX.md: canonical docs map and DeepWiki-readiness note.
- docs/guides/QUICKSTART.md: first successful run path.
- docs/guides/MIGRATION.md: old-version migration notes.
- docs/guides/SUPPORT.md: FAQ, troubleshooting, rollback/recovery, worktree/branch protection, Beads/Dolt recovery.
- docs/reference/COMMANDS.md: command surface grounded in current CLI/package scripts.
- docs/reference/RELEASE.md: release flow, validation, npm pack, and post-merge DeepWiki checklist.
- Existing reference docs: update cross-links and mark experimental/future areas precisely.

## Technical Research

No external web research is required for this docs-only change. The source of truth is the repository: package metadata, CLI files, tests, AGENTS.md, docs, and validation scripts.

### TDD And Validation Scenarios

1. Documentation link/schema scenario: added Markdown links point to existing repository files.
2. Command accuracy scenario: documented commands match package.json scripts and current CLI command surfaces.
3. Packaging scenario: npm pack --dry-run includes the new canonical docs and does not include generated junk.

### OWASP Notes

This is a documentation-only change. No runtime auth, permissions, persistence, network, payment, or data-processing behavior changes are introduced. Security-sensitive docs should avoid promising enforcement beyond what the code and configured repository gates can prove.

## Ambiguity Policy

For documentation claims, use conservative wording:

- If code/tests prove a behavior, document it as ready now.
- If design docs describe future direction but runtime support is partial, label it experimental or future-facing.
- If behavior depends on repository configuration, external services, branch protection, or local Beads/Dolt state, state the dependency explicitly.
- If a command fails during verification, record the exact error and document the recovery path instead of smoothing it over.

