# Forge

Forge (npm package `forge-workflow`, command `forge`) is an open building-block platform for AI coding agents. Blocks declare their operations once; the CLI and MCP tools are generated from that catalog. Core knows no workflow: stages, TDD and pull requests live in blocks and templates. Bun builds Forge; the published package runs on Node 24.15+ and 26 with npm and assumes nothing about a user's toolchain. The plan of record is in [harshanandak/forge-legacy](https://github.com/harshanandak/forge-legacy) (`docs/work/2026-10-16-platform-rebuild/`).

Commands are the `package.json` scripts. `test/structure` holds the repo guards.
Agents: use `forge <noun> <verb> --help --json` or `forge catalog describe <noun.verb>` for the full JSON contract.

## Gotchas

- `bun lint` and `bun fmt` need the canary Bun build. The `lint` and `fmt` scripts reach it through `tools/bun-builtin.ts`, which exits 1 with an upgrade hint on a Bun without them. `bun check` needs Bun 1.4.3 or newer.
- CI is the gate and there are no local git hooks. Run what you touched locally; the full matrix runs on the pull request. Fix the cause of a failing check; never skip one with `--no-verify` or `core.hooksPath` tricks.
- Work in a git worktree under `.worktrees/`, based on the fetched `origin/main`.
- Commit with conventional titles (`feat:`, `fix:`, `docs:`, `chore:`, `refactor:`, `test:`, `ci:`). The pull request title is checked and becomes the squash-merge title and the changelog line.

- After cloning, run `forge skills sync` and follow the `loop` skill; this repo runs on its own delivery template (`.forge/config.yaml`).
- Checks: PASS exits 0; FAIL 1; INCOMPLETE/NOT_EXECUTED 2. Non-PASS keeps the receipt with `ok:false`.

## Standards

Read [CODING_STANDARDS.md](CODING_STANDARDS.md) before writing or reviewing code, adding a dependency, adding a test, or retiring something. It holds the boundaries, dependency, test and platform rules; most are enforced by a guard in `test/structure`.
