---
name: forge-loop
description: "Route or resume delivery from fresh state."
disable-model-invocation: true
---

# forge-loop

Every wake is a fresh read: read, route, then stop. Read the chosen skill before acting.

## Wake

T3 chats: call MCP `t3_thread_configuration` once (no args) and set `FORGE_SESSION=t3:<threadId>` for every forge command, even after a harness switch. Workers you launch keep their own task session.

At session start, run `forge memory rules` unless a hook supplied it: `result.text.text` is a pointer, never note text. Search memory before starting a task; use its search/show commands.

1. Work: `forge issue ready --input '{}'` (ranked by priority label), `forge issue stale --input '{}'`, then `forge issue show --input '{"id":"<id>"}'` for your slice.
2. PRs: `gh pr view <n> --json state,headRefOid,mergeStateStatus,statusCheckRollup,reviewDecision`. In T3 Code, `list_thread_pull_requests` lists the PRs linked to this thread.
3. Act only on what changed since your last push, then stop. Forge never watches: the harness wakes you (T3 `watch_pull_request`, Claude Code Monitor or `/loop`).

## Roles

- **Orchestrator**: intake, slicing, review triage, merge, verify, re-plan.
- **Worker**: one build or one fix batch on one claimed slice. Stops at push. Never merges.
- One agent may hold both on small work.

## Steps and their skill

| Step                                               | Skill          |
| -------------------------------------------------- | -------------- |
| 1 intake, vague intent or unresolved decisions     | `forge-intake` |
| 2 frame, 3 slice after intake                      | `slice`        |
| 4 claim and workspace, 5 build, 6 check            | `build`        |
| 7 open PR                                          | `open-pr`      |
| 8 review triage, red PR on each wake               | `review`       |
| 9 merge, 10 verify, 11 learn and re-plan; red base | `land`         |

## Two links, never mixed

- **PR to issue** is Forge's: `forge issue link --input '{"id":"<slice>","relation":"delivers","url":"<pr url>"}'`. It needs the held claim, so the worker links before it releases.
- **PR to agent thread** is the harness's: T3 `link_pull_request`, then `watch_pull_request`. Plain CLIs have no thread. Forge never stores this link.

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

Pass ids; fill this brief:

```
Slice: <issue id>. Read it with forge issue show; its body is the spec.
End state: <PR open with every check passing | fix batch pushed>.
Stop rule: stop at push. Never merge. Do not merge the base branch unless asked.
Receipts: red, then green, for <named check>; then every check on the final tree.
Session: export FORGE_SESSION=<your task name> before any claim; never use the chat's t3: session.
Adopted decision titles: see below for pagination.
```

Standing rules are adopted decisions. List titles only (no decision text): `forge decision list --input '{"status":"adopted"}'`. While `truncated` is true, repeat with `after` set to the returned `next`: `forge decision list --input '{"status":"adopted","after":<next>}'`, even if a page is empty. Request the adopted text from the owner when needed. Restart from a checkpoint (`forge issue comment` on the slice).
