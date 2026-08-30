# Forge architecture convergence plan v3

This is the final amendment to `plan-v2.md`. The complete v3 plan is `plan-v2.md` followed by this file; rules here replace conflicting v2 wording. All unamended v2 sections remain in force.

## Chosen direction

Control-plane first, with two small prerequisites: measurement and current skill-invocation correctness. This adopts candidate A without creating a parallel control plane or speculative plugin runtime.

## Existing-contract gap audit

Delete `AuthorityBundle` as a proposed schema name. Slice 3 starts with a field-coverage matrix across WorkPacket, LeaseReceipt, ContextPacket, CapabilityManifest, RunReceipt, MonitorReceipt, Kernel issue/claim/session/worktree rows, and Kernel events.

For every required invariant, the audit records:

1. current authoritative field and schema version;
2. producer and validator;
3. persistence/replay location;
4. stale/conflict test;
5. missing-field failing test, if any.

A new field is allowed only when a failing contract test proves the invariant cannot be represented and validated by an existing envelope or its versioned advisory extension. A new envelope/type requires two materially different producers and consumers; otherwise it is rejected. The default result is reuse.

## Effective permissions

The first adapter contract uses eight permissions:

| Permission | Meaning | Minimum enforcement |
| --- | --- | --- |
| `workspace.read` | read files under allowed roots | canonical-root allowlist |
| `workspace.write` | create/change files under allowed roots | canonical-root allowlist; protected paths denied |
| `process.exec` | start local commands | executable/argument policy plus working-directory bounds |
| `network.egress` | contact remote endpoints | provider or sandbox allowlist; otherwise unavailable |
| `vcs.local` | stage/commit/branch/worktree operations | repository and operation allowlist |
| `vcs.remote` | fetch/push/PR mutations | explicit operation and remote grant |
| `external.mutate` | non-VCS remote writes or deployments | named system/action grant and idempotency/compensation requirement |
| `secret.use_ref` | use a named secret reference without exposing its value | secret-name allowlist and non-disclosure receipt |

Kernel authority mutations are never adapter permissions. Forge alone claims, changes issue truth, accepts decisions/evidence, and advances terminal state.

Effective permissions are the intersection of:

```text
operator Agent Config maximum
AND project .forge policy
AND adapter capability snapshot
AND WorkPacket requested subset
```

Each layer may narrow and none may widen. The default is deny. If an adapter cannot prove enforcement for every requested permission, preparation returns `NOT_EXECUTED/UNSUPPORTED_POLICY`. Post-run classification is evidence, not containment.

The conformance matrix has one row per permission and target with `enforced`, `unsupported`, or `unknown`. `unknown` behaves as unsupported. Tests cover allow, deny, path escape, stale policy digest, unavailable sandbox, and receipt mismatch.

## One execution adapter, multiple dispatch targets

The first release has one Forge-to-Agent-Companion execution adapter. OpenCode, Pi, and DeepSeek Harness are route/dispatch targets selected behind Agent Companion. They are not three Forge adapters and do not register independent authority, policy, or lifecycle systems.

Adapter lifecycle remains `probe`, `start`, `observe`, `cancel`, `resume`, and `dispose`. Target-specific capability differences appear inside the versioned CapabilityManifest. A target that lacks resume or enforceable read-only mode returns a typed unavailable result.

## Frozen measurement and recall corpus

Slice 0 reuses the existing immutable eval-corpus and eval-evidence helpers. It adds no new corpus store.

- Performance fixtures: fixed Kernel board and memory dataset, exact content hash, exact base SHA, runtime/Bun/Node version, OS/architecture, sample count, warmup count, and command arguments.
- Kernel measurement: at least 3 warmups and 30 recorded samples per operation; report median, p95 using nearest-rank, min/max, and coefficient of variation. Do not fail CI on wall time; compare promotion artifacts outside the correctness test.
- Memory holdout: 1,000 deterministic synthetic records and 100 blinded queries with provider-blind relevance IDs. Families cover exact, semantic, scope isolation, supersession/current state, temporal, relational, provenance, and abstention/distractors.
- Provider comparison: paired per-query bootstrap with a fixed seed and 10,000 resamples; report 95% intervals for Recall@5 and Precision@5. The v2 admission thresholds apply to interval lower bounds.
- Every corpus, config, query catalog, result, and comparison is content-hashed. Raw sensitive text is excluded.

`Meaningful query` uses the existing selector guard and explicit fixtures: empty, punctuation-only, single meaningless fragment, unsupported anaphora, exact identifier, and two or more meaningful tokens. No-match and abstention fixtures must inject nothing.

## Replayable terminal fixtures

Terminal states are absorbing. Add `prepared -> cancel_requested` to the v2 table. One fixture covers every allowed transition, every forbidden transition, and these failures:

- stale issue revision;
- lost or changed lease epoch;
- head/policy/capability digest mismatch;
- start without acknowledgement;
- duplicate idempotency key;
- timeout before and after possible mutation;
- cancellation without acknowledgement;
- cleanup failure;
- invalid or wrong-attempt receipt;
- observer-only evidence;
- partial completion.

Timeouts and lease expiry use the active policy snapshot rather than hardcoded product constants. Any elapsed cap, unknown provider state, or unverified cleanup ends `INCOMPLETE`.

## Completion semantics and operator surface

`completed` is a derived Kernel verdict, not an adapter string. Completion requires a fresh read of every requested sub-object named by the WorkPacket acceptance criteria, plus current issue revision/lease, exact head, required artifacts, validation receipts, and cleanup. One pending, missing, stale, timed-out, or unverified item yields `INCOMPLETE`.

The canonical machine surface is a Kernel-backed `forge run show <run-id> --json` envelope. Human `status` and bounded `orient/recap` project the latest relevant run. Reported provider cost is labeled `reported`; locally derived cost is labeled `estimated` with the price-table revision.

Rejected route reasons use a small enum: `capability_missing`, `permission_unenforceable`, `policy_denied`, `headroom_unavailable`, `provider_unavailable`, `cost_limit`, `latency_limit`, and `lower_ranked`.

## Skill UX boundary

Keep canonical metadata values `invocation:user|model` for compatibility. Derive `manual-only` from `user` and `auto-eligible` from `model` in diagnostics.

Slice 1 only fixes retention/validation of invocation and preflight-before-write. Ownership-aware collisions follow in the same issue. `forge skill preview <intent>` and `forge skill doctor` are the next UX sub-slice after the resolver has one provenance-bearing effective set. Group enable/disable, cross-machine management, and marketplace behavior remain deferred.

## Plugin and memory cleanup owners

- Plugin lifecycle stays postponed until a second real in-process provider supplies a failing lifecycle requirement.
- The memory lifecycle unit owns deprecating the current public Graphiti pseudo-backend. It is removed in the next release unless an approved pilot issue, owner, pinned version, corpus result, and deletion proof exist before release cut.
- Projection deletion convergence has a bounded policy deadline; missing the deadline marks the provider unhealthy and disables injection until reconciliation passes.

## Final executable order

1. Slice 0: frozen benchmark/corpus artifacts and issue dependency repair.
2. Slice 1: user-only skill invocation enforcement and sync preflight.
3. Slice 2: one-pass status snapshot.
4. Slice 3: test-driven existing-contract gap audit, then durable `prepareRun` only for proven gaps.
5. Slice 4: permission intersection, one capability registry, hashed Agent Config snapshot, and one Agent Companion adapter with OpenCode/Pi/DSH targets.
6. Slice 5: local memory forget/retention and Graphiti pseudo-backend disposition.
7. Slice 6: at most one optional memory projection benchmark and stable plan/status projections.

## Final convergence test

Round 3 reviewers read the complete `plan-v2.md`, this amendment, and `review-rubric.md`. The same 90/no-blocker/spread gate applies. If the third round does not clear it, stop tuning prose: preserve exact dissent, choose the highest-scoring version by median completed-reviewer score, and execute only Slice 0. Any behavior slice then requires its own normal TDD review.
