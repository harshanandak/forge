# Forge v3 — LEARNINGS from the iteration journey

**Date**: 2026-04-29
**Status**: 15 takeaways from ~6 major iterations of the v3 skeleton pivot
**Companions**: [FINAL-THESIS.md](./FINAL-THESIS.md) · [locked-decisions.md](./locked-decisions.md)

Each learning: title → context (what we believed before / what we learned / what changed) → action (one line).

---

## 1. We were 1 commit away from replacing Beads when we should have leaned harder

**Context**: Iteration #5 spent two days designing a `forge-memory` JSONL+SQLite issue adapter to "escape the Dolt server pain." Iteration #6 research showed Forge uses ~25% of Beads' shipped surface — `bd remember`, `bd preflight`, `bd doctor`, `bd formula`, `bd pour`, `bd prime` are all unused. The "Supabase migration" worry was a misread of CHANGELOG; there is no Supabase migration.

**Action**: D31 — keep Beads, adopt the unused surface, ship the IssueAdapter interface as future-proof only.

---

## 2. Dolt server worktree pain has a 5-minute config fix

**Context**: We treated `.beads/dolt-server.lock` / `.beads/dolt-server.pid` worktree contention as architectural. It is a config knob: switch local development to embedded mode. Server mode stays for cross-machine sync.

**Action**: D30 — ship `forge sync --mode=embedded`; document the toggle.

---

## 3. Stages aren't monoliths — they're templates with phases

**Context**: The iteration #1 7-stage model treated `/plan`, `/dev`, `/validate`, `/ship`, `/review`, `/premerge`, `/verify` as atomic. Real workflows showed `/validate` running stale after `/dev`, `/premerge` getting forgotten, and `/plan` being skipped when teams already had Linear/Jira.

**Action**: D27 (validation continuous inside `/dev`), D28/D33 (`/merge` is a hook), D34 (`/plan` optional), D29 (final list: 5 stages + 1 hook).

---

## 4. `/premerge` as a separate stage was wrong — it's a continuous hook

**Context**: Premerge checks (doc updates, ADR links, Beads close) are deterministic from PR state. Modeling them as a stage forced humans to remember to invoke; they forgot. Hooks fire on the right event, every time.

**Action**: D28/D33 — `/merge` becomes a lefthook + GitHub event hook on PR-state transitions.

---

## 5. `/plan` as required was wrong — bring your own planner

**Context**: Forge's value is the iteration loop + memory + skill library, not the planner. Many teams have planning tools they trust (Linear, Jira, design docs). Forcing `/plan` couples Forge to one planning UX and creates duplicate-planning friction.

**Action**: D34 — `planner: external` config; Forge enters `/dev` from any structured task list.

---

## 6. Skills auto-invoke via description match (Hermes proves the model)

**Context**: We initially designed Forge skills with manual `/skill <name>` invocation. Hermes-style description-match is already proven across the Anthropic skill ecosystem; manual invocation guarantees low utilization.

**Action**: D35 — skills declare a `description` with trigger keywords; runtime auto-invokes on prompt match.

---

## 7. Forge isn't a workflow tool — it's a skill pack + runtime

**Context**: Earlier iterations framed Forge as "a 7-stage TDD-first workflow." Users actually feel the skill library; runtime is the invisible spine. The pitch is "install once; agent gets memory + spine + iteration loop + auto-activating skills."

**Action**: 3-tier architecture in FINAL-THESIS — harnesses / skills / runtime, with skills as the explicit product.

---

## 8. Memory needs typed categorization, not flat dumps or new datastores

**Context**: Forge's `memories.jsonl` collapsed at least four memory types (decisions, episodes, skills, preferences) into one undifferentiated stream. The literature has converged on typed memory with per-category retention rules. Forge already has six of the seven backends — the gap was a category dimension on writes.

**Action**: D22 — typed memory API (`forge.remember/recall/forget/compact`) over seven existing backends; no new database.

---

## 9. Vector stores are NOT the right shape for primary memory

**Context**: We considered shipping embeddings + vector store as the v3 memory primitive. SQLite FTS5 over markdown plus filename/keyword conventions covers ~90% of coding-agent recall with zero embedding-model lock-in or staleness.

**Action**: D24 — no vector store as primary memory; revisit only if FTS5 demonstrably fails on a real task.

---

## 10. The sandboxed-agent concern was overweighted

**Context**: ~3 design iterations spent worrying about sandboxed-agent compatibility based on one open Beads issue (#3582). Real audience is small; upstream fix is in flight; D30 embedded mode covers most cases. The kill-criterion fallback (D21 IssueAdapter) covers the rest.

**Action**: D32 — sandboxed-agent hardening descoped to v3.2+ pending demand.

---

## 11. Critics caught major issues that producers didn't see

**Context**: Three of the largest pivots (memory typing, audit collapse to `bd audit`, Beads-coexist instead of replace) came from explicit critic-loop docs (`agent-memory-architecture.md`, `efficiency-audit.md`, `beads-supabase-and-forge-memory-design.md`) — not from the original plan. The original plan would have built three NDJSON writers and a vector store.

**Action**: Treat critic loops as load-bearing — not as polish. Run them BEFORE locking decisions, not after.

---

## 12. The "future-proof" filter

**Context**: For every dependency we considered (Beads/Dolt, agentskills.io, Greptile, Cursor frontmatter spec): if this dep disappears or changes, can Forge still work? Beads passes (D21 IssueAdapter as escape hatch). Vector embeddings would not have (model lock-in). agentskills.io passes (D12, file format is open).

**Action**: Apply the filter explicitly to every external dependency before adopting; document the escape hatch.

---

## 13. Single backend > hedged maintenance (no users yet, optimize for ship)

**Context**: We initially planned to ship two issue backends, two memory backends, two audit log shapes "for safety." With zero external users, hedged maintenance pays an immediate engineering cost for a future option that may never be exercised.

**Action**: D36 — ship one implementation per concern; alternatives are interfaces only until external trigger.

---

## 14. Cross-harness portability is conventional — Forge is mostly there already

**Context**: Multi-harness support was framed as a major build (translator workstream, six target adapters). The actual mechanism — parallel manifests via `scripts/sync-commands.js` `AGENT_ADAPTERS` — already covers ~80% of what we need. Cursor `.mdc` frontmatter and OpenCode `opencode.json` are the only real shape gaps.

**Action**: D14/D15 — fold translator into existing N7+N10; ship 3 harnesses, defer 3 to v3.1.

---

## 15. Beads is mature; most pain is resolvable — don't panic-replace mature tools

**Context**: The "replace Beads" framing came from real but small-surface bugs (server lifecycle, init safety, worktree race). Each had an open upstream PR or workaround. Replacing 3 years of Beads work with 3 weeks of `forge-memory` work would have shipped a regression.

**Action**: D31 — coexist; D21 IssueAdapter as future-proof; treat panic-replace of mature tools as a smell.

---

## Meta-takeaway: the iteration trap

Six iterations produced ~30 design docs, ~38 decisions, multiple supersedes. Without explicit **kill criteria** (D38), iteration #7, #8, #9 would have happened. The fix is shipping criteria that produce a definite YES/NO at each wave gate — not "improve" or "defer" verdicts that compound forever.

> **Ship the moat at full quality. Ship everything else at 80% with refuse-with-hint as the fallback when it breaks.** — `quality-vs-speed-tradeoff.md`

Word count: ~810
