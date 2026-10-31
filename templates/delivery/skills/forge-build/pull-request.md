# Claim, workspace and PR handoff

If a worker brief says stop after push or PR open, link an open PR to the issue, release the claim, then stop; leave thread linking and CI watching to the orchestrator.

Print the optional Stop guard with `forge agent guard`; completion words outside code require a current-head PASS receipt and a `Not covered:` line, or an `Unverified:` line.

## Claim and workspace

1. Threaded chats: MCP `t3_thread_configuration` once (no args); `FORGE_SESSION=t3:<threadId>` on every forge command across harnesses. Workers: own sessions. Start: `forge memory rules` unless hook-supplied; `result.text.text` is a pointer, never note text. Before tasks: memory search/show. Separate CLI workers, before claim: POSIX `export FORGE_SESSION="<slice>-worker"`; PowerShell `$env:FORGE_SESSION="<slice>-worker"`; reuse on re-dispatch.
2. `forge issue claim <slice>`. Refused because someone holds it: steer the live worker, never start a second on that slice. Renew during long work: `forge issue renew <slice>`.
3. Use the supplied isolated worktree, or ask the harness for one with dependencies installed; otherwise `git worktree add <path> -b <branch> origin/main`, then the project's install.

## Checkpoints

Run `forge issue checkpoint <slice> --step <step> --branch "<branch>" --worktree "<path>" --next "<next action>"` at `claimed`, `red`, `green`, `pushed`, and timebox expiry (`stopped`). Include `--head`, `--pr`, `--receipt` when available; `next`: 1-300 chars, required. Checkpoint before stopping; report it, receipts, remaining work.

If checkpoint returns REVISION_CONFLICT (another comment took the id), run `forge issue resume <slice>` and read `forge issue comments <slice>`, then write the checkpoint again. Do not retry silently.

## Push and open

1. Require SKILL.md's Final-head proof. Target at most 800 changed lines and 15 files; above 1500 lines, split before opening. Commits carry no co-author or tool trailers (trailers: none).
2. `git push -u origin <branch>`. Never force-push; that is a one-way door.
3. Write body file with editor tool, then `gh pr create --base <base> --title "<plain conventional commit>" --body-file <file>`. Speed, memory, size or work savings: the title names the user-visible gain and its number.

Fill the repo's PR template. Style: plain opening; bold takeaways; What review found; Verification.

- **Opening**: user-visible problem, then what it adds. Short, plain sentences; no internal codes.
- **Before / after**: user observations before and after X. Real numbers if available; how they were measured. Performance only: name the workload; separate component and end-to-end timings.
- **What review found**: each blocker as a bold user-visible failure and a one-line fix. Empty on the first push.
- **Verification**: `forge check run` receipt ids; test that fails without the change; CI for this head if available. Performance only: pin the saving with a work, process or call count or size bound.
- **Not verified**: what you did not check. Always present, never empty-by-omission. Performance only: what the measurement does not establish.
- **Models**: for each of planned, implemented and reviewed, give the model's display name, model id, reasoning level and harness, e.g. `Implemented: <display name> (<model id>, reasoning <effort>) via <harness>`. Use `not yet reviewed` when there is no review. Roles alone are not allowed. No tool-branding footer.
- `Tracking: <issue id>`.

No machine-local data: no drive paths, usernames or links to files only on your machine.

## Link, release, stop

1. **PR to issue (Forge)**, while holding the claim: `forge issue link --input '{"id":"<slice>","relation":"delivers","url":"<pr url>"}'`.
2. Release: `forge issue release --input '{"id":"<slice>"}'`. Never merge. The orchestrator uses `forge-review`, then `forge-land`.
3. Last action: the owning session runs `forge agent wait <n>` once; do each step and `then`, including re-wait per push/head. Workers hand it the PR. Use `--fallback` only if a link or watch step fails. Forge stores neither link nor watch.
