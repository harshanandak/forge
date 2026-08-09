# Forge 0.1.0 Facade Routing Ledger

**Status:** Approved normative companion to `plan.md`
**Diagnostics:** `FORGE_MEMORY_UNAVAILABLE`, `FORGE_FLOW_UNAVAILABLE`, `FORGE_CAPABILITY_UNAVAILABLE`, `FORGE_ROUTING_AMBIGUOUS`, `FORGE_SETUP_REQUIRED`

The facade routes but owns no product authority. Bare legacy commands are compatibility routes to the canonical noun command, not separate implementations.

| Current public surface and aliases | Target owner/capability | Memory authorization | Missing-product behavior |
| --- | --- | --- | --- |
| `forge`, `forge-workflow` | Facade / `routing.v1` | Proxy only | Route selected command to stable Memory/Flow diagnostic |
| `forge-preflight` | Facade wrapper → Flow / `flow.preflight.v1` | Only when persisting receipt/gate evidence | `FORGE_FLOW_UNAVAILABLE` |
| `issue {create,update,claim,release,comment,close,show,list,ready,search,stats,blocked,stale,orphans,lint,children,owns,claims,dep}` | Memory / `kernel.issue.v1` | Native Memory authority; lease rules apply | `FORGE_MEMORY_UNAVAILABLE` |
| Bare `create update claim close show list ready blocked stale orphans lint claims issues` | Facade → canonical `issue` subcommand | Same as canonical route | `FORGE_MEMORY_UNAVAILABLE` |
| `memory {add,recall,search,insights}` | Memory / `memory.v1` | Native Memory read/write | `FORGE_MEMORY_UNAVAILABLE` |
| `remember`, `recall`, `insights` | Facade → canonical `memory` subcommand | Same as canonical route | `FORGE_MEMORY_UNAVAILABLE` |
| `migrate --from beads`; Kernel `export` | Memory / migration/export capability | Native Memory authority; inbound Beads only | `FORGE_MEMORY_UNAVAILABLE` |
| `sync`, `team`, `inbox` | Memory / team sync/inbox | Server acceptance required for team writes | `FORGE_MEMORY_UNAVAILABLE` |
| `stage`; `gate` policy/config; `control`; `role` | Memory / workflow graph and gates | Native Memory authority | `FORGE_MEMORY_UNAVAILABLE` |
| `options`, `explain`, `skill for` | Memory / workflow/provider read | Memory read | `FORGE_MEMORY_UNAVAILABLE` |
| `skill eval` | Flow / evaluator execution | Memory-authorized WorkPacket; Memory ingests receipt | Flow or Memory unavailable diagnostic |
| `skill scores`, `skill coverage` | Memory / evaluator evidence read | Memory read | `FORGE_MEMORY_UNAVAILABLE` |
| `doctor` | Facade aggregation of `memory doctor` and optional `flow doctor` | Memory required; Flow state explicit | Memory absence is failure; Flow absence reported, never hidden |
| `status`, `prime`, `orient`, `recap` | Facade read aggregation | Memory read required; optional Flow runtime view | Memory absence is failure; Flow absence is explicit partial state |
| `plan` | Flow / `flow.plan.v1` | Memory creates/links issue and authorizes packet/run | Flow or Memory unavailable diagnostic |
| `dev`, `validate` | Flow / execute/validate | Current lease required before shared mutation; Memory records stage/gates | Flow, Memory, or capability unavailable diagnostic |
| `pr ship`, `ship`, `push` | Flow / git and PR | WorkPacket, lease, exact head, receipt | Flow or Memory unavailable diagnostic |
| `pr preflight`, `preflight`, `test` | Flow / preflight and test | None for pure local check; Memory required to record authoritative result | `FORGE_FLOW_UNAVAILABLE` |
| `pr shepherd`, `shepherd`; review `adapter` | Flow / monitor/review adapter | Memory run/lease/evidence binding; no issue authority | Flow or Memory unavailable diagnostic |
| `pr merge`, `merge` | Flow / guarded external merge | Memory-issued merge authorization, exact head and current lease | Flow or Memory unavailable diagnostic |
| `clean`, `worktree` | Flow / worktree and git | Memory required when registering/removing durable worktree/run state | Flow or Memory unavailable diagnostic |
| `gate doc` policy | Memory / gate policy | Native Memory authority | `FORGE_MEMORY_UNAVAILABLE` |
| `doc-gate`; `preflight doc` | Flow / executable check | Memory policy required only for authoritative gate receipt | Flow unavailable; Memory additionally unavailable when authoritative |
| `issue release <id>`; legacy `release <id>` | Memory / lease release | Native Memory authority | `FORGE_MEMORY_UNAVAILABLE` |
| `release check`, `release regen-audit` | Memory / release evidence and protected-state authority | Native Memory authority | `FORGE_MEMORY_UNAVAILABLE` |
| `release generate-npm-workflow` | Flow/facade integration / protected generator | Memory-issued one-time protected-write capability and audit receipt | Flow or Memory unavailable diagnostic |
| `patch record` | Memory / durable patch intent/evidence | Native Memory authority | `FORGE_MEMORY_UNAVAILABLE` |
| `patch inspect` | Flow / diff acquisition | No authority unless recording result | `FORGE_FLOW_UNAVAILABLE` |
| Legacy `patch` without a resolvable subcommand | Facade | None | `FORGE_ROUTING_AMBIGUOUS`; no guessed fallback |
| `add`, `audit` | Memory / provider registry/trust | Native Memory authority | `FORGE_MEMORY_UNAVAILABLE` |
| `init`, `setup`, `upgrade`, `new`, `hooks`, `recommend` | Facade orchestration | Calls product-owned APIs for authoritative writes; may render projections | `FORGE_CAPABILITY_UNAVAILABLE` or `FORGE_SETUP_REQUIRED` |
| `serve` | Facade UI client | Reads/writes through Memory/Flow APIs only | `FORGE_MEMORY_UNAVAILABLE` when authority state is required |
| `capabilities --json` | Facade | None | Always available; reports absent products without activation |
| `feedback report` | Memory / privacy-safe feedback intake | Explicit per-report consent; no implicit identity | Preview locally; no network send without approval |
| `triage` | Memory / issue grouping and priority policy | Memory authority for durable changes | Local manual mode; cloud capability reported explicitly |

## Routing invariants

- A Flow path that mutates shared state requires a WorkPacket and current Memory lease.
- Pure local validation may be packetless only when it cannot mutate shared state or record authoritative success.
- Status/orientation surfaces never report full success while Memory is unavailable.
- Generated setup/config work is performed through the owning product API; the facade does not create shadow authority.
- PR 2 generates the exhaustive command manifest from the live registry and fails if any current surface lacks exactly one route.
- Harness monitor claims come from version-bound executable probes, never a static name list.
- Feedback and triage consume no client model tokens; optional cloud AI is Forge-funded and receives redacted structured fields only.
