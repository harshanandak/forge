---
name: forge-intake
description: "Use when an intent is vague or decisions block framing a slice. Research facts, resolve decisions in rounds, and hand a settled map to slice."
disable-model-invocation: false
---

# forge-intake

This prevents building on a definition the repository contradicts, or waiting on the user for a fact the agent can check.

## Map

Create an intent issue with `forge issue create` if none exists, then read it and linked context. Keep its map on that issue: Destination, Decisions so far, Not yet specified, Out of scope. Track each decision's prerequisites and status. Assign stable ids D1, D2, and so on when discovered; never renumber or reuse them across rounds or resumes.

## Facts before decisions

Facts are the agent's job: look them up in code, tools or primary sources, or dispatch a subagent. Never ask the user for a fact you can investigate. A pending investigation blocks only its dependent decisions; continue with the others.

Before dispatching any subagent, run `forge route get <role> --text` for its role and use the line it prints to select the dispatch. This is intake's one dispatch rule.

## Rounds

1. Find every open decision whose prerequisites are settled. Ask all of them in this round; defer decisions that depend on an unanswered question or pending fact.
2. Number each by its stable id, give a short title and recommendation with the reason, and word the question so "yes" accepts the recommended answer. For example: `D1 — Scope: Shall we deliver the command first? Recommended: yes, to prove the smallest useful path.`
3. In an attended run, wait for answers. A bare "yes" accepts all recommendations in the current round; a reply naming ids applies only to those decisions. Keep unanswered decisions open. Silence is not an answer.
4. Record answers under their existing ids, recompute prerequisites and repeat. If an answer changes, reopen only affected decisions and work; keep their ids.

In an unattended or delegated run, take the recommended answers and continue rounds. List every such answer by id, recommendation and reason in the digest, so the user can override it and rerun only affected parts. This does not authorize one-way doors.

## Handoff

Finish only when no open decision or pending fact remains, including blocked branches. Show the settled map and answer digest. In an attended run, get confirmation of the shared understanding. Then route to `slice` for framing and slicing.
