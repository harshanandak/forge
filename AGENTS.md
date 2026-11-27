# Forge

Forge (`forge-workflow`, command `forge`) builds CLI and MCP tools from block operations. Core knows no workflow; stages, TDD and pull requests belong in blocks/templates. Bun builds Forge; consumers need npm and Node 24.15+ in 24.x or Node 26+. Node 25 is unsupported.

Commands: `package.json`. Guards: `test/structure`.
Agents: use `forge <noun> <verb> --help --json` or `forge catalog describe <noun.verb>` for the full JSON contract.

## Gotchas

- `no-comments` refuses new source/test comments. Put reasons in a test named for the constraint, a named constant or the issue.

- `bun lint` needs canary; `bun fmt` is stable in 1.4.4. The `lint` and `fmt` scripts use `tools/bun-builtin.ts`, which exits 1 with an upgrade hint on a Bun without the built-in. `bun check` needs Bun 1.4.3 or newer.
- Owner rule (2026-11-03): CI is the test gate; no local test suites. Local checks: lint, format check, typecheck and build. Prove red then green in CI. No local git hooks; fix failing checks, never bypass them.
- Work in a git worktree under `.worktrees/`, based on the fetched `origin/main`.
- Commit with conventional titles (`feat:`, `fix:`, `docs:`, `chore:`, `refactor:`, `test:`, `ci:`). The pull request title is checked and becomes the squash-merge title and the changelog line.
- After cloning, run `forge skills sync`. People run `/forge-loop`; models read `.agents/skills/forge-loop/SKILL.md` when told to.
- Checks: PASS exits 0; FAIL 1; INCOMPLETE/NOT_EXECUTED 2. Non-PASS keeps the receipt with `ok:false`.

## Standards

Read [CODING_STANDARDS.md](CODING_STANDARDS.md) before writing or reviewing code, adding a dependency, adding a test, or retiring something. It holds the boundaries, dependency, test and platform rules; most are enforced by a guard in `test/structure`.
Review guidelines: check every diff against [docs/review-guidelines.md](docs/review-guidelines.md).
