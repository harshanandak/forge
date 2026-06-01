# Tasks: v0.0.11 Canonical Documentation Overhaul

## Task 1: Canonical product framing and release metadata

OWNS: README.md, package.json, CHANGELOG.md

What to implement:
Reframe Forge as a local runtime control plane for AI-assisted engineering, add the DeepWiki badge, separate v0.0.11 public release language from internal roadmap labels, and add a v0.0.11 release-note draft.

Evidence steps:
1. Verify current package metadata and README framing.
2. Update docs and metadata.
3. Run focused Markdown link checks for edited files.

## Task 2: Public documentation map and first-run path

OWNS: docs/INDEX.md, docs/guides/QUICKSTART.md, docs/guides/MIGRATION.md

What to implement:
Create a Diataxis-style docs map and first-run guide covering install, quickstart, forge init, setup, common commands, protected state surfaces, adapters, Beads/GitHub sync, status/team surfaces, validation/review/verify, release flow, and migration from old versions.

Evidence steps:
1. Verify target files and existing links.
2. Add or rewrite docs.
3. Run focused Markdown link checks for edited files.

## Task 3: Support-readiness documentation

OWNS: docs/guides/SUPPORT.md, docs/reference/COMMANDS.md, docs/reference/RELEASE.md

What to implement:
Add FAQ, troubleshooting, known limitations, rollback/recovery, branch protection/worktree guidance, Beads/Dolt recovery notes, command reference, release flow, and post-merge DeepWiki refresh checklist.

Evidence steps:
1. Verify current command surfaces from package.json and CLI files.
2. Add support/reference docs.
3. Run focused Markdown link checks for edited files.

## Task 4: Stale framing cleanup and evaluator pass

OWNS: docs/reference/TEMPLATES.md, docs/reference/ADAPTERS.md, docs/reference/STATUS_BOARD.md, docs/reference/protected-state-surfaces.md, docs/guides/SETUP.md

What to implement:
Update existing high-traffic reference docs to align with the runtime-control-plane framing, mark future/experimental areas clearly, and remove stale 7-stage-only positioning where it conflicts with current behavior.

Evidence steps:
1. Search edited docs for stale framing and internal roadmap labels.
2. Apply evaluator feedback.
3. Run docs validation and package validation.

## Validation Plan

- bun run validate:yaml
- bun run check
- npm pack --dry-run
- Focused Markdown link validation using a small local script.
- PR review checks after /ship.

## Beads Context Note

Beads issue creation and context updates are blocked in this worktree by local Dolt runtime state: `database "forge" not found on Dolt server at 127.0.0.1:62561`. This task list is the structured /dev entry artifact for this PR.

