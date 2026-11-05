---
name: forge-loop
description: "Use when starting or resuming delivery. Read fresh state, route to the stage skill, act on changes and stop."
disable-model-invocation: true
---

# forge-loop

Every wake: read, route, stop. Read the chosen skill before acting.

## Steps

1. Read [session.md](session.md) before claiming, and [memory.md](memory.md) on session start or before a task.
2. Read [resume.md](resume.md) on restart. Otherwise read `forge issue ready --input '{}'`, `forge issue stale --input '{}'`, then `forge issue show --input '{"id":"<id>"}'` for your slice.
3. Read [watching.md](watching.md) when PR work exists, after a push or on handback.
4. Route: 1 vague intent or unresolved decisions: `forge-intake`; 2 frame, 3 slice: `forge-cut`; 4 claim/workspace, 5 build, 6 check, 7 open PR: `forge-build`; 8 review or red PR: `forge-review`; 9 merge, 10 verify, 11 learn/re-plan or red base: `forge-land`.
5. Read [dispatch.md](dispatch.md) before dispatch. Orchestrators own intake, slicing, review, merge, verify and re-plan; workers own one build or fix batch. One agent may hold both on small work.
6. Read [doors.md](doors.md) if an action is a one-way door.

## Hard rules

- Workers own one claimed slice, stop at push and never merge. If a worker brief says stop after push or PR open, link an open PR to the issue, release the claim, then stop; leave thread linking and CI watching to the orchestrator. With no PR, the orchestrator claims, opens and links it.
- Proceed on reversible actions without asking. Stop for a one-way door, a scope change beyond the done boundary, or a blocked guard or hook. Never route around a block.
- On LIMIT_REACHED stop and report. Workers stop and report the checkpoint when timeboxMinutes expire, never later than stopBy. Never start a second worker on the same slice.
- Act only on what changed since your last push, then stop. Forge never watches: the harness wakes you.

## Read on demand

- [session.md](session.md): Session ownership.
- [watching.md](watching.md): PR verdicts, links and waits.
- [dispatch.md](dispatch.md): Calls, timeboxes, lanes and brief.
- [memory.md](memory.md): Memory and decisions.
- [doors.md](doors.md): Owner authorization.
- [resume.md](resume.md): Restart recovery.
