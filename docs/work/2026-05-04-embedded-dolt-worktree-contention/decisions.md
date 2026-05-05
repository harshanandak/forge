# Embedded Dolt Worktree Contention Decisions

Issue: `forge-besw.18`
Date: 2026-05-04

## Decision 1

**Date**: 2026-05-04
**Task**: Task 2 - Prove Embedded Mode Can Read Existing Data
**Gap**: The issue requested a metadata flip but did not specify how to prove the embedded storage path was non-empty and compatible with the installed `bd` build.
**Score**: 11/14
**Route**: PROCEED
**Choice made**: Tested a disposable copy of `.beads` with `dolt_mode` set to `embedded` before changing the shared repo metadata. The disposable copy reported `mode: embedded`, `database: forge`, `list_count=99`, and preserved `forge-besw.18`.
**Status**: RESOLVED

## Verification Evidence

- Baseline backup status before the switch: 260 issues, 331 events, 2 comments, 263 deps, 46 labels, 11 config.
- Baseline visible issue list before the switch: `bd list --json --limit 0` returned 99 visible issues and included `forge-besw.18`.
- Disposable embedded-mode copy: `bd context` reported `mode: embedded`, `database: forge`; `bd list --json --limit 0` returned 99 visible issues and included `forge-besw.18`.
- Live repo after metadata switch: `bd context` reported `mode: embedded`, `database: forge`; `forge show forge-besw.18` succeeded.
- Concurrent validation from the feature worktree and main checkout completed with exit code 0 in both jobs; both reported `mode: embedded`, 99 visible issues, and `forge-besw.18` present.
- `bash scripts/beads-context.sh validate forge-besw.18` passed with all context fields present.
- `node scripts/sync-commands.js --check` passed after moving the `docs/work` path change into canonical `.claude/commands/*` files and regenerating agent command surfaces.
- Targeted sync/contract tests passed: `bun test ./test/structural/command-contracts.test.js ./test/command-sync-check.test.js ./test/structural/command-sync.test.js ./test/scripts/sync-commands.test.js --timeout 15000` returned 79 passed, 0 failed.
- `bun run typecheck` passed with exit code 0.
- `bun run lint` passed with exit code 0.
- `bun audit --audit-level critical` passed with exit code 0 and no vulnerabilities.
- Targeted remaining-failure cluster passed: `bun test ./test/toolchain-bd-version.test.js ./test/cleanup/dropped-agent-docs.test.js ./test/dep-guard/analyzer.test.js ./test/scripts/behavioral-judge.test.js ./test/scripts/github-beads-sync/config-files.test.js --timeout 15000` returned 67 passed, 0 failed.
- `bun test ./test/forge-docs-command.test.js --timeout 15000` passed after updating the docs resolver for `docs/reference` and `docs/guides`.
- `bun test ./test/docs-consistency.test.js --timeout 15000` passed after updating the setup-doc assertion to `docs/guides/SETUP.md`.
- `bun test ./packages/skills/test/create.test.js ./packages/skills/test/list.test.js ./packages/skills/test/remove.test.js ./packages/skills/test/sync.test.js ./packages/skills/test/validate.test.js --timeout 15000` passed after restoring workspace dependencies with `bun install --frozen-lockfile`.
- Final full suite passed: `bun test --timeout 15000` returned 3009 passed, 58 skipped, 0 failed.
