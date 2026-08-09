# Forge 0.1.0 Restructuring Decision Register

**Status:** Approved for implementation subject to the admission checkpoint in `plan.md` §9
**Epic:** `d6a74dc8-10f7-4be9-9761-2467c3df4798`

| ID | Decision | Status | Approval/evidence |
| --- | --- | --- | --- |
| R1 | `0.1.0` is the restructuring release; beta.5 is rollback baseline | Locked | User decision; tag SHA recorded in plan |
| R2 | Deliver through seven milestones/eight cohesive PRs, parallel preparation only for disjoint ownership, sequential merge | Locked | External review evidence required splitting conceptually distinct Flow core from Shepherd semantics; user rejected one mega-PR and tiny churn |
| R3 | Targeted risk-owned PR tests; one complete exact candidate matrix | Locked | User identified test burden as release constraint |
| R4 | Each supervised run consumes strictly less than 40% of declared parent budget, leaving more than 60% unused | Locked | User correction |
| R5 | Mandatory deterministic replans at 20% and 30%; completion/handoff decision at 35%; hard stop at 39% | Locked | User correction |
| R6 | Forge Memory owns Kernel, durable authority, memory, contracts, packets, leases, receipts, and history; Flow is optional executor | Approved and locked | Matches user's refined Memory-foundation architecture and current D44/D45 Kernel authority |
| R7 | No neutral protocol product; `@forge/memory-contracts` is owned by Memory | Approved and locked | Avoids a third governance/release dependency |
| R8 | Ship 0.1.0 as an extraction-ready modular monolith with independently releasable Memory/Flow packages; postpone physical repository separation until post-stable measured triggers pass | Approved and locked | External research red-team: an early split risks a distributed monolith and coordinated-release burden |
| R9 | Preserve `forge-workflow` and current binaries through 0.1.x as compatibility facade | Approved and locked | Minimizes beta.5 migration breakage |
| R10 | Kernel/Memory remains sole authority writer; migration allows shadow/dual-read but never authority dual-write | Approved and locked | D44/D45 and split-brain prevention |
| R11 | Include 67 architecture/control issues, resolve three additional release gates separately, defer five nonessential architecture candidates, audit three close/supersede candidates, and keep unrelated backlog outside the train | Approved and locked | Corrected 79-row live Kernel ledger: 72 candidates minus five deferrals, plus four release/root and three closure-audit rows |
| R12 | Release order: beta.6 contracts/preflight → beta.7 operational split → RC migration/freeze → metadata-only stable | Approved and locked | Monotonic SemVer progression from the published beta.5 rollback baseline |
| R13 | Every candidate is bound by a signed release BOM and exact immutable package artifacts; the schema supports the 0.1 single-repository case and a later multi-repository case | Approved and locked | Required for atomic rollback/provenance without forcing an early repository split |
| R14 | Model-winner promotion is separate from 0.1.0 unless default routing changes | Approved and locked | Infrastructure alone cannot prove a model winner |
| R15 | EfficiencySupervisor is event-driven; deterministic observation uses no model; optional small model is threshold-only and capped | Locked | User requested continuous waste detection without token burn; R4/R5 fix the exact budget policy |
| R16 | Unrelated findings get separate issues/PRs and cannot expand an active architecture PR | Locked | Repeated user instruction |
| R17 | Feedback is structured, per-report consent-gated, identity/device-free, and uses no client model tokens; optional cloud triage is Forge-funded and local triage is manual | Locked | User explicitly approved this privacy/token boundary |
| R18 | Monitor capability is version-bound and executable-probed per harness; unknown capability degrades explicitly rather than being assumed | Locked | User required current capability verification across target harnesses |
| R19 | Forge Flow provides one shared durable Monitor Engine; Memory stores monitor evidence; harnesses receive capability-tiered delivery; only actionable transitions enter model context | Locked | User approved learning from Claude Monitor while improving durability, portability, lifecycle, security, and token efficiency |

## Approval rule

The user approved R6–R14 and the plan-to-development transition on 2026-08-09. Implementation may begin after the pre-implementation admission checkpoint writes and verifies the approved acceptance contracts in Kernel authority. Each implementation PR still requires its own claimed issue, exact scope, and stage evidence; this approval does not authorize unrelated work or bypass release gates.
