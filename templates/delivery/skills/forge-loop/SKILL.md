---
name: forge-loop
description: "Use when starting or resuming delivery: read state, route, act, stop."
disable-model-invocation: true
---

# forge-loop

Every wake: read, route, stop. Read the chosen skill before acting.

## Steps

1. Read [session.md](session.md) on session start/restart or harness switch, before the first Forge command; [memory.md](memory.md) on session start or before a task.
2. On restart read [resume.md](resume.md). Otherwise: `forge issue ready --input '{}'`, `forge issue stale --input '{}'`, then `forge issue show --input '{"id":"<id>"}'` for your slice.
3. Read [watching.md](watching.md) on PR work, push or handback.
4. 1 vague intent/decisions: `forge-intake`; 2-3 frame/slice: `forge-cut`; 4 claim/workspace, 5 build, 6 check, 7 open PR: `forge-build`; 8 review/red PR: `forge-review`; 9-11 merge/verify/learn/re-plan/red base: `forge-land`.
5. Read [dispatch.md](dispatch.md) before dispatch. Orchestrator: intake, slicing, triage, merge, verify, re-plan; worker: one build/fix batch. One agent may hold both on small work.
6. Read [doors.md](doors.md) when preparing a door.

## Hard rules

- Workers own one claimed slice, stop at push; never merge. At the brief's push/PR stop, link an open PR to the issue, release the claim, then stop; the orchestrator owns thread linking and CI watching. Without a PR, the orchestrator claims, opens and links it.
- Doors: publish, force-push, prod-write, migration-apply, delete-branch, delete-worktree, merge-to-autodeploy, global-config. Require the owner's explicit reply naming that action; silence, "continue" or "fix all" never counts.
- Proceed on reversible actions without asking. Stop for scope beyond the done boundary or a blocked guard/hook; never route around a block.
- On LIMIT_REACHED stop and report. Workers stop and report the checkpoint when timeboxMinutes expire, never later than stopBy. Never start a second worker on the same slice.
- Act only on what changed since your last push, then stop. Forge never watches: the harness wakes you.

## Read on demand

- [session.md](session.md): Identity.
- [watching.md](watching.md): PR state.
- [dispatch.md](dispatch.md): Workers.
- [memory.md](memory.md): Memory.
- [doors.md](doors.md): Preparation.
- [resume.md](resume.md): Recovery.
