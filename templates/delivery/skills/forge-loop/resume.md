# Resume interrupted work

1. Run `forge issue resume` to find checkpointed open slices, including live claims. With a known slice, go straight to `forge issue resume <slice>`.
2. Read the slice's body, checkpoint, claim, delivers links, intent calls and newest later comments. Later comments override the body. Also read `forge issue comments <slice>` when `more` is true (older comments were omitted), or when a checkpoint exists and you need earlier direction. Resume spends no call; count each new dispatch with `forge issue call <slice> --role <role>` and obey its limits.
3. Run `git -C "<worktree>" status` using the checkpoint's worktree; check its branch and preserve uncommitted work. Compare the checkpoint with the actual tree before acting on `next`.
4. Re-dispatch only after the old worker is gone. Reuse the same-device session (PowerShell: `$env:FORGE_SESSION="<slice>-worker"`) and renew a live claim; claim again if stale or released. Another holder's live claim still blocks work. Discovery does not prove a process died.
5. Follow `next` through `forge-build` or `forge-review`. Existing PR work also follows forge-loop's sweep. Post a `record: restart` comment with kind (natural, boundary or induced), first three commands, seconds to first productive action, and inherited work kept or discarded.
