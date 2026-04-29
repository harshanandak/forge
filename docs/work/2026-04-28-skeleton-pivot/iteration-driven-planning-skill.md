# Iteration-Driven Planning — the canonical Forge `/plan` skill

**Date**: 2026-04-29
**Status**: Skill design proposal — captures the meta-pattern this very session used to produce 38 locked decisions across 6 iterations
**Companions**: [FINAL-THESIS.md](./FINAL-THESIS.md) · [locked-decisions.md](./locked-decisions.md) · [LEARNINGS.md](./LEARNINGS.md)

---

## Concept

The 6-iteration planning method that produced this folder — parallel critics, research validation, anti-architect cuts, edge-case audits, quality-vs-speed tradeoffs, supersedes-tracked decisions — **IS the product Forge should ship as the `/plan` skill**.

This session is the proof-of-concept. ~30 design docs, ~38 decisions, multiple supersedes, sharp final thesis from messy starting prompts. The method generalizes; the artifacts compound.

> **Forge `/plan` is not "ask questions and write a doc." It is a structured iteration loop with parallel critics, research validation, and supersedes-tracked decisions that converges on a falsifiable thesis.**

---

## The 5 phases (HARD-GATEd, user-configurable depth)

```
Phase 1: Intent capture        ┐
Phase 2: Parallel research     │  iterate until convergence
Phase 3: Parallel critics      │  (or hit max-iteration cap)
Phase 4: Synthesis + iterate   ┘
Phase 5: Final thesis lock     ──── exit gate
```

### Phase 1 — Intent capture (Q&A, one question at a time)

Surface the design intent. **One question at a time** — no batching. Each question targets the highest-information-gain ambiguity remaining. The output is a structured intent statement: what we're building, why, who it's for, what success looks like, what's out of scope.

- HARD-GATE: cannot proceed to Phase 2 without intent statement signed off by user.
- Anti-pattern: "let me ask 8 questions at once and you can answer in any order" — produces shallow context and skipped questions.
- Skill mechanic: maintain an open-question queue; ask the top one; integrate the answer; recompute the queue.

### Phase 2 — Parallel research (fan-out to evidence sources)

For every claim in the intent statement, fan out to research agents in parallel:
- **Web/docs research** (Parallel AI, Context7) — what does the literature/SDK actually say?
- **Codebase research** (grep/glob/Read) — what does our code already do?
- **Primary-source verification** — does the cited URL/file/line actually contain the claimed fact?

**Research validation pattern**: Every claim must cite a primary source. "I think X" without citation is rejected. The researcher returns: claim → source → confidence → quote.

- HARD-GATE: every load-bearing claim cites a primary source before Phase 3.
- Anti-pattern: reconstructing facts from memory or earlier conversation summaries.

### Phase 3 — Parallel critics (different lenses, no overlap)

Three named critic roles run **in parallel**, each with a non-overlapping mandate:

1. **Anti-architect** — "What if we built less?" Force every component to justify itself; propose the version with 30%/50%/80% cuts; ask which cut survives.
2. **Gap-finder** — "What did we miss?" OWASP, edge cases, failure modes, kill criteria, "what happens when this dependency disappears."
3. **Sequencer** — "What's the dependency graph?" Order the work; identify the load-bearing track; surface synthetic boundaries that produce stale state.

Optional additional critics (project-configurable):
- **N=1 viability test** — does this work for a solo user with no team and no users? (Forge's `n1-survival-audit.md` is a worked example.)
- **Future-proof filter** — if dependency D disappears, does the product still work?
- **Quality-vs-speed auditor** — for each cut/keep decision, is the quality investment protecting the moat or a workflow opinion?

- HARD-GATE: each critic produces a structured verdict (verdict + evidence + recommended action) before Phase 4.
- Anti-pattern: one critic with overlapping mandates — produces redundant findings and misses orthogonal lenses.

### Phase 4 — Synthesis + iteration loop

Fold critic feedback. Three exit paths from Phase 4:

- **Converged** (critics agree, no new evidence) → Phase 5.
- **Diverged** (critics produced contradictions) → re-run Phase 2/3 on the contested claim only; iterate.
- **Scope shift** (critics revealed an upstream miss) → revise intent statement; iterate from Phase 1.

**Convergence criterion**: critics produce no new actionable findings on a fresh pass, or the highest-stakes critic explicitly signs off. Default cap: 3 iterations; configurable per project.

- HARD-GATE: cannot reach Phase 5 without an explicit convergence statement.
- Anti-pattern: "iterate forever until the doc feels good" — produces the iteration trap. Forge `/plan` ships with a convergence threshold.

### Phase 5 — Final thesis lock

Lock decisions with **supersedes tracking**:
- Every decision gets an ID (D1, D2, …).
- Decisions point at predecessors via `SUPERSEDED-BY-Dxx` or `REVISED-BY-Dxx`.
- Original phrasing is preserved for audit; the supersede note explains the change.
- A single canonical doc (FINAL-THESIS) is generated; all prior framings are preserved in the iteration history.

Output artifacts:
1. `locked-decisions.md` — Dxx ledger with rationale + tradeoff + anti-decision per entry.
2. `FINAL-THESIS.md` — canonical "where we ended up" doc.
3. `LEARNINGS.md` — meta-takeaways from the iteration journey.
4. `_iteration-history/` — superseded design docs preserved with breadcrumb to FINAL-THESIS.

---

## Classification-aware planning intensity (the central feature)

**The 5-phase method MUST scale to the work.** Running full critic loops + multiple iterations on a 5-line bug fix is theater. Skipping research on a complex migration is dangerous. The iteration-driven method's power is **configurable depth**, not maximum depth.

This session itself was `project-level` — and 6 iterations were warranted. A typo fix should not be 6 iterations.

### Classification × phase intensity matrix

| Classification | Phase 1 (intent) | Phase 2 (research) | Phase 3 (critics) | Phase 4 (iterate) | Phase 5 (lock) | Time estimate |
|---|---|---|---|---|---|---|
| `bug-tiny` (typo, lint fix) | minimal Q&A | skip | skip | skip | quick lock | **2 min** |
| `bug-standard` | light | targeted | skip | skip | lock | **10 min** |
| `feature-small` | standard Q&A | standard | 1 critic | skip if convergent | lock | **30 min** |
| `feature-large` | full Q&A | parallel research | 3 parallel critics | 1–2 iterations | full thesis | **1–2 hrs** |
| `project-level` | deep Q&A | extensive research | 4–5 critics | unbounded until convergence | canonical thesis | **half-day to days** |
| `refactor` | impact-Q&A | heavy on existing-code research | gap-finder + sequencer | iterate on impact analysis | lock w/ migration plan | **30–60 min** |
| `research-spike` | light Q&A | dominant Phase 2 | skip | skip | "needs follow-up plan" output | **30–90 min** |
| `migration` | risk-Q&A | research old + new | full critics + backwards-compat critic | iterate | full thesis w/ rollback plan | **2–4 hrs** |
| `docs` | minimal | targeted | skip | skip | quick lock | **5–15 min** |
| `hotfix` | risk-Q&A only | skip | skip (or 1: anti-architect "is fix minimal?") | skip | lock w/ rollback plan | **5 min** |

### User configurability

```bash
forge plan --type=<classification>     # explicit selection
forge plan --force-full                # override to maximum (unfamiliar bug, paranoid mode)
forge plan --force-minimal             # override to bare minimum (prototyping, speed)
```

`.forge/config.yaml` pins defaults per project:

```yaml
plan:
  default-classification: feature-small        # auto-detected unless overridden
  classification-defaults:
    bug-tiny:        { phases: [intent, lock],                              critics: [],                              cap: 0 }
    bug-standard:    { phases: [intent, research, lock],                    critics: [],                              cap: 0 }
    feature-small:   { phases: [intent, research, critics, lock],           critics: [anti-architect],                cap: 1 }
    feature-large:   { phases: all,                                         critics: [anti-architect, gap-finder, sequencer], cap: 2 }
    project-level:   { phases: all,                                         critics: [anti-architect, gap-finder, sequencer, n1, future-proof], cap: -1 }
    refactor:        { phases: all,                                         critics: [gap-finder, sequencer],         cap: 2 }
    research-spike:  { phases: [intent, research, lock],                    critics: [],                              cap: 0 }
    migration:       { phases: all,                                         critics: [anti-architect, gap-finder, sequencer, backwards-compat], cap: 3 }
    docs:            { phases: [intent, lock],                              critics: [],                              cap: 0 }
    hotfix:          { phases: [intent, lock],                              critics: [anti-architect],                cap: 0 }
  research-validation: required          # primary-source citation required when Phase 2 runs
  manual-override: true                  # humans can force-advance / force-iterate at any gate
```

Security-critical projects can pin every classification to `full-critics` mode (e.g., a payments codebase always runs the full critic set even on `bug-tiny`).

### Auto-detect classification

Forge picks a default classification using cheap heuristics:

- **Beads issue type** — if matched issue has `type=bug` → default `bug-standard`; `type=feature` → `feature-small`; `type=epic` → `project-level`.
- **Diff size** — `<10 lines changed` → `bug-tiny`; `>5 files touched` → minimum `feature-small`; `>20 files OR a schema/migration file` → minimum `migration`.
- **Path heuristics** — touches `docs/**` only → `docs`; touches `lib/core/**` (L1 surface) → minimum `feature-large`; touches `**/migrations/**` → `migration`.
- **Branch prefix** — `hotfix/*` → `hotfix`; `refactor/*` → `refactor`; `spike/*` → `research-spike`.

Auto-detection is a default. The user can always override with `--type=` or `--force-full` / `--force-minimal`.

### Why this matters

- **Most planning sessions today over-invest** — agents run full critic loops on trivial bugs, producing template-shaped docs that nobody reads. Cost: 30+ minutes of agent time per micro-bug.
- **Some under-invest** — agents skip research on a migration touching 15 files and three services, producing a plan that ships a regression on day 1. Cost: rollback + post-mortem.
- **The iteration-driven method's power is configurable depth**, not maximum depth. Forge `/plan` ships with classification-aware defaults so the average case is right-sized and the user only adjusts at the edges.
- **HARD-GATEs respect classification** — the gates that fire on `project-level` (full critic convergence required before lock) do NOT fire on `hotfix` (skip-to-lock with rollback plan is the gate). One skill, multiple gate profiles.

This is NOT an additional feature on top of `/plan` — it is **how `/plan` actually works**. Without classification-aware intensity, the iteration-driven method is unusable for anything smaller than `project-level`.

---

## Per-classification configuration surface (legacy reference)

Older single-config form (kept for reference; superseded by the matrix above):

```yaml
plan:
  phases: [intent, research, critics, synthesis, lock]   # skip any
  critics: [anti-architect, gap-finder, sequencer]        # add: n1, future-proof, qvs
  convergence-threshold: 2                                # max iterations
  research-validation: required                           # primary-source citation required
  manual-override: true                                   # human can force-exit at any phase
```

Manual override at every gate: humans can force-advance, force-iterate, or force-revise from any phase. The skill HARD-GATEs are defaults, not prisons.

---

## Key elements (the load-bearing parts)

### The supersede model

Decisions are append-only with explicit pointers. D11 says "lock 6-harness target" and is annotated `SUPERSEDED-BY-D15`. D15 says "3-harness target." Both are visible. The audit trail shows *why* the change happened (Cursor capability spike, ecosystem audit). This produces three properties:
- **Reversibility** — "we tried 6 harnesses; here's why we cut to 3" survives forever.
- **No silent rewrites** — earlier framings cannot disappear without leaving a breadcrumb.
- **Iteration legibility** — newcomers can trace the design trajectory.

### The iteration converges criterion

A planning session ends when one of these fires:
- All critics produce zero net-new findings on a fresh pass.
- The highest-stakes critic (default: anti-architect) explicitly signs off.
- The configured iteration cap is hit (default: 3).
- The user manually forces Phase 5 entry.

Without an explicit criterion, iteration is unbounded. This was the iteration trap that nearly killed v3 planning at iteration #6.

### Parallel-critic dispatch (different lenses, no overlap)

Critics run in parallel because they have non-overlapping mandates. Anti-architect cuts; gap-finder discovers; sequencer orders. Running them sequentially leaks anchoring bias from one to the next. Running them parallel forces orthogonal coverage.

### Research-validation pattern

Every load-bearing claim cites a primary source (URL, file:line, paper, RFC). Reconstruction-from-memory is rejected. This is the single pattern that catches the most expensive errors: "Beads migrated to Supabase" was a memory reconstruction; the primary source (CHANGELOG) said Dolt.

### Anti-architect role

Forces simplification. Every iteration runs an anti-architect pass that asks: "What if we deleted half of this?" The answer is rarely "all of it" but is almost always "more than the producer first thought." Three anti-architect passes in this session produced D32 (sandboxing descope), D36 (single backend), D37 (8-week instead of 10-week).

### Future-proof filter

For every external dependency: "If this dep disappears or changes, can the product still work?" Beads passes (D21 IssueAdapter escape hatch). Vector embeddings would not have (D24 rejection). Apply the filter before adopting; document the escape hatch.

### N=1 viability test

Does this work for one user with no team? Many architectural choices that look good for "imagined teams of 50" fail the N=1 test. Forge passes; multi-team marketplace does not (deferred per template-library doc). Run the test explicitly.

---

## Why this is the right shape for Forge `/plan`

Forge already ships a skeletal `/plan` with three phases. The iteration-driven version generalizes that pattern, makes it falsifiable, and makes the convergence criterion explicit. Three reasons to ship it:

1. **Self-evidence**: this session produced 38 sharp decisions from messy starting prompts using exactly this method. The method works.
2. **Compounding artifacts**: every iteration produces durable docs (decisions, learnings, FINAL-THESIS). Future sessions read the prior thesis instead of re-deriving.
3. **Fits the typed-memory model (D22)**: decisions/episodes/skills/preferences are exactly the seven categories the memory API already routes — `/plan` is the producer of the high-value entries.

---

## Beads issue concept (flagged for bd-update agent)

> **Forge `/plan` skill: implement iteration-driven planning method as the canonical Forge planning skill (Phase 1–5 with HARD-GATEs and user-configurable depth).**
>
> Implements the meta-pattern documented in `docs/work/2026-04-28-skeleton-pivot/iteration-driven-planning-skill.md`. Scope: Phase 1 intent capture, Phase 2 parallel research with primary-source citation, Phase 3 parallel critics (anti-architect / gap-finder / sequencer), Phase 4 synthesis + iteration loop with explicit convergence criterion, Phase 5 final-thesis lock with supersedes tracking. Configurable per project (`plan.phases`, `plan.critics`, `plan.convergence-threshold`). Acceptance: re-runs this folder's iteration #1 → #6 trajectory and produces a substantively similar D1–D38 ledger from the original starting prompt.

(Not yet created — left for the bd-update agent.)

---

Word count: ~1010
