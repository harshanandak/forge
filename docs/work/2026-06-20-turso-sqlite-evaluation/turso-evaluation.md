# Evaluation: Migrating the Forge Kernel from SQLite to Turso / libSQL

| | |
|---|---|
| **Status** | Evaluation complete — recommendation issued |
| **Date** | 2026-06-20 |
| **Worktree / branch** | `.worktrees/turso-evaluation` / `eval/turso-sqlite-evaluation` (isolated, touches nothing else) |
| **Scope** | Decision memo only. No migration performed. |
| **Method** | 5 primary-source research agents → 3 adversarial refuters (job: *refute* "migrate now") → synthesis. Key code claims verified by direct read of `lib/kernel/*`. |

---

## TL;DR — Verdict: **Do not migrate now** (confidence ~88%)

> The only Turso product that offers the concurrent-write capability you're excited about is a **beta, ground-up reimplementation of SQLite** — and concurrent writes are the *one* thing the Forge Kernel is **deliberately designed against**. The production-ready Turso option (libSQL) keeps SQLite's single-writer model, so it gives Forge **zero** gain over the `bun:sqlite`/`node:sqlite` engine it already uses. On top of that, swapping the engine collides with locked decision **D44**.

Three sentences for why:

1. **It solves a non-problem.** Forge serializes kernel writes *on purpose* for claim-lease correctness; it is not write-throughput-bound. Turso's headline "multiple writers, no locking" is orthogonal-to-harmful here, not an upgrade.
2. **The feature lives in beta software.** Concurrent writes only exist in the Rust rewrite (`@tursodatabase/database`, v0.6.1, BETA — *"use caution with production data"*). Turso's own docs say *"libSQL is production ready, Turso Database is not."* You don't run a system-of-record on a pre-1.0 engine.
3. **It's a locked decision.** D44 fixes the local kernel authority on **SQLite WAL** (Cloudflare Durable Objects for team mode). Migrating now would require a formal D44 amendment *and* contradict its intent.

Your instinct wasn't wrong about the *technology* — Turso is genuinely SQLite-compatible, MIT-licensed, and aimed squarely at agents. It's wrong about the *timing* and the *fit*: the capability is immature, and Forge's kernel doesn't want it.

---

## 1. Where the features you cited actually live

You mentioned four things. They do **not** all live in one product:

| You wanted… | Delivered by | Maturity (June 2026) |
|---|---|---|
| "Built on SQLite" | libSQL **and** the rewrite | ✅ Stable in both |
| "Backward compatible" | **libSQL** (same file format + API) | ✅ Full. Rewrite is "backwards compatible" but beta |
| "Multiple / concurrent agent writes" | **Turso Database rewrite** (`BEGIN CONCURRENT` / MVCC) | ⚠️ Beta engine; in-process MVCC tier is ambiguous (see §3); **cross-process** path (`.tshm` sidecar) is **explicitly experimental** |
| "Agentic features" | (a) **AgentFS** — a *filesystem* SDK, not a SQL store; (b) the "agent databases" pattern = embedded rewrite + Turso Sync | ⚠️ AgentFS is beta; Sync requires the cloud or a self-hosted sync server |

**The unsatisfiable combination:** `{concurrent writes} + {production-ready} + {fully backward-compatible}` is **not available in any single Turso product** right now. Concurrent writes exist only in the beta rewrite (or private-beta Turso Cloud); the production-ready, fully-SQLite-compatible option (libSQL) keeps the single-writer model.

### The three products, disambiguated
- **Turso Database** (the "rewrite", formerly Limbo): in-process Rust reimplementation of SQLite. npm `@tursodatabase/database` (v0.6.1 stable / 0.7.0-pre.10), MIT. The *only* one with the concurrency story. Self-declared **BETA**.
- **libSQL**: Turso's mature SQLite **fork**. npm `@libsql/client` (v0.17.4, production-ready, 545 dependents). Keeps SQLite's single-writer model. In feature-freeze — *"new features are being developed in Turso."*
- **Turso Cloud**: managed platform, currently runs on **libSQL**; concurrent writes there is **private-beta / waitlist**.

---

## 2. The core finding — concurrent writes solve a problem Forge designed *against*

This is the crux, and it's why even a mature, free Turso wouldn't help today.

Forge's kernel **serializes writes on purpose** because serialization *is the mechanism of correctness*, not a limitation it tolerates:

- One `BEGIN IMMEDIATE` transaction per mutation, binding claim + event + projection-outbox atomically — verified at [`lib/kernel/broker.js:245-275`](lib/kernel/broker.js).
- Exactly one active claim per issue, enforced by a **partial `UNIQUE` index** on `kernel_claims.issue_id` (DB-enforced claim leases — the safety model proved in PR #220 / commit `9.5.x`).
- One broker per git common-dir prevents multi-worktree double-claiming (`test/kernel/broker-multiprocess.test.js`).

The reason a pre-read check is insufficient — and a write-boundary lock is required — is exactly the race a UNIQUE index closes: *two writers can both read "zero active claims" before either commits.* "Concurrent writes, zero conflicts, no locking" is **orthogonal** to how Forge achieves this. Adopting `BEGIN CONCURRENT`/MVCC would, if anything, add a conflict-retry burden for **zero** throughput benefit, because there is no measured throughput pressure to relieve.

**Forge is not write-throughput-bound.** Until that changes (see revisit triggers, §7), the headline feature has no customer here.

---

## 3. Maturity — the gating fact (date-sensitive, June 2026)

- `@tursodatabase/database` README: *"⚠️ Warning: This software is in BETA. It may still contain bugs and unexpected behavior. Use caution with production data and ensure you have backups."*
- Turso's own comparison: **"Maturity — libSQL: Production-ready · Turso Database: Evolving (beta)"**, and the FAQ: *"libSQL is production ready, Turso Database is not."*
- Version: stable **0.6.1**, latest is a prerelease (**0.7.0-pre.10**), **no GA**.
- **MVCC stability tier is genuinely ambiguous across sources** — honest finding, not a settled fact:
  - The rewrite's README lists `BEGIN CONCURRENT … MVCC` in its **main** feature list (not the experimental sublist).
  - But the `tursodb` quickstart exposes it via an **`--experimental-mvcc`** flag, alongside the note *"these features are not production ready."*
  - And the path Forge would actually exercise — **cross-process** multi-writer over one shared file — maps to the **`.tshm` sidecar, which is explicitly listed as experimental.**
- **Unverified correctness semantics for an authority store** (the disqualifier): Turso's `COMPAT.md` enumerates only `PRAGMA synchronous` **OFF/FULL** (Forge runs **NORMAL** — `broker.js:11`), and enumerates only plain `BEGIN TRANSACTION` — not the **`BEGIN IMMEDIATE`** write-lock-on-begin that lease correctness depends on. For a throughput cache these are footnotes; for the system-of-record they are blockers.

You do not bet an issue/claim/event ledger on mechanisms whose durability and lease timing you cannot cite.

---

## 4. Migration cost — corrected against the actual code

The research brief initially assumed a costly "sync → async rewrite." **That is overstated** — the code refutes it:

- The driver interface is **already async**: `async exec(...)` / `async queryAll(...)` wrapping synchronous `bun:sqlite`/`node:sqlite` — [`lib/kernel/sqlite-driver.js:157-162`](lib/kernel/sqlite-driver.js).
- The broker **already `await`s** every call, including `BEGIN IMMEDIATE` → inserts → `COMMIT`/`ROLLBACK` and `Promise.all([...])` — [`lib/kernel/broker.js:245-275`](lib/kernel/broker.js).
- Migration **surface is low** — ~3 files: `sqlite-driver.js`, `broker.js`, `forge-issues.js`.

So the mechanical edits are cheap. **The real cost is elsewhere:**

> Today the atomicity reasoning rides on the awaits resolving **synchronously** — there is no true suspension point between `BEGIN IMMEDIATE` and `COMMIT`. A genuinely-async Turso driver (io_uring design) inserts **real `await` yield points inside the transaction block**, so lease uniqueness, idempotency, and atomic claim+event+outbox commit must **all be re-proven** — i.e., re-earning the PR #220 safety proof on a reimplemented beta engine.

Additional concrete costs:
- `db.serialize()`-based backup (`sqlite-driver.js:275`, Bun path) is **unsupported** in the rewrite's JS binding → rework to `VACUUM INTO` and re-validate.
- **No safe phased rollout:** Turso COMPAT Guarantee #4 — *"we don't support mixed SQLite and Turso in multi-process scenarios"* — forbids running both engines against the shared kernel during a transition.

**Net:** low surface, *high safety-re-verification cost on beta foundations, for a feature Forge will never use.*

---

## 5. AgentFS — reality check

AgentFS is a **copy-on-write filesystem / state SDK for sandboxing coding agents** (named/shared sessions, audit logs, MCP server mode, NFS export, sync to cloud). SQLite is its *implementation detail*, not its interface.

- It provides **no** broker-serialized writes, **no** UNIQUE idempotency keys, **no** claim-lease index — it addresses no kernel need.
- Worse, its **per-session COW model forks state into isolated files per session**, which would directly **break** Forge's one-broker-per-common-dir / single-shared-`kernel.sqlite` invariant (two sessions would fork the claim ledger and double-claim).
- It is itself **beta**.

If AgentFS is interesting to Forge at all, it belongs to the **agent-orchestration / sandbox layer** (running agents safely), **never** the kernel data store. That's a separate conversation from this one.

---

## 6. Decision-fit: D44

**Disposition: `needs-amendment` — and migrating now also violates D44's intent.**

- D44 (`docs/work/2026-04-28-skeleton-pivot/locked-decisions.md:567-579`) locks: *Forge Kernel = authority on local **SQLite WAL** for solo mode; Cloudflare Durable Objects for team mode; Beads/Dolt = projection adapters.*
- The product that delivers the wishlist is a **from-scratch reimplementation** — "backward compatible" but **not SQLite, not the same engine**.
- Per `docs/reference/DECISION_DRIFT_GUARDS.md`, swapping the authority store touches *authority + storage* → requires a `PROJECT_DESIGN.md` amendment and a passing release-gate evaluator note. **Neither exists.**
- SQLite WAL was already chosen on **evidence** (~17× faster than Dolt, no server lifecycle). Turso was never in that evaluation. Overriding a locked, evidence-backed decision with a beta engine — to gain a feature Forge doesn't want — is exactly the drift D44's guards exist to prevent.

---

## 7. Honest upside + when to revisit

### What Turso genuinely offers (so we're not dismissive)
- **On-disk byte compatibility both directions** — Turso can open Forge's existing `.forge/kernel.sqlite` and vice-versa. (Relevant only *if* a migration ever happens; not a benefit in itself.)
- **WAL + standard `BEGIN/COMMIT/ROLLBACK` fully supported** — i.e. parity with what Forge already has, not a gain.
- **Self-hostable sync server** (`tursodb --sync-server`, no cloud account) + Turso Sync `push()`/`pull()` — potentially interesting for *team mode*, but D44 routes team mode to Cloudflare Durable Objects.
- **Adjacent agentic capabilities** (CDC, native vector search, built-in MCP server mode) — none address the kernel's issue/claim/event needs today.

### Revisit triggers (re-open this evaluation when **any** become true)
1. Turso Database (rewrite) reaches **GA / 1.0** — the BETA warning is gone and the vendor stops saying "not production ready."
2. `COMPAT.md` documents parity for **`BEGIN IMMEDIATE`** write-lock-on-begin **and** `PRAGMA synchronous=NORMAL` durability (both upgraded from unverified/Partial).
3. A **GA, non-experimental cross-process** coordination path replaces the experimental `.tshm` sidecar and benchmarks at parity with SQLite WAL for the multi-worktree single-broker model.
4. Forge becomes **measurably write-throughput-bound** (observed broker lock-wait / `busy_timeout` contention across many concurrent worktrees that intentional serialization genuinely cannot meet).
5. Team mode is **deliberately re-decided** to adopt Turso Cloud concurrent writes (once GA) over Cloudflare Durable Objects — with a formal D44 amendment.
6. A concrete kernel requirement emerges that Turso *uniquely* satisfies (e.g. native CDC for the projection outbox, or built-in vector search) that `bun:sqlite`/`node:sqlite` cannot meet.

### Optional throwaway spike (if you want empirical proof *now*)
A **never-merged** branch: install `@tursodatabase/database`, point it at a **copy** of `.forge/kernel.sqlite`, and run the existing broker suite against it — especially `test/kernel/broker-multiprocess.test.js` and the claim-lease-conflict / idempotency tests. This empirically answers the doc-unanswerable questions: does `BEGIN IMMEDIATE` acquire the write lock at begin? does `synchronous=NORMAL` behave durably? does the partial-UNIQUE claim-lease index behave identically? **If the multiprocess/lease tests don't pass cleanly → decisive NO-GO.** If they do → it informs a *future* re-evaluation but still doesn't justify migrating off a beta engine today.

---

## 8. If you insisted on adopting something anyway

Neither helps Forge today:
- **libSQL** (`@libsql/client`) is the lower-risk landing (production-ready, same file format + API) — but it keeps SQLite's single-writer model → **zero** gain over current `bun:sqlite`/`node:sqlite`, and it's in feature-freeze.
- **The rewrite** (`@tursodatabase/database`) is the only one with the concurrency story — but it's **beta**, pre-1.0, with unverified lease/durability semantics and an experimental cross-process path.

**Recommendation stands: stay on the built-in SQLite engine; adopt neither yet.**

---

## Sources
- Turso intro & docs index — https://docs.turso.tech/introduction , https://docs.turso.tech/llms.txt
- libSQL vs Turso Database comparison (maturity, single-writer note, "Cloud runs on libSQL") — https://docs.turso.tech/libsql.md
- Turso Database rewrite (BETA warning, `BEGIN CONCURRENT`/MVCC, `.tshm` sidecar experimental, file-format compat) — https://github.com/tursodatabase/turso , https://www.npmjs.com/package/@tursodatabase/database
- `tursodb` quickstart (`--experimental-mvcc` flag, "not production ready") — https://docs.turso.tech/tursodb/quickstart
- Agent databases pattern (embedded + Turso Sync; "no built-in multi-agent collaboration") — https://docs.turso.tech/guides/agent-databases.md
- AgentFS (filesystem SDK, COW, sessions, MCP) — https://docs.turso.tech/agentfs/introduction.md
- Turso Cloud concurrent-writes private beta / pricing — https://turso.tech/pricing
- `@libsql/client` (v0.17.4, production-ready) — https://www.npmjs.com/package/@libsql/client
- Forge code verified directly: `lib/kernel/sqlite-driver.js:157-162`, `lib/kernel/broker.js:245-275`; D44 at `docs/work/2026-04-28-skeleton-pivot/locked-decisions.md:567-579`; `docs/reference/DECISION_DRIFT_GUARDS.md`.

## Appendix — adversarial review result
Three independent skeptics were each tasked with **refuting** "Forge should migrate to Turso now." All three returned **strong** refutations:
- **Maturity / risk:** betting a correctness-critical authority store on a self-declared-beta engine with unverified lease/durability semantics is the textbook anti-pattern.
- **Real-problem:** Turso's headline feature targets the exact dimension Forge deliberately does not optimize → solves a non-problem; AgentFS conflicts with the kernel's core invariant.
- **Migration-cost + D44:** low file surface, but the bottleneck is re-earning the PR #220 safety proof on beta foundations; requires a D44 amendment and violates its intent.
