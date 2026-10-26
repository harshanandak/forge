---
name: loop
description: "Use at the start of any session, wake-up or resume in a repo on the delivery template, and when writing a brief for a worker. Reads fresh state, picks the role (orchestrator or worker), routes each loop step to its skill, and holds the autonomy and stop rules."
---

# loop

Every wake is a fresh read. Never trust what you remember: read, act, then stop.

## Wake

In T3 chats, call the t3-code MCP tool `t3_thread_configuration` once with no arguments. Use its `threadId` to export `FORGE_SESSION=t3:<threadId>` for every forge command, including after a harness switch. Workers you launch keep their own task session, never the chat's `t3:` session.

1. Work: `forge issue ready --input '{}'` (ranked by priority label), `forge issue stale --input '{}'`, then `forge issue show --input '{"id":"<id>"}'` for your slice.
2. PRs: `gh pr view <n> --json state,headRefOid,mergeStateStatus,statusCheckRollup,reviewDecision`. In T3 Code, `list_thread_pull_requests` lists the PRs linked to this thread.
3. Act only on what changed since your last push, then stop. Forge never watches: the harness wakes you (T3 `watch_pull_request`, Claude Code Monitor or `/loop`).

## Roles

- **Orchestrator**: intake, slicing, review triage, merge, verify, re-plan.
- **Worker**: one build or one fix batch on one claimed slice. Stops at push. Never merges.
- One agent may hold both on small work.

## Steps and their skill

| Step                                     | Skill     |
| ---------------------------------------- | --------- |
| 1 intake, 2 frame, 3 slice               | `slice`   |
| 4 claim and workspace, 5 build, 6 check  | `build`   |
| 7 open PR                                | `open-pr` |
| 8 review triage (each wake while open)   | `review`  |
| 9 merge, 10 verify, 11 learn and re-plan | `land`    |

## Two links, never mixed

- **PR to issue** is Forge's: `forge issue link --input '{"id":"<slice>","relation":"delivers","url":"<pr url>"}'`. It needs the held claim, so the worker links before it releases.
- **PR to agent thread** is the harness's: T3 `link_pull_request`, then `watch_pull_request`. Plain CLIs have no thread. Forge never stores this link.

## Autonomy

Proceed on reversible actions without asking. Stop only for:

- a one-way door: {{values.doors}}. It needs the owner's reply naming that action. Silence or "continue" is not a yes.
- a scope change beyond the slice's done boundary;
- a blocked guard or hook. A block is a stop, never something to route around.

## Lanes

- At most {{values.lanes.max}} workers at once, and {{values.lanes.fullSuiteRuns}} full-suite run at a time.
- A worker silent for {{values.lanes.stallMinutes}} minutes is stalled: read its state and steer it. Never start a second worker on the same slice.
- Roles name capability, not models: orchestrator {{values.roles.orchestrator}}, implementer {{values.roles.implementer}}, reviewer {{values.roles.reviewer}}. The harness picks the model.

## Worker brief

Pass ids, not pasted content. Fill this and nothing more:

```
Slice: <issue id>. Read it with forge issue show; its body is the spec.
End state: <PR open with every check passing | fix batch pushed>.
Stop rule: stop at push. Never merge. Do not merge the base branch unless asked.
Receipts: red, then green, for <named check>; then every check on the final tree.
Session: export FORGE_SESSION=<your task name> before any claim; never use the chat's t3: session.
Adopted decision titles: see below for pagination.
```

Standing rules are adopted decisions. List titles only (no decision text): `forge decision list --input '{"status":"adopted"}'`. While `truncated` is true, repeat with `after` set to the returned `next`: `forge decision list --input '{"status":"adopted","after":<next>}'`, even if a page is empty. Request the adopted text from the owner when needed. Restart from a checkpoint (`forge issue comment` on the slice).
