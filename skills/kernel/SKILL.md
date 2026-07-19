---
name: kernel
description: >
  Forge kernel — umbrella index/router for a Forge project. Reach for this FIRST when
  orienting rather than executing: at session start, when you need the map of how the system
  fits together, or when unsure WHICH skill or `forge` verb a task belongs to. It indexes
  `smith` (end-to-end orchestrator), the stage ladder (plan → dev → validate → ship → review →
  verify), the utility/issue skills, and the day-to-day `forge` CLI verbs. Trigger on "how
  does the Forge workflow work", "which forge command or skill for X", "I'm new here, how is
  Forge set up", or "should this be a Forge issue or a TodoWrite". Index layer only — hand off
  the doing: rank/pick the next ready issue → `triage-ready`; current stage / "where am I" /
  active or stale work → `status`; create/update/close/search one issue → `issue-basics`;
  claim-then-prove ownership before mutating → `claim-safety`; drive one issue from plan to a
  merged PR under gates → `smith`; token-bounded state for the Hermes harness →
  `hermes-forge`.
allowed-tools: Read, Bash(forge:*)
terminal: true
---

# Forge kernel surface

Forge is a TDD-first workflow harness. The agent-facing surface is **skills + the
`forge` CLI** — there are no slash-command files. This umbrella skill is the
entry point: it tells you which stage skill to use and which `forge` verb runs
each day-to-day operation. Every skill is a thin guide over a real `forge`
command; the CLI remains the implementation, the skills are the surface.

## Stage skills (the TDD ladder)

The default workflow is a configurable ladder of per-stage skills. Use the whole
flow when it fits, or invoke an individual stage when the active plan permits a
smaller path.

| Stage | Skill | Purpose |
|-------|-------|---------|
| utility | `status` | Check current context, active work, recent completions |
| 1 | `plan` | Design intent → research → branch + worktree + task list |
| 2 | `dev` | Subagent-driven TDD per task (implementer → spec → quality review) |
| 3 | `validate` | Type check, lint, code review, security, tests — all fresh output |
| 4 | `ship` | Push branch and open the PR with design-doc reference |
| 5 | `review` | Address ALL PR feedback (GitHub Actions, Greptile, SonarCloud) |
| 6 | `verify` | Post-merge health check (CI on main, close issues) |

**Pre-merge gate** (not a numbered stage): before merge, finish the doc updates on
the feature branch and confirm CI is green, then hand off the PR for manual merge.
The gate is embedded in `ship` and `review` — it is not a standalone skill.

Utility skills outside the linear ladder: `research` (deep web research),
`rollback` (safe revert operations), `sonarcloud` (code-quality queries),
`shepherd` (cross-harness PR monitoring).

Procedure skills (reusable operations any stage/agent embeds): `claim-safety`
(claim an issue and PROVE you own the lease via `forge issue owns <id>` before
mutating it — a claim returning ok:true does not by itself prove ownership).

```
status → plan → dev → validate → ship → review → verify
```

### Chain map (each skill declares its successor)

Every skill carries chain metadata in its frontmatter (`next`, `terminal`,
`subskills`, `handoffs`) plus a HARD-GATE chain line in its body, so each stage
announces the next one. The linear ladder:

| Skill | `next` | terminal |
|-------|--------|----------|
| `plan` | `dev` | no (composes `research`) |
| `dev` | `validate` | no |
| `validate` | `ship` | no |
| `ship` | `review` | no (handoff → `shepherd`) |
| `review` | `verify` | no (handoff → `shepherd`) |
| `verify` | — | **yes (terminal)** |

Feeders into the chain: `triage-ready` → `claim-safety` → `dev` (rank the pick,
prove the live lease, then work it). `research` is standalone / callable
mid-workflow and returns to its CALLER (no forced `next`); it is also a `subskill`
of `plan`. The `smith` orchestrator composes the six stages (`subskills`).
Utility/terminal skills (`status`, `shepherd`, `kernel`, `issue-basics`, `memory`,
`rollback`, `research`, `sonarcloud`, `sonarcloud-analysis`,
`parallel-deep-research`, `using-forge`) declare no forward-stage `next`. Meta
skills (`hermes-forge`) are chain-exempt.

The stage `next` values above are the DEFAULT / critical-path successors. The
actual successor after `ship`, `review`, and `verify` is
classification-dependent — the authoritative matrix is `lib/workflow/stages.js`
(Simple/Hotfix/Refactor end at `ship`; Standard ends at `review`; Critical runs
through `verify`; the `docs` classification reuses `verify` → `ship`).

## Orchestrator super-skill

`smith` is the flagship: a thin orchestrator that COMPOSES the skills above into
the right path for a piece of work — pick (`triage-ready`) → claim
(`claim-safety`) → `plan` → `dev` → `validate` → `ship` → `review` → `verify` —
driving autonomously between human gates and pausing AT them. The human gates are
durable kernel EVENTS (`forge gate check|approve|reject|status <issue> <gate>`;
gates `gate.intent` · `gate.plan-approval` · `gate.merge`), so a gated run is
resume-safe across compaction. During planning `smith` calibrates how many gates
the work needs from its size × importance × complexity and proposes that tier at
the intent gate (the human confirms or overrides). Reach for `smith` to run a
whole issue end to end under human control; invoke an individual stage skill to
run a single step.

## Kernel-native skills

Read-and-repair skills that work directly against the kernel's issue store. They
complement the ladder: reach for them to decide *what* to do and to run the
everyday issue operations, then route into a stage skill to execute.

| Skill | Purpose |
|-------|---------|
| `triage-ready` | Read-only "what should I work on" — ranks and *explains* the ready queue via `forge issue ready` / `blocked` / `stats` (never `board`), then hands off the pick. |
| `issue-basics` | The everyday CRUD floor — create/update/claim/release/comment/close/show/list/search/stats over the `forge issue` verbs, plus the label/reopen/delete disposition for teams migrating in. |

## Day-to-day verbs (the `forge` CLI)

The kernel verbs are the operations you reach for inside any stage — find work,
claim it, fix in place, query the board, orient. They are grouped in four
families. Run them through Bash; never hand-edit the issue store.

### A — Issue lifecycle (the core loop)

| Need | Command |
|------|---------|
| Find ready work | `forge ready [--json]` |
| Inspect an issue | `forge show <id> [--json]` |
| List / filter issues | `forge list [--status …] [--json]` |
| Create an issue | `forge create --title "…" --type <feature\|bug\|task>` |
| Claim work (DB-enforced lease) | `forge claim <id>` |
| Prove you own the lease | `forge issue owns <id>` — exit 0 iff you hold the live lease (see the `claim-safety` skill) |
| Release a claim | `forge release <id>` |
| Update fields | `forge update <id> --priority <n>` (etc.) |
| Add a handoff comment | `forge comment <id> "…"` |
| Close an issue | `forge close <id> --reason "…"` |
| Dependencies | `forge issue dep add\|remove <id> <id>` |
| Search / stats | `forge issue search "…"` · `forge issue stats` |
| Blocked work | `forge blocked` |

### B — Memory / knowledge

`forge remember <note> [--tag <label>]... [--json]` and `forge recall` are live —
they persist and retrieve project-memory notes from a file-backed store. Only
`forge knowledge search` is not on the CLI yet; until it lands, capture durable
decisions as `forge remember` notes or issue comments (`forge comment`).

### C — Board / planning / admin

| Need | Command |
|------|---------|
| Team board | `forge board [--json]` |
| Export the issue projection | `forge export [--import]` |
| Release-readiness gate | `forge release check --target <ref>` |
| Sync team state | `forge sync` |

### D — Orientation / session

| Need | Command |
|------|---------|
| Prime a session | `forge prime [--json]` |
| Full orientation | `forge orient [--json]` |
| Recap an issue / context | `forge recap [<id>] [--json]` |

## Forge issues vs. TodoWrite — decision table

| Situation | Use |
|-----------|-----|
| Work spans sessions, has blockers, or needs recovery after compaction | **Forge issues** (`forge create`/`claim`/`close`) |
| Cross-agent or cross-worktree coordination | **Forge issues** (DB-enforced leases) |
| Durable decisions, design rationale, handoff notes | **Forge issue comments** |
| Ephemeral, single-session checklist for the current task | **TodoWrite** |
| Steps you will finish and discard within this turn | **TodoWrite** |

When in doubt, prefer a Forge issue: it survives the session and is visible to
the team. TodoWrite is for scratch tracking only.

## Session protocol

1. **Orient first.** Start with the `status` skill (or `forge prime` /
   `forge orient`) — never reconstruct project state from raw files.
2. **Claim before you build — then prove it.** `forge claim <id>` takes the lease;
   one issue at a time. A claim's ok:true does not by itself prove ownership, so
   confirm with `forge issue owns <id>` before working and again before
   `close`/`release` (the `claim-safety` skill). `forge release <id>` if you abandon it.
3. **Work the ladder.** `plan` → `dev` → `validate` → `ship` → `review` →
   `verify`, skipping stages only when the plan allows. The pre-merge doc gate
   runs inside `ship` and `review` before merge — it is not a separate stage.
4. **Record evidence as you go.** Progress and decisions go to
   `forge comment <id> "…"`, not to memory.
5. **Hand off cleanly.** Close completed issues (`forge close <id> --reason …`)
   and `forge sync` so the team sees the result.

## Core principles

- **TDD-first** — write tests before implementation (RED → GREEN → REFACTOR).
- **Research-first** — understand before building; document decisions.
- **Security built-in** — OWASP Top 10 analysis for every feature.
- **Documentation progressive** — update at each stage, verify at the end.
