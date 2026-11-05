# PR state and watching

Every PR wake runs `forge pr state <n>` and acts on `verdict`.

## Two links

The PR-to-issue link is Forge's: `forge issue link --input '{"id":"<slice>","relation":"delivers","url":"<pr url>"}'`. The PR-to-agent-thread link is separate: follow `forge-build`'s opening handoff. Wakes act without re-arming event watches.

After each push, run `forge agent wait <n>`; for `t3-tool`, skip its steps (already watching); otherwise do each step and follow `then`. No sleep loop.

## Resume and cleanup

Only when resuming a session with existing PR work, run `forge agent wait --sweep`, do each step, then follow `then`.

On abandon, an unmerged close or handback, or after verify, run `forge agent wait <n> --done`, do each step and follow `then`.

Use `--fallback` only if a plain opening wait's link or watch step fails. Report and skip a failed `--sweep` or `--done` step.
