---
name: forge-intake
description: "Use when an intent is vague or decisions block framing a slice. Research facts, resolve decisions in rounds, and hand a settled map to forge-cut."
disable-model-invocation: false
---

# forge-intake

This prevents building on a definition the repository contradicts, or waiting on the user for a fact the agent can check.

## Steps

1. Create an intent issue with `forge issue create` if missing. Read it and linked context. Keep its map there: Destination, Decisions so far, Not yet specified, Out of scope. Track each decision's prerequisites and status.
2. Investigate facts in code, tools or primary sources, or dispatch a subagent. A pending investigation blocks only its dependent decisions; continue with the others. Before dispatch, run `forge route get <role> --text` and use its line to select the route; run `forge issue call <intent> --role <role>`. Retry REVISION_CONFLICT. Pass returned timeboxMinutes and stopBy.
3. Read [prototype.md](prototype.md) when only running code can answer a question. Name the question first.
4. Read [rounds.md](rounds.md) when decisions are ready to ask or an answer changes.
5. Show the settled map and answer digest. In an attended run, get confirmation of the shared understanding. Then route to `forge-cut` for framing and slicing.

## Hard rules

- Never ask the user for a fact you can investigate.
- Assign stable ids D1, D2 and so on when discovered; never renumber or reuse them across rounds or resumes.
- On LIMIT_REACHED stop and report. Tell the subagent to stop and report the checkpoint when timeboxMinutes expire, never later than stopBy.
- A prototype uses at most one session and 300 lines, with no tests or polish. A prototype never merges; port its decision into a slice.
- In an attended run, wait for answers and keep unanswered decisions open. Silence is not an answer. Unattended recommendations do not authorize one-way doors.
- Finish only when no open decision or pending fact remains, including blocked branches.

## Read on demand

- [rounds.md](rounds.md): Question rounds, answer changes and the digest.
- [prototype.md](prototype.md): Prototype workspace, evidence and handoff.
