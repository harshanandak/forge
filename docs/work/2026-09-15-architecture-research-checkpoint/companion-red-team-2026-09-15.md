# Companion architecture red-team record

Prepared 2026-09-15. Scope: read-only review of the saved Forge 0.1.0 planning set through Agent Companion, followed by independent adjudication against tracked `origin/master` at `dbb91e94b5af4f53cd0e2de127753cccd0ef974c`. Final graph request: `forge-010-architecture-redteam-20260915-v6`. The repeatable audit helper is `companion-forge-audit.mjs`. No Forge repository, Kernel issue, branch or pull request was changed.

## Requested model routes

| Route | Requested effort | Result | Durable identifiers |
|---|---:|---|---|
| Muse Spark 1.3 | xhigh | Completed the architecture red-team | graph `graph-660e9eb98f2d91be1acb5cb964f455f34016561c9a1296660486fa43d26c7f8b`; job `2afcc221-7370-4527-bf2b-83d7d7561104`; session `ses_f5e1224daffe0kodDqF7Z6G5uS`; context digest `172448b064c35ac9eeee87a76d6e06b174341e37470f42822a5dcc3ca08e1e18` |
| DeepSeek 4.1 | max | Did not run the audit. The provider consistently returned HTTP 403 because this China-hosted model requires explicit regional opt-in. | job `1d06369c-886a-4f22-b676-e715cb3e3178`; session `ses_f5e122456ffepf6trG5xL0GkZc`; context digest `17fd6e93e0370f6a927de06586f75e59de5a41785153f36acb1afa06d67ae597` |

The graph result was `partial`: one completed node and one failed node. DeepSeek is recorded as unavailable for this run and is not counted as a second architecture opinion.

## Route diagnostics

Earlier controlled attempts exposed four Companion conformance concerns relevant to PR-K:

1. A background compare launched through a short-lived stdio MCP caller returned running receipts, then its workers lost their heartbeat when the caller/server exited.
2. A foreground compare through Companion's private OpenCode V2 server reported catalog-listed models unavailable.
3. Pi listed the requested models but lacked a transferable OpenCode Go credential.
4. The MCP caller's default 60-second request timeout was shorter than a legitimate foreground audit budget.

OpenCode's built-in `plan` agent was separately shown to block filesystem writes. A temporary local Companion diagnostic change tested that read-only route without its config overlay; the change and temporary config were removed afterward, and the Companion checkout was rechecked clean on `main...origin/main`.

## Muse findings and tracked-source adjudication

| Finding | Decision | Plan effect |
|---|---|---|
| F1 Contracts rename blast radius | Reject the repository premise. Tracked source already uses `packages/contracts`; no tracked `memory-contracts` package was found. | Do not add a rename lane. Supersede the stale design statement that assigns Contracts governance to Memory during PR-A reconciliation. |
| F2 Feedback redaction and policy identity | Accept. Current patterns are bounded and the caller can self-assert a matching policy revision. | PR-E uses a host-approved policy, binds the policy actually applied, rejects forged assertions, and tests synthetic Bearer/JWT, PEM, GitLab/Slack and URL-userinfo cases. |
| F3 Feedback timeout/status/idempotency | Accept. | PR-E owns caller-stable identity, scoped idempotency, bounded acceptance, honest `unknown` after uncertain commit, and status reconciliation. Timeout does not imply cancellation. |
| F4 Feedback durable schema ownership | Accept. | PR-E owns Feedback-specific schema/store semantics and tests. PR-C owns the shared migration registry, driver and transaction infrastructure. Freeze uniqueness, atomic acceptance/status, deletion/export and rollback before dispatch. PR-D excludes Feedback persistence. |
| F5 Skill runtime split | Reject the proposed split; keep an ownership clarification. | PR-F owns all of `packages/flow/src/skill-runtime.js`. PR-L supplies projection metadata through the frozen interface and does not edit that runtime. |
| F6 Preset option precedence | Accept. | PR-B implements explicit conflict resolution, provenance preview and reorder invariance. Arrays combine only when their schema says so. |
| F7 Missing crash-redelivery owner | Reject the absence claim; accept provider-neutral extraction. Existing monitor/outbox/cursor recovery is reusable. | PR-G owns generic recovery/drain, PR-J transport attempts and PR-B activation. Prove both crash windows and avoid exactly-once delivery claims. |
| F8 Restore/tombstones and Beads mapping | Accept the restore gap; reject the missing-mapping claim. Existing Beads import preserves issue, dependency and event identity. | PR-M reuses and proves that mapping and defines post-backup deletion/revocation handling. Restored Feedback never auto-resends. |
| F9 Harness help probes | Accept the certification weakness. | PR-J treats help/version probes as discovery and requires bounded behavioral fixtures for all advertised guarantees, including Hermes. |
| F10 Absolute startup ceiling | Defer to the already planned baseline decision. | Set environment-specific absolute cold-help/import budgets plus relative thresholds after baseline capture. |
| F11 Receipt freshness and clock | Accept the policy gap; reject a universal TTL. | PR-A/PR-C define authority-owned time, current grant/lease/revision checks, skew/rollback behavior and monotonic local deadlines. Historical evidence can remain without present authority. |
| F12 Serialized reference transport | Defer the bounded selection to PR-I. | Select child-process stdio unless an existing suitable transport is found; test framing, output bounds, cancellation and termination. Do not add a network service. |

## Resulting priority order

1. Feedback host-owned bounded privacy policy.
2. Feedback durable acceptance and shared persistence ownership.
3. Restore handling for deletions and revocations.
4. Authority-owned time for consequential acceptance.
5. Deterministic preset conflict resolution.
6. Behavioral harness certification.
7. Exact ownership of generic redelivery and the skill runtime.

The red-team does not change the accepted product model: eight public namespaces, one distribution, independent Contracts, optional Memory/Flow presets, multi-source receipts, one-way Beads import, supported four-harness routes, optional Companion conformance and deferred hosted/cloud infrastructure.
