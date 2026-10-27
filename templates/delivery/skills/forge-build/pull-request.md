# Claim, workspace and PR handoff

Print the optional Stop guard with `forge agent guard`; it requires a current-head PASS receipt and a `not covered:` line for done claims, or an explicit "unverified".

## Claim and workspace

1. Threaded chats: call MCP `t3_thread_configuration` once (no args) and set `FORGE_SESSION=t3:<threadId>` for every forge command, even after a harness switch. Workers you launch keep their own task session. At session start, run `forge memory rules` unless a hook supplied it: `result.text.text` is a pointer, never note text. Search memory before starting a task; use its search/show commands. Separate CLI workers: `export FORGE_SESSION=<your task name>` before claiming.
2. `forge issue claim --input '{"id":"<slice>"}'`. Refused because someone holds it: steer the live worker, never start a second on that slice. Renew during long work: `forge issue renew --input '{"id":"<slice>"}'`.
3. Use the supplied isolated worktree, or ask the harness for one with dependencies installed; otherwise `git worktree add <path> -b <branch> origin/main`, then the project's install.

## Push and open

1. Require SKILL.md's Final-head proof. Target at most 800 changed lines and 15 files; above 1500 lines, split before opening. Commits carry no co-author or tool trailers (trailers: none).
2. `git push -u origin <branch>`. Never force-push; that is a one-way door.
3. Write the body to a file with the editor tool, then `gh pr create --base <base> --title "<plain conventional commit>" --body-file <file>`.
4. Immediately after the PR opens, run `forge agent wait <n>` once, do each step, then follow `then`, including any instruction to wait again after each push for the new head. On a failed step use `--fallback`. Forge stores neither link nor watch.

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
2. Release: `forge issue release --input '{"id":"<slice>"}'`. Stop at push after opening and linking; never merge. The orchestrator uses `forge-review`, then `forge-land`.
