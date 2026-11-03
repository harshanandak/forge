# Claim, workspace and PR handoff

If a worker brief says stop after push or PR open, link an open PR to the issue, release the claim, then stop; leave thread linking and CI watching to the orchestrator.

Optional Stop guard: `forge agent guard`. Completion words outside code require current-head PASS receipt and `Not covered:`, or `Unverified:`.

## Claim and workspace

1. Threaded chats: MCP `t3_thread_configuration` once (no args); `FORGE_SESSION=t3:<threadId>` on every forge command across harnesses. Workers: own sessions. Start: `forge memory rules` unless hook-supplied; `result.text.text` is a pointer, never note text. Before tasks: memory search/show. Separate CLI workers, before claim: POSIX `export FORGE_SESSION="<slice>-worker"`; PowerShell `$env:FORGE_SESSION="<slice>-worker"`; reuse on re-dispatch.
2. `forge issue claim <slice>`. Already held: steer the live worker, never start a second. Long work: renew: `forge issue renew <slice>`.
3. `git fetch origin`; resolve `<base-ref>`: `origin/<declared>` for the slice's declared base, else `git symbolic-ref --short refs/remotes/origin/HEAD` (if missing, first `git remote set-head origin --auto`). Derive `<base>` by dropping the `origin/` prefix. Use supplied isolated worktree or ask harness for one with dependencies installed; else `git worktree add <path> -b <branch> <base-ref>`, then the project's install.

## Checkpoints

Run `forge issue checkpoint <slice> --step <step> --branch "<branch>" --worktree "<path>" --next "<next action>"` at `claimed`, `red`, `green`, `pushed`, and timebox expiry (`stopped`). Include `--head`, `--pr`, `--receipt` if available; `next` is required, 1-300 chars. Before stopping, checkpoint; report it, receipts and remaining work.

On checkpoint REVISION_CONFLICT: `forge issue resume <slice>`, `forge issue comments <slice>`, then re-checkpoint. No silent retry.

## Push and open

1. Require SKILL.md's Final-head proof. Target at most 800 changed lines and 15 files; above 1500, split before opening. No co-author or tool trailers (trailers: none).
2. `git push -u origin <branch>`. Never force-push; that is a one-way door.
3. Write body with editor, then `gh pr create --base <base> --title "<plain conventional commit>" --body-file <file>`. Speed, memory, size or work savings: the title names the user-visible gain and its number.

Fill PR template: plain opening; bold takeaways; What review found; Verification.

- **Opening**: user-visible problem, then addition. Short, plain sentences; no internal codes.
- **Before / after**: observations before and after X; real numbers if available; how measured. Performance only: name workload; separate component and end-to-end timings.
- **What review found**: each blocker: bold user-visible failure and one-line fix. Empty on first push.
- **Verification**: `forge check run` receipt ids; test that fails without the change; CI for this head if available. User-visible PRs with `.forge/verify.md`: name the guide scenario and list saved evidence paths. Performance only: pin the saving with a work, process or call count or size bound.
- **Not verified**: what you did not check. Always present. Performance only: what the measurement does not establish.
- **Models**: for each of planned, implemented and reviewed, give display name, model id, reasoning level and harness: `Implemented: <display name> (<model id>, reasoning <effort>) via <harness>`. Use `not yet reviewed` when unreviewed. Roles alone are not allowed. No tool-branding footer.
- `Tracking: <issue id>`.

No machine-local data (paths, usernames, local links).

## Link, release, stop

1. **PR to issue (Forge)**, holding claim: `forge issue link --input '{"id":"<slice>","relation":"delivers","url":"<pr url>"}'`.
2. Release: `forge issue release --input '{"id":"<slice>"}'`. Never merge. Orchestrator: `forge-review`, then `forge-land`.
3. Last action: owning session runs `forge agent wait <n>` once; do each step and `then`, including re-wait per push/head. Workers hand it the PR. Use `--fallback` only if a link or watch step fails. Forge stores neither.
