# Forge v3 — FINAL THESIS

**Date**: 2026-04-29
**Status**: Canonical "where we ended up" document, supersedes all earlier framings in this folder
**Companions**: [locked-decisions.md](./locked-decisions.md) · [LEARNINGS.md](./LEARNINGS.md) · [v3-redesign-strategy.md](./v3-redesign-strategy.md)

---

## 1. Executive summary

> **Forge is invisible infrastructure for AI coding agents. Install once; your agent gets a memory, a spine, an iteration loop, and a skill library that auto-activates whenever it's needed. Bring your own planner, deploy script, and review tools — Forge enhances them. Skills are the product; the runtime is the floor.**

Forge v3 ships as a skeleton — five locked rails, five swappable stages, one continuous merge hook, a typed memory API, and an auto-invoking skill library — that wraps the agent harness you already use (Claude Code, Cursor, Codex CLI) without forcing a workflow. The runtime is the floor. The skill library is what you actually buy.

---

## 2. The 3-tier architecture

```
┌──────────────────────────────────────────────────────────────────┐
│  HARNESSES (parallel manifests, sync via scripts/sync-commands)  │
│  Claude Code (.claude/)  ·  Cursor (.cursor/)  ·  Codex (.codex/)│
├──────────────────────────────────────────────────────────────────┤
│  SKILLS (the product) — auto-invoked via description match       │
│  .claude/skills/*  ·  .forge/extensions/local/<slug>/SKILL.md    │
│  Hermes-style trigger: keyword → skill activation                │
├──────────────────────────────────────────────────────────────────┤
│  RUNTIME (the floor) — typed memory + 5 stages + 5 L1 rails      │
│  forge.remember/recall  ·  /plan /dev /ship /review /verify      │
│  /merge as PR-state hook  ·  Beads as graph + audit substrate    │
└──────────────────────────────────────────────────────────────────┘
```

Three tiers, three responsibilities. **Harnesses** are how the user's agent talks to Forge — same skill renders three ways via parallel manifests. **Skills** are the product — accumulated, auto-invoked, user-owned playbooks that compound across sessions. **Runtime** is the invisible spine — typed memory, stage gates, L1 rails, agent-action audit. A user feels skills directly, harnesses transparently, and runtime never (except when it refuses an unsafe action).

---

## 3. The 5 L1 rails (final list)

L1 is what Forge stands for. Cannot be overridden by L2/L3/L4. If you don't want these, you don't want Forge.

1. **TDD intent gate** — every source file has a corresponding test (D16: stays L1 even though stage gates demote to L2).
2. **Secret scan** — pre-commit and pre-push refuse credentials/keys (already shipped via Lefthook).
3. **Branch protection** — direct push to `main`/`master` blocked (already shipped via Lefthook).
4. **Signed commits** — `commit.gpgsign` enforced on every Forge-managed branch (D3 refuse-with-hint applies).
5. **Schema + integrity** — config schema validation at load + Protected Path Manifest (D19) + checksum-verified `forge_core` paths.

Per D19, the Protected Path Manifest is folded into rail #5 — total rail count stays at five.

---

## 4. The 7 typed memory categories

Per D22 / D24, Forge ships a typed memory API (`forge.remember / recall / forget / compact`) that routes to seven existing backends. No new database. No vector store.

| # | Category | Backend | Lifetime |
|---|---|---|---|
| 1 | **Decisions** (semantic) | `docs/plans/*.md` + SQLite FTS5 | forever (until superseded) |
| 2 | **Session episodes** (episodic) | append-only JSONL → weekly LLM-reflection compactor → `docs/sessions/<date>.md` | rolling 30d |
| 3 | **Skills / playbooks** (procedural) | `.claude/skills/*.md` + trigger index | forever |
| 4 | **Working state** (working) | `.forge/state.json` per worktree | until task complete |
| 5 | **Issue graph** (relational) | Beads (Dolt) | forever |
| 6 | **Audit trail** (raw episodic) | `bd audit record` (per D23) | rolling 7d |
| 7 | **Preferences** (user-pinned) | `CLAUDE.md` / `MEMORY.md` loaded into every prompt | forever, user-editable |

The product surface is the API + the category dimension on writes — not a new datastore.

---

## 5. Final stage model — 5 stages + `/merge` hook

> **`/plan` skill design**: The planning method this folder used through 6 iterations is documented as the canonical Forge `/plan` skill in [iteration-driven-planning-skill.md](./iteration-driven-planning-skill.md). It defines Phase 1–5 (intent → research → critics → synthesis → lock) with classification-aware intensity (`bug-tiny` skips most phases; `project-level` runs unbounded iterations until critics converge) and supersedes-tracked decisions. This is what `/plan` ships as in v3.

Per D27 / D28 / D29 / D33 / D34:

```
/plan → /dev → /ship → /review → /verify
  (optional, BYO planner OK per D34)
        ↑
        continuous validation lives INSIDE /dev (D27)
                    /merge fires as PR-state hook (D28/D33)
```

- `/plan` — **OPTIONAL** (D34). Bring your own planner if you want; Forge enters `/dev` from any structured task list.
- `/dev` — implementer/spec/quality subagent loop with **continuous validation inside the loop** (D27). The standalone `/validate` command is retained as a manual recovery surface only.
- `/ship` — push + PR creation with auto-filled template.
- `/review` — handle PR feedback (Greptile, SonarCloud, GitHub Actions).
- `/verify` — post-merge health check (CI green on main, close Beads).
- `/merge` — **continuous PR-state hook** (D28/D33). Never typed by humans.

Utility commands (`/status`, `/rollback`, `/sonarcloud`) remain available; they are not stages.

---

## 6. 3-harness target

Per D15 (which superseded D11's 6-harness ambition):

All three harnesses ship in **v3.0** (D39) — none are deferred to v3.1. The 3-harness translator is mandatory in the v3.0 release.

| Harness | MVP (v3.0) | Manifest |
|---|---|---|
| Claude Code | ✅ v3.0 | `.claude/commands/*.md` + `.claude/skills/*.md` |
| Cursor | ✅ v3.0 | `.cursor/rules/*.mdc` + `.cursor/commands/*.md` |
| Codex CLI | ✅ v3.0 | `.codex/` |
| Cline | v3.3+ | (deferred — was v3.1, pushed to ecosystem per D39) |
| OpenCode | v3.3+ | (deferred — was v3.1, pushed to ecosystem per D39) |
| Kilo Code | v3.3+ | (deferred — was v3.1, pushed to ecosystem per D39) |
| PI / Hermes / Aider / Copilot / Roo / legacy `.cursorrules` | dropped | per D13 |

Cross-harness portability is conventional — `scripts/sync-commands.js` already does ~80% of it via parallel manifests. No duplicate runtime per harness.

---

## 7. The 39 locked decisions (one-line summaries)

| ID | Status | Summary |
|----|---|---|
| D1 | ACTIVE | Curated allowlist `forge-marketplace.json` (NOT mirror org) |
| D2 | ACTIVE | Hybrid `patch.md` (single index + auto-extract over 40 lines) |
| D3 | ACTIVE | Refuse-with-hint default + lenient opt-in + L1 always wins |
| D4 | ACTIVE | `AGENTS.md` = generated artifact + lint |
| D5 | ACTIVE | Team patches via per-user overlays |
| D6 | ACTIVE | v2 → v3 migration via explicit `forge migrate` + compat mode |
| D7 | ACTIVE | `forge upgrade` snapshots `.forge/backups/<ts>/` |
| D8 | ACTIVE | Keep N5 (`forge options *` introspection) |
| D9 | ACTIVE | 3 templates at MVP, 2 deferred to v3.1 |
| D10 | ACTIVE | `forge migrate --dry-run` PoC = Wave 0 NO-GO gate |
| D11 | **SUPERSEDED-BY-D15** | (was: lock 6-harness target) |
| D12 | ACTIVE | Adopt agentskills.io as canonical skill format |
| D13 | ACTIVE | Drop active maintenance for PI/Hermes/Aider/Copilot/Roo/legacy Cursor |
| D14 | ACTIVE | 2-week translator work folded into N7 + N10 |
| D15 | ACTIVE | 3-harness MVP: Claude + Cursor + Codex CLI |
| D16 | ACTIVE | Stage HARD-GATEs are L2 default-on; TDD enforcement stays L1 |
| D17 | **REVISED-BY-D23** | (intent stays: capture every agent action; storage moves to `bd audit`) |
| D18 | ACTIVE | `forge insights` mines agent log for pattern-driven skill generation |
| D19 | ACTIVE | Protected Path Manifest enforces L1 rail #5 (no new rail) |
| D20 | ACTIVE | Auto-generated skill ownership matrix (Forge proposes; user accepts) |
| D21 | ACTIVE | IssueAdapter interface as future-proofing; Beads is only implementation |
| D22 | ACTIVE | Typed memory API over existing backends (no new database) |
| D23 | ACTIVE | Use `bd audit record` instead of building parallel NDJSON writer |
| D24 | ACTIVE | Vector stores rejected as primary memory; FTS5 over markdown covers ~90% |
| D25 | ACTIVE (fallback) | Three logs collapse to `.forge/log.jsonl` only if D23 reverts |
| D26 | ACTIVE | `forge new <template>` is the day-one entry point |
| D27 | ACTIVE | `/dev` and `/validate` collapse — continuous validation inside `/dev` |
| D28 | ACTIVE | `/premerge` is NOT a stage; continuous PR-state hook |
| D29 | ACTIVE | Final stage list: 5 stages + `/merge` hook |
| D30 | ACTIVE | Switch local Dolt to `embedded` mode for worktree pain |
| D31 | ACTIVE | Forge does NOT replace Beads; lean on Beads harder |
| D32 | ACTIVE | Sandboxing concern overweighted; defer hardened sandbox to v3.2 |
| D33 | ACTIVE | `/merge` is a hook, not a stage |
| D34 | ACTIVE | `/plan` is OPTIONAL — bring your own planner |
| D35 | ACTIVE | Skills auto-invoke via description match (Hermes-style) |
| D36 | ACTIVE | Single backend, no hedged maintenance — optimize for ship |
| D37 | **SUPERSEDED-BY-D39** | (was: 8-week single-MVP W0–W5 timeline) |
| D38 | ACTIVE | Kill criteria: 5 falsifiable gates (now per-version per D39) |
| D39 | ACTIVE | Release versioning — v3.0 / v3.1 / v3.2 / v3.3+ replace single-MVP wave plan |

Full rationale + tradeoff + anti-decision for each: see [locked-decisions.md](./locked-decisions.md).

---

## 8. Release versioning (D39 — supersedes the "single MVP" wave framing)

Per D39, Forge v3 ships as four versioned releases, each with a customer-facing pitch. Full detail in [release-plan.md](./release-plan.md). The W0–W5 wave breakdown is retained inside v3.0 as the build sequence; it no longer represents the full product.

### v3.0 — "Forge protects you AND follows you" (~5–6 weeks, solo MVP)

| Area | Scope |
|---|---|
| L1 rails | 5 rails enforced |
| Memory | Beads-backed (`bd remember` / `bd recall`); Dolt in `embedded` mode |
| Lifecycle | `forge init` / `migrate` / `upgrade` / `rollback` |
| Recap | `forge recap --since=yesterday` (solo mode) |
| Merge | `/merge` continuous PR-state hook |
| Harnesses | **MANDATORY 3-harness translator**: Claude + Cursor + Codex CLI |
| Skills | Auto-invoke (Hermes-style description match) across all 3 |
| `/plan` | Basic 1-tier (intent + lock) — optional per D34 |
| `/build` | Basic TDD loop (no evaluator orchestrator yet) |
| Onboarding | `forge new` first-time wizard (1–2 days; folds into `forge init` per W1). Detects active harness, picks template variant (web-app / library / CLI), runs `forge migrate` from non-Forge state, walks user through L1 rail acknowledgment. Closes the day-1 entry-door gap. |
| W0 NO-GO gate | **Cross-harness skill-activation parity test** — same skill must auto-invoke identically in Claude Code (`.claude/skills/`), Cursor (`.cursor/rules/*.mdc` with globs), and Codex CLI (`.codex/skills/`) on a clean fixture. If only 2/3 work, ship with 2 + flag the third as known-issue per W3 kill checkpoint. |
| Forward-compat | Every artifact ships with `schema_version: 1.0` envelope (`.forge/config.yaml`, `patch.md` frontmatter, skill SKILL.md frontmatter, bd audit event payloads). Reserve anchor ID namespace in patch.md (`<!-- @anchor: id -->` markers) even if unused in v3.0 — enables clean v3.1 migration without forced back-compat (per D40). |
| Pre-W0 derisking | **v2-fixture corpus**: 5 synthetic v2 repos with varied shapes — (1) clean v2 install, (2) broken Beads state, (3) stale worktrees, (4) non-master default branch, (5) no Lefthook. Stress-tests `forge migrate`, embedded Dolt, and L1 rails. Converts validation from N=1 (this repo only) to representative coverage. |

**Defers to v3.1+**: iteration-driven 3-tier `/plan`, `forge insights`, evaluator orchestrator, typed memory API surface, team mode.

### v3.1 — "Forge plans with rigor" (~+3 wk → ~9 wk cumulative)

- Iteration-driven `/plan` with 3 tiers (quick / standard / deep)
- Classification auto-detect; parallel critics in deep mode
- Supersedes-tracked decisions ledger (productized)
- Continuous learning loop ON: `forge insights` pattern detector
- `/build` evaluator orchestrator (test + spec-compliance + lint judges)

**Defers to v3.2+**: team-mode recap, team patches, bidirectional log↔docs.

### v3.2 — "Forge for teams" (~+2 wk → ~11 wk cumulative)

- `forge recap --team` aggregates across team members
- Team patches: per-user overlays + shared `team-patch.md`
- Bidirectional agent-log ↔ docs links
- `bd audit upstream --meta-json PR` (Plan A) or `.forge/log.jsonl` fallback (Plan B)
- Docs-as-memory: 7-category navigation surfaced in recap/insights

**Defers to v3.3+**: ecosystem expansion, profile sync, marketplace, sandbox.

### v3.3+ — Ecosystem

- Cline / OpenCode / Kilo Code translators
- Marketplace expansion beyond seed allowlist
- `/forge map-codebase`, profile sync, skill self-improvement
- Full evaluator suite, hardened sandbox

---

## 9. What we don't build (per version)

### Defers to v3.1+ (out of v3.0 scope)

- Iteration-driven 3-tier `/plan` (intent + lock only in v3.0)
- `forge insights` pattern detector
- `/build` evaluator orchestrator (basic TDD loop only in v3.0)
- Typed memory API surface (`forge.remember/recall` direct calls — v3.0 uses `bd remember/recall`)

### Defers to v3.2+

- Team-mode recap aggregation
- Team patches with per-user overlays
- Bidirectional agent-log ↔ docs link plumbing
- `bd audit upstream --meta-json PR` integration

### Defers to v3.3+

- Cline / OpenCode / Kilo Code harness translators (D15 deferral)
- Marketplace UI / browse experience beyond seed allowlist
- `/forge map-codebase`
- Profile sync server (git-backed first)
- Skill self-improvement loop
- Long-running parallel agent teams (WS6)
- Hardened sandbox support (D32)
- `forge-memory` issue adapter — only if Beads upstream stalls (D21/D31)

### Skip permanently (out of scope for the product Forge is)

- Vector embeddings as primary memory (D24, rejected)
- Mirror-org skill marketplace (D1 — allowlist instead)
- Replacing Beads with our own issue store (D31)
- Per-harness duplicated runtimes (D36 — parallel manifests instead)
- A new database for AI memory (D22)

### Replace, don't reinvent

- Audit log writer → `bd audit record` (D23)
- Worktree isolation → Beads embedded mode (D30)
- `patch.md` 3-way merge → `git merge-file -p` (efficiency-audit win #2)
- Pattern detector v0 → `jq | sort | uniq -c | head` (efficiency-audit win #5)
- Cross-harness translator → extend existing `AGENT_ADAPTERS` in `scripts/sync-commands.js`

---

## 10. Five key takeaways from this session

1. **We were 1 commit away from replacing Beads** when our actual problem was using ~25% of its surface (D31). Mature tools deserve harder leaning before panic-replace.
2. **Memory needs typed categorization, not a new datastore** — seven categories, five existing backends, zero new databases (D22/D24).
3. **Stages aren't monoliths; they're templates with phases.** `/validate` collapses into `/dev` continuously (D27); `/premerge` becomes a hook (D28); `/plan` becomes optional (D34).
4. **Skills are the product; runtime is the floor.** Hermes-style description-match auto-invocation (D35) is what users actually feel; everything else is invisible spine.
5. **Critics caught what producers missed.** Three of the largest pivots (memory typing, audit collapse, Beads-coexist) came from explicit critic-loop docs (`agent-memory-architecture.md`, `efficiency-audit.md`, `beads-supabase-and-forge-memory-design.md`), not from the original plan.

Full list in [LEARNINGS.md](./LEARNINGS.md).

---

## 11. Kill criteria — when do we abandon v3?

Per D38 (gates now apply per-version per D39 — see [release-plan.md](./release-plan.md) for full per-version gate matrix), v3.0 is killed (Forge reverts to v2 maintenance mode) if **any** of the following fail to land:

1. `forge migrate --dry-run` does not produce a green diff on this repo's 228 issues.
2. Cross-machine convergence benchmark (B5 in n1-moat) shows >8s p95 even with embedded Dolt.
3. Two of three target harnesses (Claude / Cursor / Codex) cannot render a single skill correctly.
4. `bd audit record` integration (D23) fails benchmarks AND the D25 `.forge/log.jsonl` fallback also fails.
5. Zero external users show interest by end of v3.0 launch.

v3.1 / v3.2 / v3.3+ have their own per-version gates documented in [release-plan.md](./release-plan.md).

Without explicit kill criteria the iteration trap repeats forever.

---

## 12. Source documents

**Canonical (read in order)**:
1. [FINAL-THESIS.md](./FINAL-THESIS.md) — this doc
2. [release-plan.md](./release-plan.md) — versioned roadmap (v3.0 / v3.1 / v3.2 / v3.3+) per D39
3. [locked-decisions.md](./locked-decisions.md) — D1-D42 with supersedes
4. [LEARNINGS.md](./LEARNINGS.md) — 15 takeaways from 6 iterations
5. [iteration-driven-planning-skill.md](./iteration-driven-planning-skill.md) — the planning method itself, proposed as the canonical Forge `/plan` skill (lands in v3.1)
6. [v3-redesign-strategy.md](./v3-redesign-strategy.md) — full strategy reference

**Design references**:
- [layered-skeleton-config.md](./layered-skeleton-config.md) — L1/L2/L3/L4 schema
- [extension-system.md](./extension-system.md) — manifest spec, resolvers, lockfile
- [skill-distribution.md](./skill-distribution.md) — marketplace allowlist
- [skill-generation.md](./skill-generation.md) — observed-work mining (D18)
- [agent-memory-architecture.md](./agent-memory-architecture.md) — 7-category typed memory (D22/D24)
- [marketplace-patchmd-use-case-kits.md](./marketplace-patchmd-use-case-kits.md) — use-case validation
- [n1-moat-technical-deep-dive.md](./n1-moat-technical-deep-dive.md) — moat analysis (D8/D9/D38)
- [beads-supabase-and-forge-memory-design.md](./beads-supabase-and-forge-memory-design.md) — Beads coexist (D21/D31)

**Tactical**:
- [beads-operations-manifest.md](./beads-operations-manifest.md) — bd create/reframe/close manifest
- [v3-release-staging.md](./v3-release-staging.md) — release gating

**Audits**:
- [reality-check-audit.md](./reality-check-audit.md) — survival audit (D37/D38)
- [n1-survival-audit.md](./n1-survival-audit.md) — N=1 retention critique (D26/D34)
- [efficiency-audit.md](./efficiency-audit.md) — 10 efficiency wins (D23/D25/D37)
- [quality-vs-speed-tradeoff.md](./quality-vs-speed-tradeoff.md) — quality cuts (D32/D37)
- [unconventional-alternatives.md](./unconventional-alternatives.md) — alternatives considered
- [template-library-and-merge-flow.md](./template-library-and-merge-flow.md) — template scope (D9/D26)

---

**End of FINAL-THESIS.**
