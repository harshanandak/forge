# Forge v3 — Release Plan

**Date**: 2026-04-29
**Status**: Canonical release roadmap. Replaces the W0–W5 "single MVP" wave framing with version-by-version releases (v3.0 → v3.1 → v3.2 → v3.3+).
**Companions**: [FINAL-THESIS.md](./FINAL-THESIS.md) · [locked-decisions.md](./locked-decisions.md) (D39)

---

## Why versioned releases

The W0–W5 wave plan answered "what order do we build it." It did not answer "what does each shippable version promise the user." Versioned releases answer the second question: each version has a customer-facing pitch, a bounded scope, and a cumulative timeline. A user can adopt v3.0 and gain value without waiting for v3.1.

---

## v3.0 — "Forge protects you AND follows you"

**Pitch**: Project memory and planning rigor your agent harness lacks — install once and your agent gets a spine, a memory, and a 3-harness translator on day one.

**Cumulative timeline**: ~5–6 weeks (solo MVP).

**Scope**:

| Area | Deliverable |
|---|---|
| L1 rails | 5 rails enforced (TDD intent, secret scan, branch protection, signed commits, schema + integrity incl. Protected Path Manifest) |
| Memory | Beads-backed memory via `bd remember` / `bd recall`; local Dolt in `embedded` mode (D30) |
| Lifecycle | `forge init` / `forge migrate` / `forge upgrade` / `forge rollback` |
| Recap | `forge recap --since=yesterday` (solo mode only) |
| Merge hook | `/merge` ships as continuous PR-state hook (D28/D33) |
| Harnesses | **MANDATORY full 3-harness translator**: Claude Code + Cursor + Codex CLI (D15) |
| Skills | Auto-invoke via description match (Hermes-style, D35) across all 3 harnesses |
| `/plan` | Basic 1-tier (intent + lock) — optional per D34 |
| `/build` (`/dev`) | Basic TDD loop (no evaluator orchestrator yet) |

**What defers to v3.1+**: iteration-driven 3-tier `/plan`, `forge insights` pattern detector, evaluator orchestrator inside `/dev`, typed memory API surface, team mode.

---

## v3.1 — "Forge plans with rigor"

**Pitch**: Planning becomes a tier system — quick fixes skip ceremony, project-level work runs full critic loops until convergence.

**Cumulative timeline**: ~9 weeks total (~+3 weeks on top of v3.0).

**Scope**:

- Iteration-driven `/plan` with 3 tiers (quick / standard / deep) per `iteration-driven-planning-skill.md`
- Classification auto-detect (bug-tiny → quick, project-level → deep)
- Parallel critics in deep mode (anti-architect / gap-finder / sequencer)
- Supersedes-tracked decisions ledger (the pattern this folder uses, productized)
- Continuous learning loop ON: `forge insights` pattern detector reads `bd audit`, surfaces ≥5-occurrence sequences as skill proposals
- `/build` (formerly `/dev`) gains evaluator orchestrator: test + spec-compliance + lint judges run in parallel inside the implementer loop

**What defers to v3.2+**: team-mode recap, team patches, bidirectional log↔docs, sandboxed agents.

---

## v3.2 — "Forge for teams"

**Pitch**: Memory and patches that aggregate across team members without forcing one workflow on the whole team.

**Cumulative timeline**: ~11 weeks total (~+2 weeks on top of v3.1).

**Scope**:

- `forge recap --team` aggregates digests across team members
- Team patches: per-user overlays at `~/.forge/profile/patches/<project>.md` plus a shared `team-patch.md` in the repo (D5 productized)
- Bidirectional agent-log ↔ docs links (clicking a `docs/plans/*.md` decision shows originating audit events; clicking an audit event shows downstream doc)
- `bd audit upstream --meta-json PR` (Plan A) or `.forge/log.jsonl` fallback (Plan B per D25)
- Docs-as-memory: 7-category navigation surfaced in `forge recap` and `forge insights`

**What defers to v3.3+**: ecosystem expansion, `/forge map-codebase`, profile sync server, marketplace beyond seed.

---

## v3.3+ — Ecosystem

**Pitch**: Forge as a platform — more harnesses, more discovery surface, more self-improvement.

**Scope (unbounded, prioritized later)**:

- Cline / OpenCode / Kilo Code translators (was D15 deferral)
- Marketplace expansion beyond seed allowlist
- `/forge map-codebase` (forge-besw.13)
- Profile sync (forge-besw.16) — git-backed first, optional server later
- Skill self-improvement (auto-tune trigger keywords from acceptance/rejection signal)
- Full evaluator suite (security judge, performance judge, accessibility judge)
- Hardened sandbox support (D32 deferral)

---

## Dependency graph

```
v3.0  ─┬─→ v3.1 ─┬─→ v3.2 ─→ v3.3+
       │         │
       │         └─ requires v3.0 typed-memory backends + bd audit integration
       └─ requires 3-harness translator working before plan-tiering can be cross-harness
```

v3.1 cannot start until v3.0's `bd audit` integration is green (Plan A) or D25 fallback is wired (Plan B). v3.2 cannot start until v3.1's pattern detector produces stable proposals. v3.3+ items have no hard ordering; ship as demand surfaces.

---

## Gate criteria per version

Each version ships only when its gates pass. Failing a gate triggers the relevant D38 kill-criteria check before slipping the version.

| Version | Gates |
|---|---|
| **v3.0** | (a) `forge migrate --dry-run` green on this repo; (b) all 3 harnesses render one skill; (c) `bd audit record` integration passes benchmark OR D25 fallback wired; (d) `forge recap --since=yesterday` produces a usable digest; (e) `/merge` hook fires correctly on PR-ready transitions. |
| **v3.1** | (a) `/plan` 3-tier classification correctly auto-detects on a 10-issue eval set; (b) `forge insights` proposes ≥1 valid skill from this repo's audit log; (c) evaluator orchestrator catches a planted spec violation in eval. |
| **v3.2** | (a) `forge recap --team` round-trips across two simulated team members; (b) team-patch + per-user-overlay merge resolves correctly with no L1 violations; (c) bidirectional link round-trips on a sample decision. |
| **v3.3+** | Per-feature; no version-level gate. |

---

## Source

This plan is locked as **D39** in [locked-decisions.md](./locked-decisions.md). The earlier "Wave 0–5 single MVP" framing in `v3-redesign-strategy.md §6 Option C` and `FINAL-THESIS.md §8` is superseded by this versioned plan; W0–W5 wave breakdowns are retained inside v3.0 as the build sequence.
