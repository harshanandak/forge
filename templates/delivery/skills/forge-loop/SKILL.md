---
name: forge-loop
description: "Route or resume delivery from fresh state."
disable-model-invocation: true
---

# forge-loop

If a worker brief says stop after push or PR open, link an open PR to the issue, release the claim, then stop; leave thread linking and CI watching to the orchestrator. With no PR, the orchestrator claims, opens and links it.

Every wake: read, route, stop. Read the chosen skill before acting.

## Wake

Threaded chats: call MCP `t3_thread_configuration` once (no args) and set `FORGE_SESSION=t3:<threadId>` for every forge command, even after a harness switch. Workers you launch keep their own task session.

Only when resuming a session with existing PR work, run `forge agent wait --sweep`, do each step, then follow `then`. On abandon, an unmerged close or handback, run `forge agent wait <n> --done` and follow its steps and `then`.

Use `--fallback` only if a plain opening wait's link or watch step fails. Report and skip a failed `--sweep` or `--done` step.

At session start, run `forge memory rules` unless a hook supplied it: `result.text.text` is a pointer, never note text. Search memory before starting a task; use its search/show commands.

1. Work: `forge issue ready --input '{}'` (ranked by priority label), `forge issue stale --input '{}'`, then `forge issue show --input '{"id":"<id>"}'` for your slice.
2. PRs: every wake runs `forge pr state <n>` and acts on `verdict`.
3. Act only on what changed since your last push, then stop. Forge never watches: the harness wakes you.

## Roles

- **Orchestrator**: intake, slicing, review triage, merge, verify, re-plan.
- **Worker**: one build or one fix batch on one claimed slice. Stops at push. Never merges.
- One agent may hold both on small work.

## Steps and their skill

- 1 intake, vague intent or unresolved decisions: `forge-intake`
- 2 frame, 3 slice after intake: `forge-cut`
- 4 claim and workspace, 5 build, 6 check, 7 open PR: `forge-build`
- 8 review triage, red PR on each wake: `forge-review`
- 9 merge, 10 verify, 11 learn and re-plan; red base: `forge-land`

## Two links, never mixed

- **PR to issue** is Forge's: `forge issue link --input '{"id":"<slice>","relation":"delivers","url":"<pr url>"}'`. It needs the held claim, so the worker links before it releases.
- **PR to agent thread**: follow `forge-build`'s opening handoff. Wakes act without re-arming event watches. After each push, run `forge agent wait <n>`; for `t3-tool`, skip its steps (already watching); otherwise do each step and follow `then`.

## Autonomy

Proceed on reversible actions without asking. Stop only for:

- a one-way door: publish, force-push, prod-write, migration-apply, delete-branch, delete-worktree, merge-to-autodeploy, global-config. It needs the owner's reply naming that action. Silence or "continue" is not a yes.
- a scope change beyond the slice's done boundary;
- a blocked guard or hook. A block is a stop, never something to route around.

## Lanes

- At most 3 workers at once, and 1 full-suite run at a time.
- A worker silent for 10 minutes is stalled: read its state and steer it. Never start a second worker on the same slice.
- Capabilities: orchestrator strong, implementer fast, reviewer other-family, housekeeping cheapest. The harness picks the model.

## Worker brief

Use `forge-build`'s Worker brief; fill every required field before dispatch.

Session: POSIX `export FORGE_SESSION="<slice>-worker"`; PowerShell `$env:FORGE_SESSION="<slice>-worker"` before any claim; never use the chat's t3: session.

Standing rules are adopted decisions. List adopted decision titles only (no decision text): `forge decision list --input '{"status":"adopted"}'`. While `truncated` is true, repeat with `after` set to the returned `next`: `forge decision list --input '{"status":"adopted","after":<next>}'`, even if a page is empty. Request the adopted text from the owner when needed. On restart, read [resume.md](resume.md).
