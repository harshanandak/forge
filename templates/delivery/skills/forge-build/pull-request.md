# Claim, workspace and PR handoff

Print the optional Stop guard with `forge agent guard`; completion words outside code require a current-head PASS receipt and a `Not covered:` line, or an `Unverified:` line.

## Claim and workspace

1. Threaded chats: call MCP `t3_thread_configuration` once (no args) and set `FORGE_SESSION=t3:<threadId>` for every forge command, even after a harness switch. Workers you launch keep their own task session. At session start, run `forge memory rules` unless a hook supplied it: `result.text.text` is a pointer, never note text. Search memory before starting a task; use its search/show commands. Separate CLI workers: `export FORGE_SESSION=<slice>-worker` before claiming; re-dispatches reuse it.
2. `forge issue claim --input '{"id":"<slice>"}'`. Refused because someone holds it: steer the live worker, never start a second on that slice. Renew during long work: `forge issue renew --input '{"id":"<slice>"}'`.
3. Use the supplied isolated worktree, or ask the harness for one with dependencies installed; otherwise `git worktree add <path> -b <branch> origin/main`, then the project's install.

## Checkpoints

Run `forge issue checkpoint --input '{"id":"<slice>","step":"<step>","branch":"<branch>","worktree":"<path>","next":"<next action>"}'` after the claim (`claimed`), red (`red`), green (`green`) and push (`pushed`), and when a timebox expires (`stopped`). Include `head`, `pr` and `receipt` when available. `next` is required, 1-300 characters. Write the checkpoint before stopping; report it with receipts and remaining work.

## Push and open

1. Require SKILL.md's Final-head proof. Target at most 800 changed lines and 15 files; above 1500 lines, split before opening. Commits carry no co-author or tool trailers (trailers: none).
2. `git push -u origin <branch>`. Never force-push; that is a one-way door.
3. Write the body to a file with the editor tool, then `gh pr create --base <base> --title "<plain conventional commit>" --body-file <file>`.

Fill the repo's PR template. Style: plain opening; bold takeaways; What review found; Verification.

- **Opening**: the problem as a user sees it, then what this adds. Short sentences, plain words, no internal codes.
- **Before / after**: what a user observes when X happens, before and after. Numbers where real numbers exist, with how they were measured.
- **What review found**: each blocker as a bold user-visible failure and a one-line fix. Empty on the first push.
- **Verification**: the receipt ids from `forge check run`, the test that fails without the change, the CI run for this head when available.
- **Not verified**: what you did not check. Always present, never empty-by-omission.
- **Models**: for each of planned, implemented and reviewed, give the model's display name, model id, reasoning level and harness, e.g. `Implemented: <display name> (<model id>, reasoning <effort>) via <harness>`. Use `not yet reviewed` when there is no review. Roles alone are not allowed. No tool-branding footer.
- `Tracking: <issue id>`.

No machine-local data: no drive paths, usernames or links to files only on your machine.

## Link, release, stop

1. **PR to issue (Forge)**, while holding the claim: `forge issue link --input '{"id":"<slice>","relation":"delivers","url":"<pr url>"}'`.
2. Release: `forge issue release --input '{"id":"<slice>"}'`. Never merge. The orchestrator uses `forge-review`, then `forge-land`.
3. Last action: the owning session runs `forge agent wait <n>` once, does each step, then follows `then`, including any instruction to wait again after each push for the new head. A worker hands the PR to that session. Use `--fallback` only if a link or watch step fails. Forge stores neither link nor watch.
