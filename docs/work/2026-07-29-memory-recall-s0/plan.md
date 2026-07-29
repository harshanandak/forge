# S0 automatic memory recall

Date: 2026-07-29

Issue: `36461e50-da2e-43e4-bb4a-ae58aac08591`

Branch: `feat/memory-recall-s0`

Status: awaiting plan approval

## Purpose

Make relevant project memory reach an agent automatically and safely through Forge's existing recall and hook paths. This S0 is a reliability completion: it extends `kernel_memories`, its FTS5 index, `forge recall`, `forge prime`, and the existing Claude lifecycle commands. It does not create another memory engine, hook family, schema, or cross-project memory authority.

## Reproduced release failure

The reported miss is reproducible on the current checkout:

- The user-global `C:\Users\harsha_befach\.remember` store contains Forge-related summaries, but `forge recall "re-invented Forge capabilities discovery problem" --json` returned zero notes.
- Feeding the matching holdout prompt to the real Claude `hooks memory-recall` command returned zero bytes.
- The existing project `.claude/settings.json` contains no Forge `SessionStart`, `UserPromptSubmit`, `PreCompact`, or `Stop` entries.
- Manually invoking `hooks session-start --harness claude` returned valid context but took 58,882 ms and emitted 6,525 bytes, beyond the documented 30-second prompt-hook safety window.

The focused baseline remains green: 103 tests passed across current memory, FTS5, hook, setup, and orientation suites. The gap is activation, filtering, bounded live execution, and proof.

The external `.remember` miss is intentionally not repaired in S0. Live headings such as `## 18:30 | unknown` do not carry a machine-readable canonical repository identity. Guessing from a slug, working-directory text, or worktree parent would permit cross-project leakage. S0 proves the automatic path with project-local Kernel memory only.

## Success criteria

1. A clean setup and safe upgrade repair install exactly one Forge-owned Claude group for each existing lifecycle event while preserving every user-owned hook.
2. A project-scoped confirmed-memory holdout reaches Claude `additionalContext` without the prompt naming Forge memory or running `forge recall`.
3. Cross-project, stale suggested, and validly superseded records never enter automatic context.
4. Recall results use one normalized hit shape:

   ```text
   memory_id
   type
   content
   scope
   trust_status
   provenance or source_ref
   updated_at
   ```

5. `kernel_memories.key` remains `memory_id`; the contract is derived from existing fields. No schema migration is added.
6. Scope, trust, staleness, already-seen, and supersession eligibility are SQL predicates applied before BM25 ordering and the candidate `LIMIT`.
7. More than one candidate-window of stronger foreign rows cannot hide an eligible local result.
8. Trust follows one executable precedence: explicit `trust:confirmed`; auto-capture suggested; legacy import suggested; typed machine suggested; otherwise an exact human `forge remember` string confirmed; unknown forms suggested.
9. Type follows one executable precedence: recognized `type:` tag, then recognized structured `value.category`, then `machine-record` for other structured values. Plain human strings remain `note`.
10. Suggested context is visibly labeled as non-authoritative and requires verification. Stale suggested context is manual-recall only.
11. FTS5 BM25 remains primary. Source/trust weight and `updated_at` are deterministic secondary signals only.
12. Automatic prompt memory and SessionStart memory each stay at or below 400 estimated tokens. Default human `forge recall` stays at or below 1,200 estimated tokens.
13. On a representative 1,000-record local fixture, in-process recall p95 is at most 250 ms. The real prompt hook completes within 5 seconds and SessionStart within 10 seconds; each fails open on its own deadline.
14. Every retrieval attempt records a bounded `memory.recall.observed` event with outcome, counts, selected ids, token estimate, aggregate source/trust mix, elapsed time, and harness.
15. Telemetry stores no prompt text, normalized prompt terms, memory bodies, or snippets. Query correlation is omitted by default; if later proven necessary, only a keyed, locally salted fingerprint is allowed, with its key/salt absent from the event.
16. Deterministic holdouts pass positive, isolation, authority-denial, privacy, deadline, and failure cases. Agent-behavior use remains owned by integration-tail issue `d362bd71`.

## Out of scope

Explicitly deferred:

- User-global `.remember` federation. A producer must first emit machine-readable canonical project identity; that producer change is not part of this issue.
- PostgreSQL and team ACL/server authority.
- Memory lifecycle state machines, CAS/history, and retention/deletion APIs.
- Memory entity events and outbox projectors; S0 telemetry is a non-projecting project diagnostic event.
- Graphiti, embeddings, or reranking.
- Deletion replay for external projections.
- Product Suite exchange.
- Static typed-memory instruction projection.
- New dashboards or insights panels.
- A new workflow stage, memory database, engine, hook event, or cross-harness protocol.

## Selected approach

Extend the existing vertical path:

```text
project-local notes / kernel_memories
        ↓ normalize from existing fields
SQL scope + trust + staleness + supersession eligibility
        ↓
existing kernel_memories_fts MATCH
        ↓
BM25 order + bounded candidate limit
        ↓
existing applyBudget / recall packer
        ↓
forge recall / forge prime / existing Claude lifecycle hooks
        ↓
bounded privacy-safe Kernel telemetry event
```

This is the smallest safe approach because the database, FTS5 triggers, ranker, budget helper, hook renderer, and lifecycle commands already exist.

## Project identity

Use a deterministic worktree-normalized project identifier derived from the canonical real path of Git's common directory:

1. Resolve Git's common directory for the active worktree.
2. Convert it to a canonical absolute real path.
3. Normalize separators and Windows path case.
4. Use that stable repository-local value for project eligibility and event identity.

Sibling linked worktrees share the same Git common directory, while separate repositories do not. S0 must not depend on or invent a project UUID that the current store does not provide. If this identity cannot be resolved, automatic recall fails open and reports an unsupported/error outcome without widening scope.

## Source and normalization rules

### `kernel_memories`

- `key` → `memory_id`.
- `value_json` → `content` using the existing readable renderer.
- Recognized reserved `type:` tag → `type`.
- Otherwise recognized structured `value.category` → `type`.
- Otherwise structured value → `machine-record`; plain human string → `note`.
- Explicit `scope` remains explicit. Null scope in the current per-project Kernel store means only the resolved current project, never global or team.
- `source_agent`, tags, and source refs → provenance and trust.
- `updated_at` → `updated_at`.
- `supersedes_json` participates in eligibility before ranking.

### Retired `.forge/memory/notes.jsonl`

Keep the existing one-time project-local import. Imported records retain deterministic ids/content hashes and imported provenance. They are suggested unless explicitly confirmed.

### User-global `.remember`

Do not read, parse, import, index, or inject it in S0. Current headings do not provide an authority-safe repository identity. Even an apparently matching slug or an `unknown` section remains ineligible. A future producer-side identity contract is a prerequisite.

## Trust, type, and authority

Trust derivation runs in this exact order:

1. Recognized explicit `trust:confirmed` tag → confirmed.
2. Auto-capture marker → suggested unless step 1 applied.
3. Legacy-import provenance (`forge remember (imported)`) → suggested unless step 1 applied.
4. Typed/structured machine record or known machine producer → suggested unless step 1 applied.
5. Otherwise-unmarked string from exact human command source `forge remember` → confirmed.
6. Unknown or ambiguous form → suggested.

Confirmed records can enter SessionStart and prompt context when eligible and relevant. Suggested records can enter only a separate `Suggested memory — verify before relying` prompt block when strongly relevant and fresh. They never enter confirmed/session truth. Suggested records older than the existing seven-day recent window are manual-recall only. All bodies remain provenance-fenced as untrusted data after budgeting.

## SQL eligibility and ranking invariant

The candidate query must perform these operations in order:

1. FTS `MATCH`.
2. Same-project/null-local scope predicate.
3. Allowed trust and suggested-freshness predicates.
4. Already-seen exclusion.
5. Eligible-superseder `NOT EXISTS` predicate.
6. `ORDER BY bm25(...)` plus deterministic secondary ordering.
7. Candidate `LIMIT`.

Eligibility cannot be applied after the limit. The regression fixture must insert at least 26 stronger foreign rows—more than the current 25-row candidate cap—and prove the eligible local match is still returned.

## Supersession semantics

A memory is suppressed only when another row names its `memory_id` in `supersedes_json` and that superseder is itself eligible for the same normalized project under current trust/freshness rules.

- A foreign, stale, malformed, or otherwise ineligible superseder cannot suppress an eligible memory.
- A suggested superseder may suppress an eligible suggested predecessor.
- A suggested superseder cannot suppress a confirmed predecessor.
- A confirmed eligible superseder may suppress either trust class.

This relation is evaluated in SQL before BM25 ordering and the candidate limit. Tests must explicitly prove the denial-of-memory boundaries.

## Ranking and budgets

1. Query only the SQL-eligible bounded FTS5 pool.
2. Keep BM25 primary.
3. Use trust/source weight, recency, and `memory_id` only as deterministic secondary ordering.
4. Pack best-first until the existing token estimator reaches the surface budget.
5. Skip an oversized result and continue with the next eligible hit.
6. Emit provenance and trust labels with each selected result.

The numeric score floor remains measurement-driven; implementation must not guess a new corpus-wide threshold.

## Lifecycle and harness behavior

| Surface | Existing owner | S0 behavior |
|---|---|---|
| Claude `SessionStart` | `lib/hook-renderer.js` + `lib/commands/hooks.js` | Install/repair the existing command, parallelize bounded project-local reads, and inject eligible confirmed memory plus dispatch bootstrap. |
| Claude `UserPromptSubmit` | existing `memory-recall` command | Read supported stdin, retrieve/filter/rank/budget, emit `additionalContext`, and record outcome. |
| Claude `PreCompact` / `Stop` | existing `capture` command | Preserve bounded/deduped capture; captured machine summaries remain suggested. |
| Cursor | existing rule/CLI surfaces | No fake prompt hook; verify bounded `forge prime`/`forge recall` fallback and record unsupported reason. |
| Codex | existing `AGENTS.md`/CLI surfaces | No new global/static projection; verify bounded CLI fallback and dynamic-hook unsupported evidence. |
| Hermes | existing CLI fallback | Same fail-open unsupported evidence; no new global hook protocol. |

## Telemetry

Reuse the non-projecting append pattern in `lib/grounding/context-events.js`: write directly to `kernel_events` without issue CAS or projection outbox. Use `entity_type=project`, the deterministic worktree-normalized project identifier, and `event_type=memory.recall.observed`.

Store only bounded operational fields: outcome, counts, selected memory ids, aggregate source/trust mix, token estimate, elapsed time, and harness. Store no prompt text, meaningful/normalized prompt terms, memory bodies, or snippets.

Omit query correlation by default. If implementation evidence proves it necessary, use only a keyed HMAC-style fingerprint with a local random salt/key kept outside the event payload; never use an unkeyed hash. Tests inspect serialized events and prove absence of prompt text, meaningful terms, bodies/snippets, and fingerprint key/salt. Telemetry failure cannot suppress a valid injection or block a prompt.

## Security and threat pass

| Risk | Applies | Mitigation |
|---|---|---|
| A01 broken access/scope | Yes | Resolve deterministic project identity first; apply scope in SQL before rank/limit; never infer team scope. |
| A02 secrets/cryptography | Yes | Do not read `.remember`; do not persist prompt terms or memory bodies/snippets; omit correlation unless a keyed local fingerprint is necessary. |
| A03 injection | Yes | Parameterized FTS, quoted tokens, provenance fences after truncation, and memory treated as data. |
| A04 insecure design | Yes | Confirmed/suggested boundary, precise supersession, fail-open deadlines, no authority mutation from hooks. |
| A05 misconfiguration | Yes | Upgrade/setup activation tests and visible unsupported/disabled outcomes. |
| A06 dependencies | No new risk | No dependency is added. |
| A07 identity | Yes | Canonical Git common-directory identity; no invented UUID or team identity claim. |
| A08 integrity | Yes | Deterministic ids, existing FTS triggers, eligible supersession, user hooks preserved. |
| A09 logging | Yes | Bounded content-free Kernel outcome event. |
| A10 outbound requests | No | S0 remains local/offline. |

## Edge and failure cases

- Missing or malformed hook stdin: no injection; record `empty` or `error` without prompt content.
- Kernel locked/unavailable: deadline, fail open, preserve SessionStart dispatch bootstrap when possible.
- FTS unavailable/corrupt: no substring or recency fallback on automatic prompt recall.
- Equal scores/timestamps: deterministic `memory_id` tie-break.
- Oversized single result: skip and continue; one record cannot starve the budget.
- Repeated prompt/session: existing seen-key dedupe remains bounded and project/session scoped.
- Worktree path: normalize the canonical Git common-directory real path so sibling worktrees share project memory without crossing repositories.
- User-global `.remember`: never read, index, or inject in S0.
- Unsupported harness: no fabricated success; expose fallback and record `unsupported`.

## TDD scenarios

At minimum:

1. Positive confirmed project-local holdout injects the right memory without an explicit memory command.
2. At least 26 stronger foreign rows are filtered in SQL before BM25 order/limit, leaving the eligible local result.
3. Foreign, stale suggested, and validly superseded records remain absent even with stronger BM25 scores.
4. Ineligible/foreign superseders cannot erase local memory; suggested superseders cannot erase confirmed memory.
5. Type precedence preserves recognized `type:` tags, then recognized `value.category`, then `machine-record`.
6. Fresh suggested memory is separately labeled and never rendered as confirmed truth.
7. Token budgets hold for many hits and one oversized hit.
8. Missing hook installation is repaired without changing user hooks.
9. Kernel, FTS, telemetry, and deadline failures fail open with visible content-free outcomes.
10. Serialized telemetry contains no prompt text/terms, memory bodies/snippets, or fingerprint key/salt.
11. Claude receives lifecycle context; Codex, Cursor, and Hermes report real fallback/unsupported state.

## Ambiguity policy

Use the `/dev` seven-dimension decision rubric. Proceed only for local representation or fixture details that preserve this contract. Stop below 80% confidence or whenever a choice changes trust, project scope, supersession, telemetry privacy, schema, or harness support.

## Stop conditions

Stop implementation and return to plan approval if existing columns cannot express the normalized contract, project identity cannot be derived from Git's common directory, a solution needs a new hook/engine/schema, or latency can be met only by weakening trust/scope/provenance filtering.

## Planning evidence

- Lease proved for actor `codex-wave-364`.
- Branch/worktree isolation confirmed.
- Conflict scan found no indexed-file conflict; merge simulation against `master` was clean.
- `dep-guard` could not read the Kernel UUID and merge-order reports a pre-existing dependency cycle; neither was mutated.
- Focused baseline: 103 passed, 0 failed.
- No external research was used; current Forge code, Kernel state, tests, and live machine paths were the evidence sources.
