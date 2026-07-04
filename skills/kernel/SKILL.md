---
name: kernel
description: >
  Forge kernel surface — the umbrella index for working in a Forge project. Use
  at the start of any session and whenever you need to orient: it routes to the
  per-stage workflow skills (plan, dev, validate, ship, review, verify,
  plus status, research, rollback, sonarcloud, shepherd) and the kernel-native
  skills (triage-ready, issue-basics), and documents the day-to-day issue, board,
  and orientation verbs of the `forge` CLI. Trigger on
  "what's the workflow", "what should I work on", "forge issues", "claim an
  issue", "project status", "orient", or when deciding between Forge issues and
  an ad-hoc TodoWrite list.
allowed-tools: Read, Bash(forge:*)
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

### B — Memory / knowledge (planned)

`forge remember` / `forge recall` / `forge knowledge search` are roadmap items —
they are **not on the CLI yet**. Do not invoke them; record durable decisions as
issue comments (`forge comment`) until the memory verbs land.

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
