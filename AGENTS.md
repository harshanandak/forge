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

## Review guidelines

These findings recurred on at least 2 PRs; check every diff against them.

1. Keep absolute install, checkout, user, and device paths out of errors, reports, logs, and serialized diagnostics; normalize spellings and redact the full path including spaces and punctuation.
   Bad: embed the raw install root in an `unavailable()` reason.
   Safe: scrub raw and normalized roots with `[install path]`.
2. Validate the canonical filesystem object you will use, then use that same object or handle; fail closed or report incomplete when mutation, rotation, or deletion can intervene.
   Bad: check one path spelling then open a re-resolved spelling.
   Safe: open once through a no-follow validated helper and reuse the handle.
3. Redact full sensitive spans before broader destructive substitutions, then verify after normalization; never let a partial match consume a secret introducer or hide an adjacent secret.
   Bad: replace paths first, then run label redaction on the damaged text.
   Safe: collect secret and path spans first, then mask without overlap.
4. Never treat a broad pre-await read as authority after an await; capture exact entity IDs before async work, or re-read and revalidate inside the serialization gate.
   Bad: post text, then mark every owed reply as answered.
   Safe: capture owed IDs first, then mark only those IDs when confirmed.
5. Treat missing `.git` or a failed git probe as INCOMPLETE or FAIL in a git-dependent check unless the input declares an archive; never report PASS or a clean identity such as `unknown`.
   Bad: return PASS without `.git` or fall back to commit `unknown`.
   Safe: return INCOMPLETE when metadata is missing and throw with probe output when the probe fails.
6. Classify a local persistence failure separately from the remote write outcome; once delivery or commit may have happened, preserve the outcome and return the committed identifier or receipt with a precise persistence warning.
   Bad: report `CHAT_UNAVAILABLE` with no item ID after the journal write fails.
   Safe: return the receipt with the item ID plus a persistence warning.
7. Never make a change pass by exempting the artifact, file, or case it introduces; satisfy the invariant, narrow the exception to a pre-existing reviewed case, or change the invariant openly in its own reviewed change.
   Bad: add a new file alongside an exemption for that same file.
   Safe: keep the change within the guard and leave the guard unchanged.

Evidence: see issue forge-1971.
