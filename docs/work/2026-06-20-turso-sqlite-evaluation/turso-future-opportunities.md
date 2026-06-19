# Forge × Turso — Future Opportunity Map

> **Companion to [`turso-evaluation.md`](turso-evaluation.md).** That doc answered *"should we migrate now?"* → **no**. This doc answers *"what's the prize if we ever do, and how could Forge become a genuinely better platform?"* — a **thinking/improvising artifact to gather ideas, not a migration plan or a counter-proposal.** The "do not migrate now / adopt neither yet" verdict still stands. Every authority-touching idea below would trigger the `DECISION_DRIFT_GUARDS` path (a `PROJECT_DESIGN.md` amendment + re-verification of lease/idempotency atomicity on a new driver).

| | |
|---|---|
| **Status** | Vision / opportunity exploration |
| **Date** | 2026-06-20 |
| **Worktree / branch** | `.worktrees/turso-evaluation` / `eval/turso-sqlite-evaluation` |
| **Method** | 6 grounded idea-generation lenses → curation pass (dedup, impact scoring, tiering, conflict-flagging) |

---

## North Star — the single biggest transformation

**Collapse Forge's two-engine authority split into one.** Today D44 runs the kernel on two different engines: local SQLite WAL broker (solo) **and** Cloudflare Durable Object + D1 (team) — two codepaths, two failure models, every entity modeled twice (Local-vs-Server matrix). Turso's **local-first libSQL with embedded replicas + a single serializing primary** could make solo and team the *same schema, same write contract, same conformance suite* — solo is a "replica-of-one," team is "replica-of-N against one primary." That is two codepaths becoming one.

**The non-negotiable catch (read this before getting excited):** async embedded-replica sync provides **no cross-machine mutual exclusion**. The claim lease is a global mutex; it is only safe if a **single online serializer enforces first-committer-wins on the claim row** and rejects the loser. Async "local-write-then-push" would let two devs both "win" the same claim until convergence — which is exactly the D7/D14 reason Dolt-as-authority was rejected. So unification is real **only** if the primary arbitrates the lease synchronously. Until that's proven, Turso unifies the *convergent schema*, **not** the lease arbiter.

---

## Top 5 transformational ideas (deduped across lenses)

1. **Unified solo+team engine** — one libSQL topology replaces broker + Durable Object + D1. libSQL is byte-compatible with the existing `.forge/kernel.sqlite`; solo = sync-server-of-one (offline-first preserved, no mandatory cloud), team = same engine with more replicas pointed at a self-hostable primary that inherits the Durable Object's serialized-writer role. *Precondition:* rewrite GA + **verified** first-committer-wins on the sync server's claim row + a formal D44 amendment.

2. **Embedded-replica read mirror** powering live `/status`, orientation, dashboards, and multi-dev awareness across machines — the **highest-confidence near-term win.** Each machine holds a read-only replica refreshed by `pull()`; the outbox drainer `push()`es to a shared remote. Retires the brittle 2026-03-22 multi-dev-awareness file-index-over-git-refs pain *without* committing tracker state to the protected branch (Authority Rule 8) and *without* touching the lease. Stale reads are safe — the primary re-validates `expected_revision` at claim time (the documented TOCTOU fix), so a stale replica can only cause a *rejected* claim, never a double-claim.

3. **Read-only knowledge sidecar with native vector + hybrid (FTS5+vector) recall** — the "have we solved this before?" retriever the agent-memory design names but defers. libSQL native vector search (production-ready, *not* beta) in a separate, rebuildable `knowledge.sqlite`, fused with Forge's already-proven FTS5 via reciprocal-rank into the reserved-but-empty `recall mode:'hybrid'`. **Never touches the kernel authority store**, so it sidesteps every D44 / lease-correctness / "do not migrate" blocker — a corrupt sidecar is just rebuilt.

4. **Forge kernel as an agent-native MCP read surface** — expose read-models (D16 JSONL, D18 taxonomy, ready queue, claim ownership) over a read-only MCP server so any MCP-capable harness (Claude Code, Cursor, Codex, dashboards) builds on Forge as an issue authority instead of shelling out to `forge` and parsing text. **Buildable today with zero engine change** (it's decision-options Option A's read-only MVP). Writes stay strictly through broker → command contract → lease-enforcer.

5. **AgentFS COW sandboxes + shared sessions for the `/dev` subagent fleet** — wrap the implementer+reviewer loop in copy-on-write overlays: a failed task discards instantly (no git surgery), a passing task commits only after reviewers go green, and a named shared session gives reviewers the implementer's *actual execution trail* (RED@T1 → GREEN@T3, what was tried/rejected) instead of just a diff. Orthogonal to lease serialization → genuinely low-tension. *Caveat:* the overlay must cover only the code worktree, **never** `.forge/kernel.sqlite`.

---

## Tiered roadmap

### Tier 1 — Near-term (production-ready libSQL today × non-authority state)
*No D44 amendment, no lease re-proof, no beta dependency. The credible spine.*

| Idea | Unlocks | Precondition | Risk |
|---|---|---|---|
| **Embedded-replica read mirror** for `/status`, orientation, dashboards | Instant, offline-capable reads from a per-machine replica; read fan-out scales across a fleet | libSQL byte-compatible; wire as an additional read-only outbox target | Additive convenience, not correctness; must be stamped non-authoritative |
| **Presence channel** for multi-dev awareness (replaces file-index-over-git-refs) | Live cross-machine "who's working on what" without piggybacking on git commits/refs | Forge-owned presence schema + offline-degraded mode for solo | Advisory/eventually-consistent — soft-block UX only, never a lease |
| **Knowledge sidecar with native vector search** | Semantic "solved this before?" recall over decisions/episodes/skills/PR-reviews; rebuildable, never touches authority | Knowledge MVP exists; embedding source chosen; clears the "FTS5 demonstrably fails" gate | Two-DB complexity; embedding staleness/lock-in; dead weight if FTS5 suffices |
| **Hybrid keyword+vector recall** reusing Forge's FTS5 | RRF of exact tokens + paraphrase → the reserved `recall mode:'hybrid'` with cited provenance | Both indexes in one knowledge DB; typed-memory recall API fuses two result sets | Low tech risk but presupposes adopting vector at all |
| **Forge-authored MCP read surface** over existing read-models | Structured reads (ready queue, claim ownership, stage/run state) for any MCP harness | Reads only; writes stay through broker → lease-enforcer | Scope creep into writes silently re-creates an invariant break — read-only guardrail must be explicit |
| **AgentFS COW worktree sandbox** per implementer subagent | Instant whole-session rollback of a failed task; commit only after reviewers green | Overlay covers ONLY the code worktree, never the kernel file | Windows COW support unverified (Forge is Windows-first); two overlay systems to reconcile |
| **AgentFS shared session** as implementer→reviewer handoff + A09 audit trail | Reviewers read the auto-tracked tool-call trail; structured decision-gate evidence; OWASP-A09 audit | Dispatch→session shim is net-new; path redaction is a Forge-side policy layer | Overlaps existing `.beads/interactions.jsonl` audit — reconcile, don't duplicate |

### Tier 2 — Medium (needs verification or a deliberate D44 amendment)

| Idea | Unlocks | Precondition | Risk |
|---|---|---|---|
| **Unify solo+team on a self-hosted libSQL sync primary** (replace Cloudflare codepath) | One schema/one engine for solo+team; eliminates bespoke D1 projection; self-hosting keeps offline-first for solo | Formal D44 amendment; claim lease routes through a single online serializer with **verified first-committer-wins** | Contradicts D44 as written (re-open, don't sneak); team claims can never be offline-authoritative; reintroduces server lifecycle; libSQL in feature-freeze |
| **Native CDC feeding the projection outbox** | Committed event stream becomes the outbox; same projection codepath solo+team; instant GitHub/Beads push | CDC ships in the beta rewrite → GA, or run CDC on a downstream replica | Largely **duplicates** infra Forge owns (events table is already a change-stream; outbox already at-least-once); pointed at authority DB pulls in the beta engine |
| **Encryption-at-rest for the kernel file** | `forge kernel encrypt` opt-in for laptop/data-at-rest compliance — the one place a libSQL swap buys a capability the built-in engine lacks | Adopt libSQL driver for that path; **verify** `synchronous=NORMAL`/`BEGIN IMMEDIATE` durability parity first | Triggers authority-store-swap drift path; **OS-level disk encryption may cover this at zero kernel risk — evaluate first** |
| **Vector search over shared fleet-memory** | Any agent retrieves "what a sibling already learned about this module"; per-session memory → cross-agent shared knowledge | Vector available in libSQL today; depends on shared-sync substrate + knowledge sidecar; D3/D4 scoping rules | The D3/D4 boundary — local-only content must not be blanket-synced across machines |
| **Semantic conflict-candidate detection** across agent memories | Vector NN flags "we use Bun" vs "we migrated to npm" as conflict candidates → `knowledge.conflict.raised` event + human-adjudicated supersedes | Federation proposal layer (Option D) **and** vector index | Embedding similarity is a noisy signal — needs tuned threshold + human gate, never auto-supersede |

### Tier 3 — Speculative / moonshot
*Touches lease/issue-row authority, rides experimental features, or reintroduces the semantic-merge problem that got Dolt rejected. Park as documented revisit-triggers.*

- **DBSP incrementally-maintained ready-queue / dashboards** — maintained-as-you-write materialized views. *Gated on rewrite GA + DBSP stabilizing; safe path is on a downstream replica, never the authority engine. A hand-rolled incremental refresh over the events tail likely reaches ~80% of the value with none of the beta risk.*
- **Per-PR / per-worktree DB branching for non-authoritative kernel metadata** — the bounded slice of Dolt's "try a plan in isolation, merge if it lands." *Turso gives the branch mechanism, not the row-merge semantics (the exact thing that got Dolt rejected). Claims can never be branched — a lease is a global mutex.*
- **Branch/merge of issue-state read-models via Turso Cloud branching** — *the most speculative; directly collides with D44 (team = Cloudflare DO) and Turso Cloud concurrent writes is private-beta. Exactly the drift D44's guards exist to prevent.*
- **Embedded-replica sync as a second path to team shared memory** — *re-opens the solo/team unification the eval closed; risks a second sync mechanism diverging from the authority path.*
- **Replayable `/dev` sessions as an eval/regression harness** — A/B prompt/gate changes against identical starting state. *Honest framing is "reproducible-starting-state A/B harness," NOT bit-exact time travel — agent sessions aren't deterministic.*
- **Queryable audit/event-stream via Turso's native DB-as-MCP mode** — *the native-DB-MCP variant implies adopting the Turso engine (eval: not now); the Tier-1 Forge-authored MCP server is the lower-risk equivalent.*

---

## How this aligns with Forge's existing v3 / kernel direction

These ideas are mostly **the v3/D44 direction made literal**, not a detour:

- **Unification IS the stated direction.** D44's own framing calls "unifying solo+team on one engine strategically attractive." The embedded-replica topology is the most direct expression of it — replacing the parallel Cloudflare codepath rather than sitting beside SQLite, collapsing the duplicated Local-vs-Server matrix into one schema.
- **The non-authority Tier-1 ideas slot into already-decided seams.** The read mirror is just another outbox target (the outbox/dead_letters/projection pattern already exists). The knowledge sidecar is decision-options **Option B** ("the home for vector search added later"). The MCP read surface is **Option A**'s read-only-MVP-first sequencing. AgentFS sandboxing is decision-options' "Option B — optional execution sandbox for substages." **None require new decisions.**
- **Agent memory is the clearest additive synergy.** Vector + hybrid recall fills the reserved-but-empty `recall mode:'hybrid'` and the FTS/vector "deep search" layer the federation docs already drew; conflict-candidate detection feeds the `knowledge.conflict.raised` event Option C enumerates and the supersedes-edges the architecture doc names.
- **Authority invariants are preserved by construction.** Reads/awareness/projections ride async sync; authoritative writes (claim/stage/close) stay serialized through the primary; Authority Rule 5 ("read model, not claim authority") and Rule 8 ("never commit tracker state to the protected branch") hold — embedded replicas are literally *the better read model that lets multi-dev awareness exist without git-committing tracker state.*

---

## Honest caveats (the credibility section)

- **The write-path discriminator is non-negotiable.** Async sync gives no cross-machine mutual exclusion. Any "Turso Sync makes offline team claims work" framing is simply wrong — D44 already states team claims are never offline-authoritative. The lease is safe only if a single online serializer enforces first-committer-wins and rejects the loser.
- **CDC and DBSP largely duplicate infra Forge already owns.** The append-only events table is already a change-stream; the transactional outbox already guarantees at-least-once with `dead_letters`; D16/D18 read-models already work deterministically. The win is *latency/maintainability*, not new capability.
- **Encryption-at-rest may be fully covered by OS-level disk encryption** at zero kernel risk — evaluate that cheaper, safer path first.
- **Vector/semantic recall must clear the agent-memory doc's own gate** — adopt it only *after* FTS5 recall "demonstrably fails" in practice (the doc expects FTS5 to cover ~90% of coding-agent recall). It adds an embedding-model staleness/lock-in dependency.
- **Several capabilities the strongest ideas lean on are UNVERIFIED** (features of the map, parked in preconditions — not facts): synchronous write-to-primary / first-committer-wins on the self-hosted sync server, CDC transactional ordering, `BEGIN CONCURRENT` semantics, and Windows COW support for AgentFS. **libSQL is in feature-freeze**, so its only real net-new capability over `bun:sqlite`/`node:sqlite` is encryption + vector search.
- **DB branching gives the mechanism but not the issue-row merge semantics** — the unsolved semantic-merge problem that got Dolt rejected. Claims can never be branched at all.

---

## Watch-list — signals that unlock each tier (concrete revisit triggers)

1. **Turso rewrite reaches GA** — unblocks CDC, DBSP, and rewrite-engine unification variants.
2. **Self-hosted sync server demonstrates a verified synchronous write-to-primary / first-committer-wins path on a contended row** — the single signal that flips engine-unification from "schema only" to "lease arbiter included."
3. **`BEGIN CONCURRENT` / MVCC leaves beta** with conflict-resolution proven against the one-active-claim invariant (not last-write-wins row merge).
4. **Native CDC leaves beta** with confirmed transactional ordering + at-least-once matching the outbox's close-after-create assumptions.
5. **libSQL parity confirmed for `PRAGMA synchronous=NORMAL` and `BEGIN IMMEDIATE` durability** — the gate before any authority-store driver swap (e.g. encryption-at-rest).
6. **A deliberate D44 amendment + `PROJECT_DESIGN.md` change is authored** — the governance precondition for any team-authority-codepath change.
7. **FTS5 recall measurably fails in practice** on real coding-agent queries — the trigger to add vector search rather than pre-empt it.
8. **Windows COW / overlay support for AgentFS confirmed** — Forge is Windows-first, so this gates the entire sandbox/replay line for the primary dev environment.
9. **Turso Cloud DB branching becomes GA with a defined row-merge policy** — the trigger for the bounded branch/merge ideas (still gated on a D44 amendment for issue-state branching).
10. **Turso's DB-as-MCP server mode matures** — the optional trigger to consider the native-transport MCP variant over the Forge-authored read-model MCP server.

---

## Bottom line

The genuinely exciting future case for Turso isn't "concurrent writes" (Forge designs against that) — it's **one engine for solo+team**, a **RAG-native knowledge layer**, and **auditable agent sandboxes**, several of which (read mirror, knowledge sidecar, MCP read surface, AgentFS sandboxing) are **Tier-1: buildable on production-ready pieces without touching the kernel authority or D44.** Those are the ideas worth keeping warm. The authority-store unification is the moonshot — strategically aligned with v3, but gated on the rewrite reaching GA *and* a proven synchronous claim arbiter *and* a deliberate D44 amendment.
