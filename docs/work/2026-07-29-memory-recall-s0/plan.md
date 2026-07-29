# S0 automatic memory recall

Date: 2026-07-29

Issue: `36461e50-da2e-43e4-bb4a-ae58aac08591`

Branch: `feat/memory-recall-s0`

Status: awaiting plan approval

## Purpose

Make relevant project memory reach an agent automatically and safely through Forge's existing recall and hook paths. This S0 is a reliability completion: it extends `kernel_memories`, its FTS5 index, `forge recall`, `forge prime`, and the existing `SessionStart` / `UserPromptSubmit` / `PreCompact` / `Stop` commands. It does not create another memory engine or hook family.

## Reproduced release failure

The reported miss is reproducible on the current checkout:

- The user-global `C:\Users\harsha_befach\.remember` store contains recent Forge-specific summaries, including the discovery failure, but `forge recall "re-invented Forge capabilities discovery problem" --json` returned zero notes.
- Feeding the matching holdout prompt to the real Claude `hooks memory-recall` command returned zero bytes.
- The existing project `.claude/settings.json` contains only an older `PreToolUse` hook. It has no Forge `SessionStart`, `UserPromptSubmit`, `PreCompact`, or `Stop` entries, so the dynamic path is not activated in this upgraded checkout.
- Manually invoking the real `hooks session-start --harness claude` path eventually returned valid context, but took 58,882 ms and emitted 6,525 bytes. That exceeds the documented 30-second prompt-hook safety window and proves that structural unit tests alone do not establish live delivery.

The focused baseline remains green: 103 tests passed across the current memory, FTS5, hook, setup, and orientation suites. The gap is therefore installation, federation, filtering, bounded live execution, and evidence rather than a missing primitive.

## Success criteria

1. A clean setup and a safe upgrade repair install exactly one Forge-owned Claude group for each existing lifecycle event while preserving every user-owned hook.
2. A project-scoped confirmed-memory holdout reaches Claude `additionalContext` without the prompt naming Forge memory or running `forge recall`.
3. A cross-project record, an unscoped user-global record, a superseded record, and a stale suggested record never enter automatic context.
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

5. `kernel_memories.key` remains `memory_id`; type, scope, trust, provenance, supersession, and timestamps are derived from existing columns/tags/source metadata. No schema migration is added.
6. Scope and trust eligibility are applied before relevance ranking or injection. Keys named in any current record's `supersedes` list are excluded.
7. Human `forge remember` records are `confirmed`. Machine, insights, auto-capture, legacy external, and `.remember` records are `suggested` unless an existing explicit confirmation tag says otherwise.
8. Suggested context is visibly labeled as non-authoritative and requires verification; it is never rendered as confirmed project/team truth. Stale suggested context is manual-recall only.
9. FTS5 produces a bounded candidate pool; BM25 remains the primary relevance signal, with source/trust weight and `updated_at` used only as deterministic secondary ordering signals.
10. Automatic prompt memory stays at or below 400 estimated tokens. Session-start memory stays at or below 400 estimated tokens. Default human `forge recall` output stays at or below 1,200 estimated tokens.
11. On a representative 1,000-record local fixture, the in-process ranked recall p95 is at most 250 ms. The real prompt hook completes within 5 seconds and SessionStart completes within 10 seconds on supported Windows and Linux test hosts; either path fails open on its own deadline.
12. Every real retrieval attempt records a bounded `memory.recall.observed` Kernel event with outcome (`selected`, `empty`, `filtered`, `unsupported`, `timeout`, or `error`), candidate/selected counts, selected memory ids, token estimate, source mix, trust mix, elapsed time, harness, and a capped/redacted query fingerprint. Raw prompts and memory bodies are not stored in telemetry.
13. The deterministic holdout corpus passes all positive cases and all isolation/negative cases. Agent-behavior use is consumed by the existing integration-tail issue `d362bd71`; this issue owns retrieval and delivery evidence only.

## Out of scope

Explicitly deferred:

- PostgreSQL and team ACL/server authority.
- Memory lifecycle state machines, CAS/history, and retention/deletion APIs.
- Memory entity events and outbox projectors; S0 telemetry is a non-projecting project diagnostic event.
- Graphiti or embeddings/reranking.
- Deletion replay for external source projections.
- Product Suite exchange.
- Static typed-memory instruction projection.
- New dashboards or insights panels.
- A new workflow stage, memory database, engine, hook event, or cross-harness protocol.

## Selected approach

Extend the existing vertical path:

```text
project-local notes / kernel_memories / eligible .remember summaries
        ↓ normalize with existing fields
scope + trust + supersession filter
        ↓
existing kernel_memories_fts candidate query
        ↓
BM25 + bounded secondary weights
        ↓
existing applyBudget / recall packer
        ↓
forge recall / forge prime / existing Claude lifecycle hooks
        ↓
bounded kernel telemetry event
```

This is the smallest safe approach because the database, FTS5 triggers, ranker, budget helper, hook renderer, and lifecycle commands already exist.

## Source and projection rules

### `kernel_memories`

- `key` → `memory_id`.
- `value_json` → `content` (existing readable structured-value rendering applies).
- reserved `type:` tag → `type`; otherwise `note` for string values and `machine-record` for structured values.
- `scope` → explicit scope. A null scope from the current per-project Kernel store is treated as the current project only, never as global/team.
- `source_agent`, tags, and source refs → `provenance` and trust derivation.
- `updated_at` → `updated_at`.
- `supersedes_json` identifies older memory ids that must be excluded before ranking.

### Retired `.forge/memory/notes.jsonl`

Keep the existing one-time project-local import. Imported records are project-scoped and retain deterministic ids/content hashes and imported provenance.

### User-global `.remember`

Read only bounded summary surfaces (`now.md` and `recent.md`), not raw transcript logs. A section is eligible only when its heading carries the current repository slug or an equivalent normalized worktree-parent slug. `unknown`, blank, or another project is filtered before indexing. Deterministic source keys make re-import an upsert. These machine-produced records start as `suggested`; old versions are superseded rather than deleted.

## Trust, staleness, and authority

- `confirmed`: direct human `forge remember`, or an existing explicit confirmation tag.
- `suggested`: insights, capture hooks, structured machine values, `.remember`, and other imported machine summaries.
- Confirmed records can enter SessionStart and prompt-time context when scoped and relevant.
- Suggested records can enter only a separate `Suggested memory — verify before relying` prompt-time block when strongly relevant and fresh. They never enter the confirmed/session truth block.
- Suggested records older than the current seven-day recent window are manual-recall only. Confirmed records do not expire merely due to age.
- All bodies remain provenance-fenced as untrusted data after budgeting.

## Ranking and budgets

1. Resolve the current project identity and allowed scope.
2. Query a bounded FTS5 candidate pool.
3. Remove wrong-scope, ineligible-trust, stale-suggested, superseded, and already-seen records.
4. Rank with BM25 first. Trust/source weight and recency break close/equal relevance; they cannot rescue a non-match.
5. Pack best-first until the existing token estimator reaches the surface budget.
6. Emit normalized provenance/trust labels with each selected record.

The numeric score floor remains measurement-driven. Holdout/shadow evidence may tighten it; implementation must not guess a new corpus-wide threshold.

## Lifecycle and harness behavior

| Surface | Existing owner | S0 behavior |
|---|---|---|
| Claude `SessionStart` | `lib/hook-renderer.js` + `lib/commands/hooks.js` | Install/repair the existing command, parallelize bounded source reads, inject confirmed recent memory plus the existing dispatch bootstrap. |
| Claude `UserPromptSubmit` | existing `memory-recall` command | Read supported hook stdin, retrieve/filter/rank/budget, emit `additionalContext`, record outcome. |
| Claude `PreCompact` / `Stop` | existing `capture` command | Preserve current bounded/deduped capture; captured machine summaries remain suggested. |
| Cursor | existing rule/CLI surfaces | No fake prompt hook. Verify bounded `forge prime`/`forge recall` fallback and record the unsupported reason. |
| Codex | existing `AGENTS.md`/CLI surfaces | No new global/static projection in S0. Verify bounded CLI fallback and explicit dynamic-hook unsupported evidence. |
| Hermes | existing CLI fallback | Same fail-open, explicit unsupported evidence; no new global hook protocol. |

## Telemetry

Reuse the non-mutating event append pattern in `lib/grounding/context-events.js`: write directly to `kernel_events` without issue CAS or projection outbox. Use `entity_type=project`, the existing project UUID, and `event_type=memory.recall.observed`.

Payloads are bounded and privacy-preserving. Store a query hash plus capped normalized terms, never the raw prompt; ids and aggregate mixes, never memory bodies. Telemetry failure cannot suppress a valid injection or block a prompt.

## Security and threat pass

| Risk | Applies | Mitigation |
|---|---|---|
| A01 broken access/scope | Yes | Resolve project identity first; filter null/foreign/global records before rank; never infer team scope. |
| A02 secrets/cryptography | Yes | Do not index raw `.remember` logs; do not persist raw prompts/bodies in telemetry; keep injected content fenced. |
| A03 injection | Yes | Parameterized FTS, quoted tokens, provenance fences after truncation, memory treated as data. |
| A04 insecure design | Yes | Confirmed/suggested boundary, fail-open deadlines, no memory authority mutation from hooks. |
| A05 misconfiguration | Yes | Upgrade/setup activation test and visible unsupported/disabled outcomes. |
| A06 dependencies | No new risk | No dependency is added. |
| A07 identity | Yes | Project UUID/slug and harness session id scope dedupe/telemetry; no team identity claims. |
| A08 integrity | Yes | Deterministic ids, existing FTS triggers, supersession exclusion, user hooks preserved. |
| A09 logging | Yes | Bounded Kernel outcome event for selection, empty, filtering, timeout, unsupported, and error. |
| A10 outbound requests | No | S0 recall remains local/offline. |

## Edge and failure cases

- Missing or malformed hook stdin: no injection; record `empty` or `error` without prompt content.
- Kernel locked/unavailable: deadline, fail open, retain SessionStart dispatch bootstrap when possible.
- FTS unavailable/corrupt: no substring or recency fallback on automatic prompt recall.
- Equal scores/timestamps: deterministic `memory_id` tie-break.
- Oversized single result: skip it and continue to the next eligible hit; never let one record starve the budget.
- Repeated prompt/session: existing seen-key dedupe remains bounded and project/session scoped.
- Worktree path: normalize to the owning repository project UUID/slug so sibling worktrees share intended project memory without crossing repositories.
- External summary with `unknown` project: never index or inject.
- Unsupported harness: no fabricated success; surface the existing fallback and record `unsupported`.

## TDD scenarios

At minimum:

1. Positive confirmed holdout retrieves and injects the right memory without an explicit memory command.
2. Foreign-project and unscoped global records are filtered before rank.
3. Superseded and stale suggested records are absent even when their BM25 score is strongest.
4. Fresh suggested memory is separately labeled and never rendered as confirmed truth.
5. Token budgets hold for many hits and one oversized hit.
6. Missing hook installation is detected and safely repaired without changing user hooks.
7. Kernel/FTS/telemetry failures and deadlines fail open with visible outcome evidence.
8. Claude receives lifecycle context; Codex/Cursor/Hermes report their real fallback/unsupported state without fake dynamic delivery.

## Ambiguity policy

Use the `/dev` seven-dimension decision rubric. Proceed only for local representation or test-fixture details that preserve this contract. Stop below 80% confidence or whenever a choice changes trust semantics, project scope, telemetry privacy, schema, or harness support.

## Stop conditions

Stop implementation and return to plan approval if the existing columns cannot express the normalized contract, `.remember` cannot prove project scope, a solution needs a new hook/engine/schema, or latency can be met only by weakening trust/scope/provenance filtering.

## Planning evidence

- Lease proved for actor `codex-wave-364`.
- Branch/worktree isolation confirmed.
- Conflict scan found no indexed file conflict; merge simulation against `master` was clean.
- `dep-guard` could not read the Kernel UUID and merge-order reports a pre-existing dependency cycle; neither was mutated in this plan.
- Focused baseline: 103 passed, 0 failed.
- No external research was used; current Forge code, Kernel state, tests, and live machine paths were the evidence sources.
