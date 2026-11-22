# Claim, workspace and PR handoff

If a worker brief says stop after push or PR open, link an open PR to the issue, release the claim, then stop; leave thread linking and CI watching to the orchestrator.

Optional `forge agent guard`. Completion outside code needs current-head PASS receipt and `Not covered:`, or `Unverified:`.

## Claim and workspace

1. Threaded chats: `t3_thread_configuration` once (no args). All Forge calls use `FORGE_SESSION=t3:<threadId>`. Workers use own sessions. Start with `forge memory rules` unless hook-supplied. `result.text.text` is a pointer, never note text. Search/show memory before work. Separate CLI workers, before claim: POSIX `export FORGE_SESSION="<slice>-worker"`, PowerShell `$env:FORGE_SESSION="<slice>-worker"`; reuse on re-dispatch.
2. `forge issue claim <slice>`. If held, steer that worker. Never start a second. Renew via `forge issue renew <slice>`.
3. `git fetch origin`. `<base-ref>`: `origin/<declared>` for the slice's declared base, else `git symbolic-ref --short refs/remotes/origin/HEAD` (if missing, first `git remote set-head origin --auto`). Set `<base>` by dropping the `origin/` prefix. Use the supplied worktree or `forge lane start <slice> --branch <branch> --brief <project-relative-brief>`, then the project's install.

## Checkpoints

Run `forge issue checkpoint <slice> --step <step> --branch "<branch>" --worktree "<path>" --next "<next action>"` at `claimed`, `red`, `green`, `pushed` and timebox expiry (`stopped`). Include `--head`, `--pr`, `--receipt` when available. Required `next`: 1-300 chars. Before stopping, checkpoint and report it, receipts and remaining work.

Checkpoint REVISION_CONFLICT: `forge issue resume <slice>` and `forge issue comments <slice>`, then re-checkpoint.

## Push and open

1. Run SKILL.md's Final-head proof. Target ≤800 changed lines and ≤15 files. Split >1500 lines before opening. No co-author/tool trailers (trailers: none).
2. Lint and check formatting on changed files before `git push -u origin <branch>`. Never force-push.
   A `[skip ci]` head skips CI and blocks merge until another push. Use only for draft docs or notes.
3. Draft before iterative pushes. Mark ready only when the batch is complete.
   For a first red test that hosted CI must prove, open ready and push the fix as the next commit.
   `gh pr create --base <base> --draft --title "<plain conventional commit>" --body-file <file>` (omit `--draft` if ready). Speed, memory, size or work savings: the title names the user-visible gain and its number.

PR body: when the repository has a PR template, fill its sections in order and keep its headings. Otherwise:

- **Before / after**: observations and any numbers with how they were measured. Performance only: name the workload; separate component and end-to-end timings.
- **What review found**: each blocker: bold user-visible failure and one-line fix. Empty on first push.
- **Verification**: `forge check run` receipt IDs, test that fails without the change, head CI if available. User-visible PRs with `.forge/verify.md`: name the guide scenario and list saved evidence paths. Performance only: pin the saving with a work, process or call count or size bound.
- **Not verified**: what you did not check. Always present. Performance only: what the measurement does not establish.
- **Models**: for each of planned, implemented and reviewed, list display name, model id, reasoning level and harness. Use `not yet reviewed` if pending. Roles alone are not allowed. No tool-branding footer.
- `Tracking: <issue id>`.

Use plain sentences without internal codes or local data.

## Link, release, stop

1. While claimed, link the PR: `forge issue link --input '{"id":"<slice>","relation":"delivers","url":"<pr url>"}'`.
2. Release: `forge issue release --input '{"id":"<slice>"}'`. Never merge. Orchestrator: `forge-review` then `forge-land`.
3. Last action: the owning session runs `forge agent wait <n>`. Follow steps and `then` per push/head. Workers hand off PRs. Use `--fallback` only if a link or watch step fails. Forge stores neither.
