---
name: build
description: "Use when implementing a slice: claiming it, getting an isolated worktree, making its named check fail and then pass with receipts, filing side findings, stopping after 2 failed fixes on one check, and finishing with every check passing on the final tree before push."
---

# build

## Claim

1. T3 chats use the session step in `loop` first. Separate CLI workers: `export FORGE_SESSION=<your task name>` before claiming.
2. `forge issue claim --input '{"id":"<slice>"}'`.
3. Refused because someone holds it: do not start. Steer the live worker instead. Never two workers on one slice.
4. During long work, renew before the claim lapses: `forge issue renew --input '{"id":"<slice>"}'`.

## Workspace

Get a worktree with dependencies installed from the harness:

- T3 Code: `t3_thread_launch` with a worktree `workspaceStrategy`, or `delegate_task` with `isolation:"worktree"`.
- Claude Code: a subagent with `isolation: worktree`.
- Otherwise: `git worktree add <path> -b <branch> origin/main`, then the project's install.

## Red, then green

1. Explore before editing: `forge issue show --input '{"id":"<slice>"}'`, then every file under Touches.
2. Make the named check fail: `forge check run --input '{"checks":["<name>"]}'`. Expect exit 1 and `ok:false` for FAIL (exit 2 for INCOMPLETE or NOT_EXECUTED); keep the full `result` receipt and its id even on nonzero exit. PASS alone exits 0. Do not chain red checks with `&&` or discard their output on failure.
3. Make the smallest change that turns it green. Run it again; keep that receipt id too.
4. Commit in small conventional commits.

"Should pass" and "was passing" are not evidence. A receipt is. Unknown, truncated or zero-test output is not a pass.

## Stay inside the boundary

- Unrelated findings: file them with `forge issue create` and a priority label. Never fix them here.
- Before push, compare `git diff --name-only origin/main...HEAD` with Owns. A file outside Owns, or a need missing from main, means file a `contract-gap` issue, add a failing test that pins the gap, and stop.

## Stuck

After 2 failed fixes on the same check, stop editing. Write the premise down with `forge issue comment --input '{"id":"<slice>","body":"premise: ..."}'`, test that premise directly, then re-slice or escalate to the orchestrator.

## Habits

- Long processes run in the background with a timeout.
- Edit with the editor tool or a script file, never long inline shell strings.
- Checkpoint with `forge issue comment` and restart clean rather than fight a polluted context.

## Finish

1. Read `forge check list --input '{}'`. Run its configured `receiptChecks` on the final tree: `forge check run --input '{"checks":["<name>"]}'`, supplying every name. If `receiptChecks` is empty, select at least one relevant declared check. Run the slice's named regression check too; CI carries the remaining project checks. Require exit 0, `ok:true` and receipt status PASS. Read it back with `forge check show --input '{"id":"<receipt>"}'`; its subject must equal your head. A successful show reads evidence; it does not mean the stored checks passed.
2. Push, open the PR (`open-pr`), then link it while you still hold the claim: `forge issue link --input '{"id":"<slice>","relation":"delivers","url":"<pr url>"}'`.
3. Release: `forge issue release --input '{"id":"<slice>"}'`. The orchestrator claims again to merge and close.
4. Stop at push. Never merge. Cite the receipt ids and what was not checked in the PR's Verification section.
