# Forge v3 — Locked Decisions Log

**Date**: 2026-04-28 (D1–D7) → 2026-04-29 (D8–D39 added across iterations #3–#7)
**Status**: Canonical decisions ledger for the v3 skeleton pivot — D1–D39 locked, supersedes annotated inline
**Companion**: [release-plan.md](./release-plan.md), [v3-redesign-strategy.md](./v3-redesign-strategy.md), [FINAL-THESIS.md](./FINAL-THESIS.md), [LEARNINGS.md](./LEARNINGS.md)

This is the single source of truth for which v3 questions are settled. Decisions D1–D7 came from the original critic loop (anti-architect / gap-finder / sequencer). D8–D14 came from the 2026-04-28 lock-in pass after the N1 moat deep dive, the v3 ecosystem audit, and the template-library design pass. D15–D20 came from the 2026-04-29 iteration #3/#4 work (Cursor capability spike, harness narrowing, agent action log, protected paths, ownership matrix). D21–D38 came from iterations #5 and #6 (memory architecture, Beads under-utilization research, efficiency audit, quality-vs-speed audit, /merge as continuous hook, /plan-as-optional, kill criteria).

When a doc disagrees with this file, this file wins until a successor decisions log is dated and merged.

**Status legend**: ACTIVE = currently in force · SUPERSEDED-BY-Dxx = replaced; original kept for traceability · REVISED-BY-Dxx = amended in spirit, original phrasing preserved.

---

## D1 — Curated allowlist `forge-marketplace.json` (NOT mirror org)

**Decision**: Ship a single curated `forge-marketplace.json` (Claude Code-compatible schema) inside `forge-core/`. Each entry pins `name`, `owner/repo`, `sha`, `forge-core` version range, capabilities. Nightly bot opens PRs to bump SHAs. Name collisions resolve Homebrew-style: short name first, then `owner/repo/short` once a collision exists.

**Rationale**: Discoverability + safety + zero-config for the 95% case while keeping an escape hatch through fully qualified names. We get an open-source-friendly index without owning a parallel package registry.

**Tradeoff considered**: A mirror-org model (Forge re-publishes vetted forks) gives stronger supply-chain control but doubles the maintenance surface and forks trust.

**Anti-decision**: We explicitly chose against running a Forge-owned mirror org or a custom package registry.

---

## D2 — Hybrid `patch.md` (single index + auto-extract over 40 lines)

**Decision**: `.forge/patch.md` is one human-readable index keyed by extension id and section anchor. Any patch body over 40 lines is auto-extracted by `forge` into `.forge/patches/<id>-<slug>.md` and replaced with an `@include` reference.

**Rationale**: Small projects stay one-file simple; large projects don't drown the index. The 40-line threshold preserves a one-screen review for the common case.

**Tradeoff considered**: Pure single-file is simpler to grep but degenerates into a 1000-line monolith; pure many-files is reviewable per-patch but loses the at-a-glance index.

**Anti-decision**: We explicitly chose against both the "everything in one patch.md" and the "one file per override" extremes.

---

## D3 — Refuse-with-hint default + lenient opt-in + L1 always wins

**Decision**: On gate violation, refuse and emit a one-line hint pointing at the fix (`forge dev`, `lenient.tdd: true` in patch.md, etc.). L3 may opt specific L2 gates into lenient mode. L1 rails (TDD gate, secret scan, branch protection, signed commits, classification router) cannot go lenient. Every `--force-skip-*` flag emits an audit record.

**Rationale**: Agents must not silently bypass gates. Humans get a visible emergency lever, not a hidden one. The hint keeps refuse from becoming a dead end.

**Tradeoff considered**: A pure "refuse, no hint" default is safer-by-default but produces dead-end UX; a pure "warn, don't block" default is friendlier but lets agents drift.

**Anti-decision**: We explicitly chose against silent bypass and against any policy that lets `--force-skip` go unaudited.

---

## D4 — `AGENTS.md` = generated artifact + lint

**Decision**: `AGENTS.md` is assembled from L1 contract + effective L2 config + project patches at `forge sync` / `forge upgrade` time. CI lint blocks hand-edited commits. Anchors keyed off layer fragments survive regeneration.

**Rationale**: Hand-edited AGENTS.md drifts from the effective config that the runtime actually executes. A generated artifact gives agents a deterministic source of truth and preserves anchor IDs across upgrades.

**Tradeoff considered**: Letting humans hand-edit AGENTS.md is friendlier to first-time contributors but guarantees drift after the first upgrade.

**Anti-decision**: We explicitly chose against treating AGENTS.md as a hand-curated doc.

---

## D5 — Team patches via per-user overlays

**Decision**: Repos ship a base `patch.md`. Personal overlays live at `~/.forge/profile/patches/<project>.md` and merge in L1 → L2 → L3 → L4 order. Personal overlays cannot defeat an L1 rail.

**Rationale**: Shared team standards plus personal ergonomics, without forcing one to dominate the other.

**Tradeoff considered**: A "team patch only" model keeps determinism but forbids personal tweaks; a "personal patch only" model fragments the team baseline.

**Anti-decision**: We explicitly chose against any overlay system that lets a personal preference override an L1 rail.

---

## D6 — v2 → v3 migration via explicit `forge migrate` + compat mode

**Decision**: v2 installs are not auto-migrated. `forge migrate` converts `WORKFLOW_STAGE_MATRIX` into `.forge/config.yaml`, scaffolds `patch.md`, and re-pins extensions in `forge.lock`. Compat mode keeps v2 commands working through Wave 4; cutover at Wave 5.

**Rationale**: A 14–18 week pivot spans live projects. An explicit migrate command + compat window beats silent surprises.

**Tradeoff considered**: An auto-migration on first v3 launch is friction-free but blast-radius-unbounded.

**Anti-decision**: We explicitly chose against auto-migrating v2 installs without user consent.

---

## D7 — `forge upgrade` snapshots `.forge/backups/<ts>/`

**Decision**: Every `forge upgrade` writes a timestamped snapshot of `.forge/` plus an audit-log line. `forge upgrade --rollback` (and the standalone `forge rollback <ts>`) restores the most recent snapshot. Snapshots GC after 30 days unless pinned.

**Rationale**: Upgrades will mis-merge patches occasionally; a one-command rollback turns that from a crisis into an inconvenience.

**Tradeoff considered**: Skipping snapshots saves disk and keeps `.forge/` clean but makes any bad upgrade a manual git-archeology problem.

**Anti-decision**: We explicitly chose against treating "the user has git, that's enough" as the rollback strategy.

---

## D8 — Keep N5 (`forge options *` introspection)

**Decision**: Retain `forge options list / get / set / why` (currently tracked as `forge-besw.4`) as a Wave-1 deliverable. No descope, no rename. The `forge options why <id>` path that prints the L1→L4 resolution chain is the load-bearing piece.

**Rationale**: The `forge options` surface is what makes the layered config legible to agents and humans. Without `why`, the L1/L2/L3/L4 resolution model is invisible at runtime and the layering promise is unfalsifiable. It is also the cheapest way for agents to discover what's tunable without reading source.

**Tradeoff considered**: We could collapse introspection into `forge config show` and save a small surface; that loses the per-id resolution chain that makes L3/L4 overrides debuggable.

**Anti-decision**: We explicitly chose against deferring or collapsing the introspection API into a generic "config dump" command.

---

## D9 — 3 templates at MVP, 2 deferred to v3.1

**Decision**: Ship three reference adapter templates in MVP: `review-coderabbit` (the 28-minute walkthrough demo), `review-stub` (canonical SPI blank canvas), and `gate-cli-json` (covers ESLint / Biome / gitleaks / semgrep / license-checker). Defer `notify-webhook` and `issue-mcp-passthrough` to v3.1.

**Rationale**: Three templates is the minimum that proves the SPI generalizes (one concrete review adapter, one blank canvas, one non-review category) without padding the MVP cutover with adapters that don't have a forcing demo. CodeRabbit is the demo; stub is the doc artifact; gate-cli-json absorbs the long tail of CLI-style quality gates with one template.

**Tradeoff considered**: Five templates broaden the "look how general the SPI is" story for marketing but add ~1.5–2 weeks of template + fixture work that isn't on the MVP critical path.

**Anti-decision**: We explicitly chose against shipping all five at MVP; webhook and MCP-passthrough are real but not load-bearing for v3.0.

---

## D10 — Adopt `forge migrate --dry-run` PoC as Wave 0 NO-GO gate

**Decision**: Before any other v3 work merges, `forge migrate --dry-run` must run successfully against this repo with its 228 beads issues and current `WORKFLOW_STAGE_MATRIX`, producing a green diff. The PoC is the Wave 0 NO-GO gate. If it fails, v3 work pauses until the migration model is fixed.

**Rationale**: D6 commits us to an explicit migrate path; without a PoC against a real workload, every other Wave 1+ workstream is built on an unproven assumption. Forcing the PoC up front converts a Wave-5-cutover risk into a Wave-0 schedule risk we can react to.

**Tradeoff considered**: Skipping the PoC and relying on Wave 5 cutover testing is faster early but turns a migration bug into a release-blocker on a 14-week-old codebase.

**Anti-decision**: We explicitly chose against treating `forge migrate` as a Wave-5 deliverable validated only at cutover.

---

## D11 — Lock 6-harness target  ·  **SUPERSEDED BY D15**

> **Status note (2026-04-29)**: The "6-harness MVP" decision was narrowed to 3 harnesses (Claude Code + Cursor + Codex CLI) by D15 after the v3 ecosystem audit and Cursor capability spike. The other three (Cline, OpenCode, Kilo Code) defer to v3.1. The original D11 reasoning is preserved below for the audit trail.

**Decision**: v3 actively maintains six harness targets: **Claude Code, Codex CLI, OpenCode, Kilo Code, Cline, Cursor**. Translator output covers all six. Capability matrix and feature parity are tracked per harness.

**Rationale**: Six is the set with formal manifest support, slash-command surface, and active user bases that justify ongoing translator work. Each target either has a stable plugin/manifest format (Claude Code plugin.json, OpenCode opencode.json) or a documented file-on-disk convention (Codex CLI prompt files, Cursor `.cursor/rules/*.mdc`, Cline / Kilo Code rule files) that the translator can target deterministically.

**Tradeoff considered**: A 3-harness target (Claude Code + Codex + Cursor) is cheaper to maintain and covers most users; a 9+-harness target maximizes reach but spreads the translator team thin and forces ongoing work on harnesses with weak manifest stories.

**Anti-decision**: We explicitly chose against a "best-effort everywhere" stance and against a Claude-Code-only stance.

---

## D12 — Adopt agentskills.io as canonical skill format

**Decision**: SKILL.md authored against the agentskills.io spec is the canonical Forge skill format. The translator emits agentskills.io-compliant fragments to each of the six harness target dirs. Where a harness has its own native format (Cursor `.mdc`, OpenCode `opencode.json`, Claude Code plugin manifest), the translator adapts; where it doesn't, the SKILL.md drops in directly.

**Rationale**: agentskills.io is the only cross-harness skill spec with momentum across the targets we care about, and aligning on it lets Forge skills be portable inputs and outputs of the wider ecosystem rather than a Forge-only dialect. Adopting an external spec also constrains scope-creep in the skill format itself.

**Tradeoff considered**: Authoring a Forge-native skill format gives us full control of the schema but costs interop and pushes maintenance burden onto Forge.

**Anti-decision**: We explicitly chose against inventing a Forge-only skill format.

---

## D13 — Drop active maintenance for PI / Hermes / Aider / Copilot / Roo / legacy Cursor `.cursorrules`

**Decision**: v3 does not actively maintain translator output, capability matrix, or test coverage for: PI, Hermes, Aider, GitHub Copilot, Roo Code, and Cursor's legacy `.cursorrules` (single-file) format. Cursor's modern `.cursor/rules/*.mdc` is supported under D11.

**Rationale**: These targets either lack a stable manifest/skill story (Aider, Copilot, legacy `.cursorrules`), have niche user bases that don't justify ongoing translator surface (PI, Hermes), or overlap heavily with a target we already cover (Roo overlaps Cline/Kilo). Maintaining them was producing translator drift without adoption.

**Tradeoff considered**: Best-effort coverage of all known harnesses maximizes "Forge runs everywhere" marketing but produces a translator we can't keep correct.

**Anti-decision**: We explicitly chose against best-effort cross-harness coverage.

---

## D14 — 2-week harness translator work folded into N7 + N10, not a separate workstream

**Decision**: The estimated ~2 weeks of harness translator engineering required to hit the D11/D12/D13 scope is absorbed into existing workstreams N7 (extension manifest spec) and N10 (multi-target sync extension). No new top-level workstream, no new wave, no schedule re-base.

**Rationale**: The translator is a feature of the manifest + multi-target sync surface, not a standalone product. Splitting it into its own workstream invites ownership drift and double-counted estimates. Folding it in keeps N7 and N10 honest about real scope.

**Tradeoff considered**: A standalone "Harness Translator" workstream would be more visible on the roadmap and easier to staff independently, at the cost of double-billing engineering already covered by N7/N10.

**Anti-decision**: We explicitly chose against creating a separate "Harness Translator" workstream or wave entry.

---

## D15 — 3-harness MVP target (Claude Code + Cursor + Codex CLI); ALL THREE in v3.0; Cline/OpenCode/Kilo deferred to v3.3+

> **Clarification (2026-04-29 iter #7, D39)**: All three target harnesses (Claude + Cursor + Codex CLI) ship in **v3.0** — none are split into v3.1. The 3-harness translator is mandatory in v3.0. Cline, OpenCode, and Kilo Code (originally framed as v3.1 follow-on) shift to **v3.3+ ecosystem** under D39's release versioning.

**Decision**: v3.0 MVP actively targets exactly three harnesses: Claude Code, Cursor, and Codex CLI — ALL THREE in v3.0. Cline, OpenCode, and Kilo Code are deferred to v3.3+ ecosystem expansion (they share architecture with the MVP three and can ship together as a follow-on bundle once the 3-harness translator stabilizes). PI, Hermes, Aider, Copilot, Roo, and legacy Cursor remain dropped per D13. This narrows D11's "lock 6-harness target" to a 3-harness v3.0 MVP plus a v3.3+ ecosystem +3.

**Rationale**: A "shared protocol" claim requires a translator that crosses at least 3 distinct agents. Cursor's modern slash-command surface (`.cursor/rules/*.mdc` + `.cursor/commands/*.md`) is now confirmed against primary sources. Codex CLI's hooks parity with Claude Code makes the 3-harness translator a ~1.5–2 week effort versus the ~4–5 weeks the 6-harness scope implied. Iteration #4 framed the 6-harness target as aspirational; this decision lands the realistic MVP cut while preserving the v3.1 expansion path.

**Tradeoff considered**: Holding the full 6-harness scope at MVP gives a stronger "Forge runs everywhere" marketing surface but extends the translator critical path by ~2.5 weeks against a ~6-week MVP and increases the surface that Wave 0 verification spikes must cover.

**Anti-decision**: We explicitly chose against shipping all six harnesses at MVP, and against collapsing to a Claude-Code-only scope.

---

## D16 — Stage HARD-GATEs are L2 default-on (toggleable); TDD intent enforcement stays L1

**Decision**: Stage transition gates (e.g., "must complete /plan before /dev", "must pass /validate before /ship") move from L1 to L2, default-on. A project can declare specific stages as `required: true` in `.forge/config.yaml` (project-level lock that survives upgrade). Users may override non-required stage gates via `patch.md`. **TDD intent enforcement remains L1** — it is the protocol's identity, not a workflow opinion.

**Rationale**: Stage order is workflow opinion (negotiable between teams and projects). TDD discipline is protocol opinion (non-negotiable; it is the thing Forge stands for). Per the UX critic during iteration #4, treating every stage gate as L1 produced a ~50% bail rate at the first refused commit — which inverts the goal of having gates at all. Splitting "protocol identity" from "workflow opinion" gives projects an honest customization surface without diluting what Forge protects.

**Tradeoff considered**: Keeping all stage gates at L1 maximizes deterministic stage discipline at the cost of forcing every project into a 7-stage shape; pushing all gates including TDD to L2 maximizes flexibility but turns Forge into a configurable runner with no protocol identity.

**Anti-decision**: We explicitly chose against making everything L1 (the iteration #3 default), and against making TDD itself L2-toggleable.

---

## D17 — Mandatory agent action log at `.forge/agent-log.ndjson`  ·  **REVISED BY D23**

> **Status note (2026-04-29 iter #5, efficiency audit)**: The decision to *capture* an audit trail of every agent action stands. The implementation detail — "Forge writes its own NDJSON file" — was superseded by D23: use `bd audit record` (already shipped in Beads, hash-chained, redacted, queryable via `bd audit search`) instead of building a parallel log writer. Three NDJSON streams (D17 audit + D19 agent + `.beads/interactions.jsonl`) collapse into one. The "what" of D17 stays; the "where" moves to Beads.

**Decision**: Every agent action is appended to `.forge/agent-log.ndjson` (NDJSON, append-only, harness-agnostic format, redacted via the existing project-memory redaction pipeline). Captured events: tool calls, stage transitions, gate firings, file mutations, test runs, git operations, hook invocations, MCP calls. The action-log writer is folded into the existing audit-log writer (extends N3 scope) — it is not a separate sixth L1 rail.

**Rationale**: Three compounding wins at N=1: (1) enables the self-improvement loop in D18 by giving the pattern detector a rich signal; (2) enables agent-claim verification ("did the agent actually run the test, or did it just say it did?"); (3) compounds with use without requiring a community. Cross-harness consistent format makes the log usable across Claude/Cursor/Codex without per-harness parsing.

**Tradeoff considered**: Promoting the action log to an explicit sixth L1 rail makes it more visible but inflates rail count and signals that the log is itself a safety mechanism rather than an observability + self-improvement substrate; skipping the log entirely keeps `.forge/` smaller but kills D18 outright.

**Anti-decision**: We explicitly chose against making the action log a separate L1 rail (it extends rail #5, schema + integrity), and against scoping it to one harness.

---

## D18 — `forge insights` mines the agent log for pattern-driven skill generation

**Decision**: `forge insights` scope shifts from N13's "review-feedback PoC" to a pattern-driven skill generator. The pattern detector reads `.forge/agent-log.ndjson`, surfaces repeated tool-call sequences (≥5 occurrences over 2 weeks), and proposes new skills as files at `.forge/proposals/<id>.md`. The user runs `forge skill accept <id>` to promote a proposal into `.forge/extensions/local/<slug>/SKILL.md` and record the acceptance in `patch.md`. Review-feedback is no longer the primary signal in MVP — agent traces are richer.

**Rationale**: Review-feedback alone is too narrow a signal for skill suggestions (it only fires when a reviewer flags something). Agent traces fire on every action, are local-first, and produce usable patterns at N=1. The proposal/acceptance flow keeps the user in the loop (no auto-promotion) while making the loop actually self-improving rather than purely documentary.

**Tradeoff considered**: Keeping review-feedback as the primary insights signal preserves the iteration #2 N13 framing and integrates with existing review parsers, but yields fewer proposals per session and stalls when review traffic is low.

**Anti-decision**: We explicitly chose against keeping review-feedback as the only or primary insights signal in MVP.

---

## D19 — Protected Path Manifest enforces L1 rail #5 (no new rail)

**Decision**: Forge ships `.forge/protected-paths.yaml` defining seven categories of protected paths: `forge_core` (checksum-verified), `user_protocol` (CLI-only mods), `generated_artifacts` (CI-blocked hand-edits), `append_only_logs` (runtime-only writes), `secrets` (already covered by rail #2), `beads_state` (bd CLI only), `immutable` (`.git`, etc). Enforcement layers: per-harness PreToolUse hooks (Claude Code + Codex CLI), Cursor file-watcher fallback, pre-commit lefthook entry, session-start checksum verification, CI lint job. Refuse-with-hint UX guides agents toward the proper CLI commands. **Total L1 rail count stays at 5** — this expands rail #5 (schema + integrity) scope; it does not add a new rail.

**Rationale**: Without protected paths, an agent that drifts into editing generated artifacts, beads internals, or the audit log silently breaks project state. The hooks + lefthook + CI lint stack catches drift at the earliest possible point in the loop. Treating this as expansion of rail #5 (schema + integrity) keeps the rail count honest — the underlying protocol opinion ("the protocol surface is integrity-verified") is the same opinion already encoded in rail #5.

**Tradeoff considered**: Adding protected paths as a sixth L1 rail makes them more prominent but inflates rail count beyond what the protocol's actual opinion-set justifies; relying purely on documentation ("don't edit AGENTS.md") is friendly but agents will drift.

**Anti-decision**: We explicitly chose against adding a sixth L1 rail for this, and against documentation-only enforcement.

---

## D20 — Auto-generated skill ownership matrix (Forge proposes; user accepts)

**Decision**: Forge-generated skill artifacts follow a strict ownership matrix. Forge **proposes** at `.forge/proposals/` (regenerable, not committed). The user **accepts** via `forge skill accept <id>`, moving the artifact to `.forge/extensions/local/<slug>/`. Once accepted, the skill is **user-owned**, preserved across `forge upgrade`, and tracked in `patch.md`. Forge regenerates a skill on demand via `forge skill regenerate <slug>`. `forge upgrade` respects acceptance state — it never overwrites accepted skills.

**Rationale**: A clean ownership boundary prevents the "Forge generated this skill, now what?" confusion. Proposals stay disposable; accepted skills are durable. Without this matrix, two failure modes appear: (a) treating auto-gen artifacts as Forge-owned means the user can't edit them; (b) treating them as user-owned without acceptance tracking means upgrade either clobbers them or stops generating new ones.

**Tradeoff considered**: A simpler "everything Forge generates is user-owned immediately" model removes the acceptance step but loses the regeneration-without-clobber property; the inverse "everything Forge generates stays Forge-owned" model keeps regeneration safe but blocks user editing.

**Anti-decision**: We explicitly chose against single-bucket ownership (all-Forge or all-user) and against silent regeneration that overwrites user edits.

---

# Iteration #5 (2026-04-29) — Memory architecture + audit collapse

## D21 — IssueAdapter interface as future-proofing; Beads stays the only implementation

**Decision**: Forge ships a `lib/issue-adapter.js` interface (`create / update / list / close / ready / depAdd / sync`) during contract extraction (N2). **Beads is the only shipped implementation through v3.0 and v3.1.** The `forge-memory` JSONL+SQLite adapter described in `beads-supabase-and-forge-memory-design.md` is **deferred indefinitely** — it ships only if the Wave-3 cross-machine convergence benchmark fails or if [Beads issue #3582](https://github.com/gastownhall/beads/issues/3582) (sandboxed Linux Dolt access) stays unfixed >60 days. ACTIVE.

**Rationale**: Defining the interface up-front prevents extension authors from binding to `bd`-specific concepts (Dolt branches, hash IDs, federation) that we'd then have to deprecate. Building a second adapter without an external trigger is ~2k LOC of unjustified maintenance burden. The interface is the cheap insurance policy; the second implementation is the expensive one we don't take until forced.

**Tradeoff considered**: Build both adapters now (locks in abstraction + escape hatch but adds 2 weeks to v3 critical path); skip the interface entirely (saves 2 days but couples Forge to Beads internals).

**Anti-decision**: We explicitly chose against pre-emptively building `forge-memory` issue adapter, and against not defining the interface at all.

---

## D22 — Forge does NOT need a new memory database; typed memory API over existing backends

**Decision**: Forge ships a thin `forge.remember / recall / forget / compact` API that enforces **category** at write time and returns **provenance** at read time. The API routes to seven existing backends — no new datastore, no embeddings, no vector store. Backends are: `docs/plans/*.md` + SQLite FTS5 (decisions); append-only JSONL with weekly LLM-reflection compaction (session episodes); `.claude/skills/*.md` + trigger index (skills); `.forge/state.json` per-worktree (working state); Beads (issue graph); rotated NDJSON (audit); plain markdown loaded into every prompt (preferences). ACTIVE.

**Rationale**: Per `agent-memory-architecture.md`, the literature has converged on typed memory with per-category retention rules — not flat dumps or vector stores. Forge already has six of the seven backends; the gap is a category dimension on writes and a thin retrieval API. This is a convention-and-tooling problem, not a storage problem.

**Tradeoff considered**: Build a unified vector store with embeddings (Mem0-style) — buys semantic recall but adds embedding model lock-in, staleness, retrieval-quality decay; build a single SQLite database with seven tables — simpler than seven backends but loses git-trackability and human-editability of decisions/skills/preferences.

**Anti-decision**: We explicitly chose against vector stores as primary memory, against a single unified backend, and against any "new database for AI memory" framing.

---

## D23 — Use `bd audit record` instead of building a parallel NDJSON writer (collapses D17 + D19 + interactions.jsonl)

**Decision**: Drop the "Forge writes `.forge/agent-log.ndjson`" implementation from D17. Use `bd audit record` (shipped in Beads, hash-chain integrity, redacted, queryable via `bd audit search` and `bd audit verify`) for every Forge audit event. Three NDJSON streams (D17 audit + D19 agent action + `.beads/interactions.jsonl`) collapse into one Beads-managed audit log. ACTIVE — supersedes the D17 implementation detail; the D17 *intent* (capture every agent action) stands.

**Rationale**: Per `efficiency-audit.md` win #4, building three parallel append-only writers with three redactors and three rotation policies duplicates work Beads has already done well. Beads ships hash-chain integrity, redaction reuse, and a queryable audit surface — Forge would need to reinvent all three. Saves ~1 week of build, eliminates a maintenance surface, and gives `forge insights` a richer query API for free.

**Tradeoff considered**: Keep separate `.forge/agent-log.ndjson` to avoid the Beads dependency for audit (preserves "drop hosted Dolt" kill criterion symmetry but doubles writers); collapse to a single forge-owned writer (one writer but reinvents `bd audit`).

**Anti-decision**: We explicitly chose against building a separate Forge audit pipeline, and against keeping `.beads/interactions.jsonl` as a third stream.

---

## D24 — Vector stores are NOT the primary memory shape; FTS5 over markdown covers ~90% of recall

**Decision**: Forge does not ship vector embeddings, an embedding model dependency, or a vector store as primary memory. Decisions, skills, and preferences are retrieved via SQLite FTS5 over markdown plus filename and keyword conventions. Vector search may be added behind a feature flag in v3.2+ if FTS5 demonstrably fails on a real recall task. ACTIVE.

**Rationale**: Per `agent-memory-architecture.md`, FTS5 over markdown plus filename/keyword conventions covers ~90% of coding-agent recall with zero embedding-model lock-in or staleness. Adding vectors creates three failure modes (embedding model deprecation, staleness as model versions change, retrieval-quality decay as the corpus grows) that FTS5 doesn't have. The cost is asymmetric: vectors cost real engineering and ongoing maintenance; FTS5 ships in `bun:sqlite`.

**Tradeoff considered**: Ship vectors now to look modern and cover edge cases of synonym recall; ship vectors as opt-in alongside FTS5 (still pays the dependency cost up-front).

**Anti-decision**: We explicitly chose against vector embeddings as a v3 memory primitive.

---

## D25 — Three append-only logs collapse into one `.forge/log.jsonl` *only if* D23 is reverted

**Decision**: If for any reason D23 cannot land (e.g., Beads `bd audit record` proves insufficient on benchmark), Forge collapses D17 + D19 + `.beads/interactions.jsonl` into a single `.forge/log.jsonl` with `kind: audit | agent | interaction` discriminator. One writer, one `prev_hash` chain, one redaction pipeline reusing `lib/project-memory.js` redactor. ACTIVE as fallback to D23.

**Rationale**: Per `efficiency-audit.md` win #4, three separate writers with three redactors and three rotation policies is duplicated work; one stream with a discriminator preserves all retrieval cases. This is the pre-Beads-integration plan kept as the kill-criterion fallback.

**Tradeoff considered**: Maintain three streams (preserves separation of concerns at the cost of triple code paths); collapse into Beads (D23 path, preferred when feasible).

**Anti-decision**: We explicitly chose against permanently maintaining three parallel append-only writers.

---

# Iteration #5b — Stage model reframing

## D26 — `forge new <template>` is the day-one entry point for any project

**Decision**: `forge new <template>` (template library shipped in-repo per `template-library-and-merge-flow.md`) is the canonical first-touch experience for v3. Three templates ship at MVP per D9 (`review-coderabbit`, `review-stub`, `gate-cli-json`); two more deferred to v3.1. Templates compose L1 rails + L2 defaults + a starter `patch.md` so a new project gets a runnable Forge skeleton in one command. ACTIVE.

**Rationale**: A skeleton with no day-one experience is a library, not a product. Templates make L2 swappability legible by shipping multiple working configurations. Per `n1-survival-audit.md`, the "single big ask" for retention is reducing time-to-first-value from setup to working command.

**Tradeoff considered**: Skip templates and let users compose configs by hand (cheaper to ship but raises the cliff for first-touch users to "read three docs and write YAML").

**Anti-decision**: We explicitly chose against shipping v3 without at least one runnable template.

---

## D27 — `/dev` and `/validate` collapse into one stage (continuous validation inside the implementer loop)

**Decision**: The fixed-stage v2 model where `/validate` was a discrete post-`/dev` stage is replaced. Validation (typecheck, lint, tests, security scan) runs **continuously inside the `/dev` implementer subagent loop** — the RED-GREEN-REFACTOR cycle includes the gate runs, and the subagent does not exit a task with red gates. The standalone `/validate` stage is retained only as a manual recovery command for cold-start verification (e.g., after a long pause or rebase). ACTIVE — supersedes the iteration #1 7-stage model where `/validate` was a required handoff.

**Rationale**: Splitting validation into a separate human-driven stage produced two failure modes: (a) agents shipped to `/validate` with broken state and reactively fixed, doubling the loop length; (b) the gate output went stale between `/dev` exit and `/validate` re-run. Continuous validation inside `/dev` keeps the agent honest at every commit and removes a synthetic stage boundary.

**Tradeoff considered**: Keep `/validate` as a required hand-off stage (matches v2 muscle memory but produces stale gate runs); remove `/validate` entirely (loses the cold-start recovery surface).

**Anti-decision**: We explicitly chose against keeping `/validate` as a required stage gate, and against removing the manual command surface entirely.

---

## D28 — `/premerge` is NOT a separate stage; it is a continuous hook on PR-state changes

**Decision**: `/premerge` is removed from the canonical stage list and replaced by a continuous lefthook + GitHub-event hook that fires whenever a PR transitions to "ready for merge" state. The hook runs the doc-update + ADR-link + Beads-close checks that were previously the `/premerge` checklist. No human stage entry needed. ACTIVE — supersedes the iteration #1 model where `/premerge` was a required stage between `/review` and merge.

**Rationale**: `/premerge` was a checklist, not a workflow stage. Modeling it as a stage forced humans to manually invoke a thing the harness can detect from PR state. Hooks fire deterministically on the right event; humans were forgetting.

**Tradeoff considered**: Keep `/premerge` as a stage to ensure human acknowledgment (preserves explicit signoff at the cost of a manual step); fold all premerge checks into `/review` (loses the "right-before-merge" timing).

**Anti-decision**: We explicitly chose against keeping `/premerge` as a required stage.

---

## D29 — Final stage list: 5 stages (`/plan`, `/dev`, `/ship`, `/review`, `/verify`) + `/merge` as a hook

**Decision**: The canonical Forge v3 stage list is **5 stages** — `/plan`, `/dev` (includes continuous validation per D27), `/ship`, `/review`, `/verify` — plus `/merge` as a continuous PR-state hook (per D28). Utility commands (`/status`, `/rollback`, `/sonarcloud`) remain available but are not stages. ACTIVE — supersedes the iteration #1 7-stage model.

**Rationale**: Consolidating 7 stages to 5 + 1 hook removes the two synthetic boundaries (`/validate`, `/premerge`) that produced stale state and forgotten checks. The 5 remaining stages each represent a real human-decision point.

**Tradeoff considered**: Keep all 7 stages for v2 muscle memory (preserves migration smoothness at the cost of carrying synthetic boundaries forward); collapse further to 3 stages plan/dev/ship (loses the post-merge `/verify` cold-start surface and the PR-feedback `/review` stage).

**Anti-decision**: We explicitly chose against the iteration #1 7-stage model and against further compression below 5 stages.

---

# Iteration #6 (2026-04-29) — Beads under-utilization + ship discipline

## D30 — Switch local Beads/Dolt to `embedded` mode for worktree pain (5-min config fix)

**Decision**: Forge ships an embedded-Dolt configuration in `.beads/dolt/config.yaml` for local development. Server mode remains the default for cross-machine sync workflows; embedded mode is opted into per-worktree via `forge sync --mode=embedded` for users hitting `.beads/dolt-server.lock` / `.beads/dolt-server.pid` worktree contention. Per [Beads issue #3582](https://github.com/gastownhall/beads/issues/3582), sandboxed Linux agents already need this. ACTIVE.

**Rationale**: The dolt-server worktree pain that drove the "replace Beads" framing is a 5-minute config fix, not an architectural problem. Embedded mode eliminates `dolt sql-server` lifecycle issues for solo-machine workflows entirely.

**Tradeoff considered**: Stay on server mode everywhere (matches Beads upstream default but keeps the worktree pain); flip default to embedded (eliminates server lifecycle but breaks cross-machine sync that server mode handles).

**Anti-decision**: We explicitly chose against framing dolt-server lifecycle issues as a Beads-replacement justification.

---

## D31 — Forge does NOT replace Beads. Lean on Beads harder; build typed memory API over existing backends

**Decision**: Forge does **NOT** replace Beads. Forge actively under-uses Beads' shipped surface (~25% utilization). The plan: lean on Beads harder — adopt `bd remember` / `bd recall` (durable memory keys), `bd audit record` (per D23), `bd preflight --check` (stage gate verification), `bd doctor validate` (config integrity), `bd formula` / `bd pour` (recipe-style stage templates), `bd prime` (cold-start state hydration). Switch local Dolt to `embedded` mode (per D30) for worktree pain. Build a thin **typed memory API** (decisions / episodes / skills / state / issues / audit / preferences per D22) that routes to existing backends (Beads, `docs/plans/`, `.claude/skills/`, `.forge/state.json`). The `IssueAdapter` interface (D21) stays as future-proofing only — Beads is the only shipped implementation through v3.1. ACTIVE — supersedes any earlier "replace Beads" framing in this folder.

**Rationale**: Per `beads-supabase-and-forge-memory-design.md`: there is no Supabase migration; the recent breaking change is the Dolt cutover Forge has been on for months; Forge Memory was always designed as complement, not replacement. Per Iteration #6 utilization research: Forge uses ~25% of Beads' shipped capability — `bd remember`, `bd preflight`, `bd doctor`, `bd formula`, `bd pour`, `bd prime` are all unused. Replacing a mature tool we under-use is the wrong response to under-utilization.

**Tradeoff considered**: Replace Beads with Forge Memory's full issue adapter (3–4 weeks of work to build feature parity, huge regression risk, removes Dolt dependency); fork Beads (preserves customization but inherits all maintenance burden); stay on Beads passively without adopting more surface (cheapest but leaves the under-utilization gap).

**Anti-decision**: We explicitly chose against replacing Beads, against forking Beads, and against staying at 25% utilization.

---

## D32 — Sandboxing concern was overweighted; defer hardened sandbox to v3.2

**Decision**: The "sandboxed agent cannot run Forge" worry that drove ~3 design iterations is descoped from v3.0 / v3.1. The single concrete instance ([Beads #3582](https://github.com/gastownhall/beads/issues/3582)) has an upstream fix in flight and a workaround (D30 embedded mode). Hardened sandbox support is deferred to v3.2+ pending real user demand. ACTIVE.

**Rationale**: Per iteration #6 review, sandboxing affected ~1 known user case and consumed disproportionate design surface. The kill-criterion fallback (D21 + D31 IssueAdapter) covers the long-tail recovery path without front-loading the build.

**Tradeoff considered**: Build sandboxed-agent support into v3.0 (preserves coverage but adds 2+ weeks for a small audience); skip sandboxing entirely with no future plan (closes the door on a real future audience).

**Anti-decision**: We explicitly chose against making sandboxed-agent support a v3.0 / v3.1 requirement.

---

## D33 — `/merge` is a hook, not a stage (formalizes D28)

**Decision**: `/merge` is implemented as a continuous PR-state hook (lefthook + GitHub Actions PR-event), never as a slash command or stage entry. The hook fires on PR `ready_for_review → ready` transitions, runs the merge readiness checks, and surfaces blockers via PR comment. Humans never type `/merge`. ACTIVE — companion to D28.

**Rationale**: Per D28, premerge checks are deterministic from PR state; humans typing `/merge` was the bug, not the feature. Hooks remove the "did they remember to run it?" failure mode entirely.

**Tradeoff considered**: Ship `/merge` as a discoverable slash command (better discoverability at the cost of optional invocation); rely on humans running raw `gh pr merge` (preserves CLI familiarity but loses the readiness checks).

**Anti-decision**: We explicitly chose against `/merge` as a slash command.

---

## D34 — `/plan` is OPTIONAL — bring your own planner

**Decision**: `/plan` is **not required** to use Forge. Projects may declare `planner: external` in `.forge/config.yaml` and bring their own planning artifact (Linear issue, Jira ticket, design doc, ADR). Forge enters `/dev` from any source of design intent that satisfies the L1 schema (one task list with acceptance criteria). The shipped `/plan` stage remains the default for projects without an external planner. ACTIVE — supersedes the iteration #1 model where `/plan` was a required stage gate.

**Rationale**: Forge's value is the iteration loop + memory + skill library, not the planner. Many teams already have planning tools they trust; forcing them to redo design work in `/plan` is the kind of "workflow opinion" D16 calls out. The L1 contract is "every `/dev` entry has a structured task list" — not "the task list came from `/plan`".

**Tradeoff considered**: Keep `/plan` required to enforce design-first discipline (preserves protocol identity at the cost of coupling Forge to one planning UX); remove `/plan` entirely (loses the well-tested default for solo users).

**Anti-decision**: We explicitly chose against `/plan` as a required stage and against removing the shipped `/plan` implementation.

---

## D35 — Skills auto-invoke via description match (Hermes-style)

**Decision**: Forge skills declare a `description` field with trigger keywords; the runtime auto-invokes a skill when the user's prompt matches the description with sufficient confidence. Pattern lifted verbatim from the Hermes skill model (proven across the Anthropic skill ecosystem). No manual `/skill <name>` invocation required for accepted skills. ACTIVE.

**Rationale**: Manual skill invocation defeats the "skill library auto-activates whenever needed" product positioning. Description-match is simple, deterministic, and battle-tested in the broader ecosystem.

**Tradeoff considered**: Require explicit `/skill <name>` invocation (preserves human agency at the cost of low utilization); use embedding-based skill match (richer triggering but adds the vector dependency D24 rejected).

**Anti-decision**: We explicitly chose against manual-only skill invocation and against embedding-based skill match for v3.0.

---

## D36 — Single backend, no hedged maintenance — optimize for ship over portability

**Decision**: Where multiple backends are possible (issue adapter per D21, memory storage per D22, audit log per D23/D25), Forge ships **one** implementation and treats alternatives as future contingencies. No active maintenance of a second backend without an external trigger. Cross-harness portability is achieved via the parallel-manifest pattern already in `scripts/sync-commands.js` — not via duplicated implementations. ACTIVE.

**Rationale**: With zero external users, hedged maintenance pays an immediate engineering cost for a future option that may never be exercised. The parallel-manifest pattern handles cross-harness portability conventionally; Forge already implements ~80% of it.

**Tradeoff considered**: Maintain two backends per concern as insurance (preserves swap-out optionality at 2x maintenance); ship one backend with no abstraction (cheapest but couples Forge to one tool).

**Anti-decision**: We explicitly chose against actively maintaining a second implementation of any subsystem before an external trigger.

---

## D37 — 8-week realistic timeline (W0–W5), not 6 weeks  ·  **SUPERSEDED BY D39**

> **Status note (2026-04-29 iter #7)**: The "single 8-week MVP across W0–W5" framing was superseded by D39's **release versioning** (v3.0 / v3.1 / v3.2 / v3.3+). The W0–W5 wave breakdown is retained inside v3.0 as the build sequence (~5–6 weeks for v3.0 alone), but it no longer represents the full product. The original D37 reasoning is preserved below for the audit trail.

**Decision**: The canonical schedule is **8 weeks across 6 waves** — W0 (1.5w bootstrap + verification spikes) → W1 (2w L1 rails + introspection) → W2 (1.5w patch.md + upgrade + rollback) → W3 (1w 3-harness translator) → W4 (1.5w pattern detector + insights + recap + 2 templates) → W5 (0.5w cutover + 3rd template + ADRs + announce). The earlier "10-week MVP" framing in `v3-redesign-strategy.md §6 Option C` is replaced by this 8-week target, and the original "6-week locked plan" (Option B) is acknowledged as fiction per `quality-vs-speed-tradeoff.md`. SUPERSEDED-BY-D39.

**Rationale**: Per `reality-check-audit.md` and `quality-vs-speed-tradeoff.md`: the 6-week plan ignored L1 audit-log + secret-scan + signed-commits hardening; the 9–11w "honest range" assumes parity work that D32/D36 cut. Applying every efficiency-audit cut + the D32/D36 descopes lands the project at ~8 weeks.

**Tradeoff considered**: Hold to the 6-week locked plan (preserves the original commitment at the cost of cutting moat hardening); slip to the 9–11w honest range (preserves quality but admits a 50%+ slip from original).

**Anti-decision**: We explicitly chose against the 6-week plan (fiction) and against the 9–11w plan (over-delivers on workflow opinion at the cost of moat).

---

## D38 — Kill criteria: when do we abandon v3?

**Decision**: Forge v3 is killed (rolled back to v2 maintenance mode) if **any** of the following land within W0–W2: (a) `forge migrate --dry-run` does not produce a green diff on this repo's 228 issues by end of W0; (b) the cross-machine convergence benchmark (B5 in `n1-moat-technical-deep-dive.md`) shows >8s p95 even with embedded Dolt; (c) two of the three target harnesses (Claude / Cursor / Codex) cannot render a single skill correctly by end of W3; (d) Beads `bd audit record` integration (D23) fails benchmarks and D25 fallback also fails; (e) no external user shows interest by end of W5 launch. ACTIVE.

**Rationale**: Without explicit kill criteria, the iteration trap repeats — every audit produces "improve" or "defer", never "stop". Five concrete W0–W5 gates give the project a falsifiable definition of failure.

**Tradeoff considered**: No formal kill criteria (preserves optionality but produces "one more iteration" trap); harder kill criteria like "1 external user by end of W2" (more disciplined but probably unrealistic for a planning-stage product).

**Anti-decision**: We explicitly chose against shipping v3 without kill criteria, and against criteria so tight they trigger on normal slip.

---

# Iteration #7 (2026-04-29) — Release versioning

## D39 — Release versioning: v3.0 / v3.1 / v3.2 / v3.3+ replaces single-MVP wave plan

**Decision**: Forge v3 ships as **four versioned releases** with customer-facing pitches, not a single MVP. The W0–W5 wave breakdown (D37) is retained inside v3.0 as the build sequence; it no longer represents the full product. The four versions:

- **v3.0 — "Forge protects you AND follows you"** (~5–6 weeks, solo MVP). 5 L1 rails enforced; Beads-backed memory (`bd remember` / `bd recall` with Dolt in `embedded` mode); `forge init` / `migrate` / `upgrade` / `rollback`; `forge recap --since=yesterday` (solo mode); `/merge` continuous PR-state hook; **mandatory full 3-harness translator** (Claude + Cursor + Codex CLI); skills auto-invoke (Hermes-style description match) across all 3; `/plan` basic 1-tier (intent + lock); `/build` basic TDD loop (no evaluator orchestrator).
- **v3.1 — "Forge plans with rigor"** (~+3 weeks → ~9 weeks cumulative). Iteration-driven `/plan` 3 tiers (quick / standard / deep); classification auto-detect; parallel critics in deep mode; supersedes-tracked decisions ledger; continuous learning loop ON; `forge insights` pattern detector; `/build` evaluator orchestrator (test + spec-compliance + lint judges).
- **v3.2 — "Forge for teams"** (~+2 weeks → ~11 weeks cumulative). `forge recap --team` aggregates across team members; team patches (per-user overlays + shared `team-patch.md`); bidirectional agent-log ↔ docs links; `bd audit upstream --meta-json PR` (Plan A) or `.forge/log.jsonl` fallback (Plan B); docs-as-memory 7-category navigation.
- **v3.3+ — Ecosystem**. Cline / OpenCode / Kilo Code translators; marketplace expansion beyond seed; `/forge map-codebase`; profile sync; skill self-improvement; full evaluator suite; hardened sandbox.

D38 kill criteria now apply per-version (gate matrix in [release-plan.md](./release-plan.md)). ACTIVE — supersedes D37.

**Rationale**: A single-MVP wave plan answers "what order do we build" but not "what does each shippable version promise the user." Versioned releases let v3.0 ship and gain users without waiting for v3.1's planning rigor or v3.2's team mode. Each version has a bounded scope, a customer pitch, and gate criteria — three ingredients the W0–W5 framing lacked. Splitting team mode out of v3.0 also keeps the solo MVP small enough to actually ship in ~5–6 weeks.

**Tradeoff considered**: Hold the single-MVP framing and ship everything at once (preserves a single "v3 launch" marketing moment at the cost of 11+ weeks before any user gets value); split into more versions (v3.0a / v3.0b / v3.0c) for finer control (more release overhead without obvious user benefit).

**Anti-decision**: We explicitly chose against shipping all four versions as one MVP, and against further fragmentation below the 4-version split.

---

# Iteration #8 (2026-04-29) — Backwards-compat, Launch staging

> **Note on D41 (product name)**: A product-name rename was drafted in this iteration (D41 — "Forge Run") but is **HELD pending user evaluation of name options**. Not locked. The D41 slot is intentionally skipped to preserve numbering once the rename decision is made.

## D40 — Backwards-compat: Hybrid semver with deprecation lanes

**Decision**: Forge follows **hybrid semver** with explicit deprecation lanes:
- **Patches** (3.0.0 → 3.0.x): full backwards compatibility; no migration required.
- **Minors** (3.0.x → 3.1.0): may require `forge migrate`; the migration is **announced one minor ahead** via `forge doctor` warnings (so 3.0.x emits deprecation hints before 3.1.0 lands).
- **Majors** (3.x → 4.0): explicit breaking changes; full migration guide.

Every v3.0 artifact (config, patch.md, skill SKILL.md frontmatter, bd audit events) ships with `schema_version: 1.0` envelope (already in plan; reinforced here). ACTIVE.

**Rationale**: Hybrid semver gives users predictable expectations (patches always safe, minors sometimes need migration but always announced, majors are deliberate) while letting Forge iterate the schema fast at v3.x cadence. NIH dual-shape support (maintain old + new schema simultaneously inside a minor) was rejected as too expensive at our iteration pace.

**Tradeoff considered**: Hard back-compat (semver-strict — no schema changes at all within 3.x) preserves user trust at the cost of locking in early schema mistakes for an entire major. Pure rolling-release (no compat guarantees, just "always upgrade") cheapest to ship but kills enterprise adoption.

**Anti-decision**: We explicitly chose against semver-strict (too expensive for iteration speed) and against rolling-release with no guarantees (kills trust). Migrator cost is ~1–2 days per minor bump — acceptable.

---

## D41 — RESERVED (product name decision held pending user evaluation)

This slot is reserved for the product-name decision. A "Forge Run" rename was drafted in iteration #8 but is **NOT locked** — the user is evaluating name options. When a name is chosen, D41 will be filled in here with the standard format (decision / rationale / tradeoff / anti-decision).

---

## D42 — Launch staging: Private alpha v3.0 → Show HN v3.1 → ProductHunt v3.2

**Decision**: Forge Run launches in three staged moves aligned to the version cadence (D39):
- **v3.0 (~wk 6–7)** — **Private alpha**, 5–10 invited devs. No public announcement. Goal: shake out install + L1 rails + 3-harness translator on real repos.
- **v3.1 (~wk 9–10)** — **Show HN**. Wedge headline: *"Stop your agent from shipping plans a senior would reject"* — demoable iteration-driven `/plan` with parallel critics. Goal: developer mindshare, first wave of organic adoption.
- **v3.2 (~wk 11–12)** — **ProductHunt**. Marketing angle: team mode (`forge recap --team` + team patches). Goal: reach team buyers / engineering managers when team capability actually exists.
- **Build-in-public Twitter thread** runs throughout from v3.0 onward (this iteration session itself becomes proof-of-concept content).

ACTIVE.

**Rationale**: v3.0 alone is plumbing (memory + rails + 3-harness translator) — it gets dismissed on Show HN as "another agent harness." v3.1 finally has a demoable wedge ("plan rigor your agent lacks") that survives HN scrutiny. v3.2 reaches team buyers with concrete team functionality, not vapor. The cadence matches when each audience can actually be sold.

**Tradeoff considered**: "Show HN at v3.0" was rejected — the positioning critic correctly flagged v3.0 as plumbing without a demo wedge, and a weak HN launch poisons the brand. "Show HN at v3.2" was rejected as too late — competitors may ship something similar in the 4–5 week gap, and the build-in-public thread starves without milestones.

**Anti-decision**: We explicitly chose against an early HN launch at v3.0 (no wedge), against waiting until v3.2 (too slow, competitive risk), and against silent launches (no community pull, no learning loop from real users).

---

## Source documents

- [release-plan.md](./release-plan.md) — canonical release roadmap (v3.0 / v3.1 / v3.2 / v3.3+) per D39
- [n1-moat-technical-deep-dive.md](./n1-moat-technical-deep-dive.md) — moat analysis underpinning D8/D9, kill criteria substrate for D38
- [v3-ecosystem-audit.md](./v3-ecosystem-audit.md) — harness landscape underpinning D11/D13/D15
- [template-library-and-merge-flow.md](./template-library-and-merge-flow.md) — template scope underpinning D9/D26
- [v3-redesign-strategy.md](./v3-redesign-strategy.md) — canonical strategy doc, references this log
- [agent-memory-architecture.md](./agent-memory-architecture.md) — 7 typed memory categories underpinning D22/D24
- [beads-supabase-and-forge-memory-design.md](./beads-supabase-and-forge-memory-design.md) — Beads coexist analysis underpinning D21/D31
- [efficiency-audit.md](./efficiency-audit.md) — 10 efficiency wins underpinning D23/D25/D37
- [quality-vs-speed-tradeoff.md](./quality-vs-speed-tradeoff.md) — quality cuts underpinning D32/D37
- [reality-check-audit.md](./reality-check-audit.md) — timeline reality underpinning D37/D38
- [unconventional-alternatives.md](./unconventional-alternatives.md) — alternatives considered (sell-the-log, single-team, pure-runtime)
- [n1-survival-audit.md](./n1-survival-audit.md) — N=1 survival underpinning D26/D34
- [marketplace-patchmd-use-case-kits.md](./marketplace-patchmd-use-case-kits.md) — use-case validation for layered config
- [FINAL-THESIS.md](./FINAL-THESIS.md) — canonical "where we ended up" document
- [LEARNINGS.md](./LEARNINGS.md) — 15 takeaways from the iteration journey
