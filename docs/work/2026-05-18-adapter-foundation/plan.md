# 0.0.18 Adapter Foundation

Date: 2026-05-18
Branch: codex/0.0.18-adapter-foundation
Issues: forge-79xh, forge-1c0j, forge-tis9

## Purpose

Create the first review-adapter foundation for Forge v3 by defining a stable ReviewAdapter SPI, moving the existing Greptile review-thread behavior behind that SPI, and giving future adapters a small scaffold plus offline replay path.

## Current Behavior Verified

- `lib/greptile-match.js` currently exports `matchThreadsToCommits(threads, projectRoot, opts)` and marks Greptile threads resolved when recent commits touched the same files.
- `.claude/scripts/greptile-resolve.sh` currently owns GitHub API operations for listing review threads, replying to comments, resolving threads, resolving all, listing Greptile summary comments, and stats.
- `package.json` exposes `bun test --timeout 15000`, `bun run lint`, `bun run typecheck`, and `node scripts/validate.js`.
- `docs/work/2026-04-28-skeleton-pivot/locked-decisions.md` D9 requires review adapter templates later, but this PR is a foundation slice, not the full template library.

## Success Criteria

- A ReviewAdapter SPI exists with documented lifecycle and methods for `fetchThreads`, `parse`, `reply`, `resolve`, and `score`.
- Greptile behavior remains compatible: existing shell commands continue to work and use the Greptile adapter internally where practical.
- `forge new adapter <name> --kind=review --template=greptile` or a comparably small scaffold entrypoint can generate a review adapter starter once the SPI shape is stable.
- `forge adapter test <name> --fixture=<path>` or a narrow fixture replay harness validates adapter parsing/scoring offline without live GitHub calls if it fits cleanly.
- Adapter contract docs describe inputs, outputs, lifecycle, fixture expectations, and compatibility notes.

## Out Of Scope

- Do not implement `IssueAdapter`.
- Do not implement GitHub issue sync.
- Do not ship the full v3 reference adapter template catalog.
- Do not change the public Greptile review workflow behavior beyond routing through the adapter foundation.

## Design

1. Add `lib/review-adapter.js` as the SPI definition and validation helpers.
2. Add `lib/adapters/greptile-review-adapter.js` as the reference implementation over the existing Greptile review-thread shape.
3. Keep `lib/greptile-match.js` backward compatible by delegating scoring/matching to the Greptile adapter without changing its export.
4. Add a small adapter CLI module and wire it into `bin/forge.js` for:
   - `forge new adapter <name> --kind=review --template=greptile`
   - `forge adapter test <name> --fixture=<path>`
   - lightweight `list`, `enable`, and `disable` commands only if they can be implemented as local config/file operations without inventing broader runtime dispatch.
5. Add tests around SPI validation, Greptile compatibility, scaffold generation, and fixture replay.

## Compatibility Notes

- Existing `.claude/scripts/greptile-resolve.sh` commands must keep their command names and output intent.
- Existing `matchThreadsToCommits` callers must keep working.
- Fixture replay must be offline and deterministic.

## Validation Plan

- Targeted adapter tests during development.
- `bun run typecheck`.
- `bun run lint`.
- `bun test --timeout 15000`.
- `node scripts/validate.js`.
