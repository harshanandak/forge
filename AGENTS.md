# Forge

Forge (npm package `forge-workflow`, command `forge`) is an open building-block platform for AI coding agents. Blocks declare their operations once; the CLI and MCP tools are generated from that catalog. Core knows no workflow: stages, TDD and pull requests live in blocks and templates, never in core. The plan of record is in [harshanandak/forge-legacy](https://github.com/harshanandak/forge-legacy) (`docs/work/2026-10-16-platform-rebuild/`).

## Commands

Bun builds Forge. Forge itself never assumes Bun, TypeScript or any one tool in a user's project; the published package runs on Node 24.15+ and 26 with npm.

```bash
bun install                # bun.lock is committed
bun run check              # type check (bun check)
bun run lint               # bun lint --type-aware, zero warnings
bun run fmt                # bun fmt --check (run `bun fmt` to write)
bun test --timeout 30000   # all tests (bun run test); test/structure holds the repo guards
bun run build              # tsc emits dist/ (.js + .d.ts)
bun run pack:smoke         # pack, install with npm on Node without Bun, run forge --version
```

`bun lint` and `bun fmt` need a Bun build that has them (currently the canary build; CI uses it). `bun check` needs Bun 1.4.3 or newer.

## Layout

`bin/` entry stub, `src/` the package (`core`, `ports`, `adapters`, `blocks`, `surface`), `schemas/`, `test/` (`structure` guards, `contract`, `integration`), `tools/`, `docs/` (`dependencies.md` is the dependency ledger). Discover operations with `forge catalog list`, and `--help --json` on any command.

## Rules

1. One state owner: accepted state is written only through `src/core/state`.
2. Core knows no workflow: no stage, TDD, pull request or issue term in `src/core`, `schemas/` or other core areas.
3. Gates judge outcomes and return PASS, FAIL, INCOMPLETE or NOT_EXECUTED. Nothing checked is never PASS.
4. No committed generated files, mirrors or hand-kept manifests.
5. Retirement is total: remove a feature's names, shims and docs in the same pull request.
6. Demand before breadth: a block enters with a named consumer and a contract test.
7. Deterministic tests: injected clock and process ports; a flaky test is quarantined with an issue, never retried.
8. CI is the gate. Run what you touched locally; the full matrix runs on the pull request.
9. Platform differences live at one boundary: paths, executables and processes go through adapters.
10. One adapter per dependency, each with an entry in `docs/dependencies.md`; no install scripts in the package.
11. The user's toolchain is theirs: no package manager, test runner, linter or hook runner named outside adapters and detectors.
12. Every operation is declared once; no hand-written command, alias or per-harness copy.
13. Reads never write.
14. Reports lead with the answer, then evidence and what would change it.

## Working here

- There are no local git hooks. Never bypass a check with `--no-verify`, `core.hooksPath` tricks or similar; fix the cause.
- Commit with conventional titles (`feat:`, `fix:`, `docs:`, `chore:`, `refactor:`, `test:`, `ci:`); the pull request title is checked and becomes the squash-merge title and the changelog line.
- Work in a git worktree under `.worktrees/`, based on the fetched `origin/main`.
- Every test declares an explicit timeout; `test/structure` fails otherwise. Diff-checkable standards are in [CODING_STANDARDS.md](CODING_STANDARDS.md).
- Tests prove the end-to-end outcome on the real artifact (the packed package), not that tests were written.
