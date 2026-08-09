# Forge 0.1.0 Missing Acceptance Contracts

Status: approved normative companion. These contracts must be written to the matching live Kernel issue and read back at the expected revision during the pre-implementation admission gate. Only a passing aggregate admission receipt authorizes PR 1 implementation.

Snapshot facts:

- 79 disposition rows; 54 currently report `AC=no`.
- 48 actionable rows report `AC=no`; one is the stable-release tracking root, leaving 47 implementation/migration candidates requiring contracts before code begins.
- Epics receive no completion credit for a child outcome. An epic closes only after every mapped child is closed with accepted evidence or explicitly deferred through an approved linked issue.
- Existing issue acceptance criteria remain authoritative unless this proposal is explicitly approved and written to the Kernel.

Common acceptance rules for every row below:

1. Evidence is bound to the issue id/revision, WorkPacket hash, exact head, risk-manifest digest, and owning gate receipts.
2. `INCOMPLETE`, stale, truncated, conflicting, unauthorized, or non-reconstructable evidence is not completion.
3. No row may expand its owning PR's path/API boundary; unrelated findings receive a separate issue/PR.
4. The listed outcome plus all listed checks must pass; a title match or merged neighboring change is insufficient.

## PR 1 — Control-plane trust and fast validation

| Issue | Outcome and machine-verifiable acceptance |
| --- | --- |
| `9b69a551` | Reconcile only claims whose verified Forge-owned run is dead and linked worktree is missing. Dead+missing releases exactly that claim; live/active-worktree/missing-marker/marker-mismatch/unverifiable fixtures remain unchanged; replay is idempotent with process-run-manifest evidence; no TTL/PID-only broad cleanup. |
| `1390e1d1` | Lifecycle-hygiene epic. Kernel child query accounts for all mapped lifecycle children as evidence-closed or approved linked deferrals; each completed child has hook/gate/check-after-write evidence; epic cannot close while any mapped child is open or unverified. |
| `765a4cd8` | Merge authority accepts passing required checks plus successful optional `SKIPPED`/`NEUTRAL` observations. Required failure, optional failure, stale head, or unresolved actionable thread blocks; neutral `forge/pr-monitor` never becomes a false blocker. |
| `7f8c8471` | Packaged Smith/claim-safety references resolve or use a documented supported primitive. Asset scan finds every reference; invocation succeeds or deterministically falls back; claim-safety still proves a live owned lease and rejects foreign/expired leases. |
| `94f782e0` | Foreign-lease reconcile child exits deterministically on Windows. Repeated affected Windows/Node fixture exits successfully within its bound; a valid lease remains active and untouched; recurrent environmental failure becomes separate evidence/fix, not a weakened assertion. |
| `9f6ffb42` | Kernel trace exposes issue→worktree→work folder→plan/tasks/decisions→PR→iterations. Ship/merge emits idempotent links; one trace returns the joined envelope with explicit null gaps; duplicate events do not duplicate rows. |
| `b977b0a2` | Approval events support issue/project scope and TTL through one control. Round-trip returns scope/expiry/control id; valid approval permits the protected write; wrong-scope/expired/missing approval denies; replay is idempotent and audit-visible. |
| `c29f3952` | Kernel status honestly exposes live sessions, held leases, and last-seen. Active fixture reports actor/issues/activity; closed/expired/unverifiable session is offline; read does not mutate leases. |
| `eea2f9ce` | Claim-safety refuses work without a current actor-owned unexpired lease. Owned/unexpired passes; foreign/expired/missing/duplicate-collapsed fails before work; proof comes from live Kernel state rather than a local claim token. |
| `c3952ba5` | Kernel graph automatically registers PRs, sessions, and Shepherd verdicts. Ship/orientation/Shepherd fixtures create the expected rows; replay is idempotent; one trace answers issue→claim→session→worktree→PR→verdict→events/comments with explicit gaps. |

## PR 2 — Contracts and package boundaries

| Issue | Outcome and machine-verifiable acceptance |
| --- | --- |
| `5037a7da` | Memory exposes a formal adapter registry while local Kernel memory remains the mandatory floor. Contract fixtures cover add/recall/search/capture/digest and local default; configured adapters resolve deterministically; invalid config fails doctor; adapter failure cannot block/remove local write or recall; selection appears in a versioned receipt. |

## PR 3 — Memory foundation

| Issue | Outcome and machine-verifiable acceptance |
| --- | --- |
| `6b56673a` | Capture remains bounded through supersession, staleness demotion, duplicate/contradiction detection, and review. Superseded notes hide by default but remain recoverable; unused >90-day notes demote deterministically; review surfaces stable duplicate/contradiction ids; repeated equivalent capture produces no duplicate issue. |
| `33d6dce9` | Supported read attention receives fenced, budget-capped relevant memory without treating it as authority. Capable path injects only path-matched notes; unsupported harness reports an honest skip; content is fenced/untrusted and cannot mutate Kernel; unrelated path gets no note. |
| `b6bdf122` | Knowledge-architecture epic. Kernel child query lists every mapped child with accepted evidence or approved linked deferral; required corpus/authority/migration evidence is attached; any unevidenced child keeps the epic open. |
| `bec40cf9` | `forge recall` provides deterministic cross-platform Kernel-native recall without requiring context-mode. Same corpus/query yields consistent results and explicit empty state; optional adapter absence does not break core; enrichment never changes authority; kind/cap metadata is truthful. |
| `6d5ed439` | Session learning uses an honest non-blocking supported-hook nudge. Missing summary emits one deduplicated reminder through a supported hook; unsupported hooks are not assumed; explicit summary persists deterministic metadata and repeated submission is idempotent. |
| `bb5b054c` | `recall --kind` is complete or reports truncation. A >1000-note corpus with an old match either returns it through store filtering or sets `capped:true`; it never claims uncapped completeness when matches may be omitted; ordering/cap metadata is deterministic. |

## PR 4A — Flow core, skills, and observers

| Issue | Outcome and machine-verifiable acceptance |
| --- | --- |
| `183dc7ca` | Skills auto-trigger agent-agnostically and compose sub-skills with terminal/next states and evaluation evidence. Chain fixtures prove trigger→handoff→terminal with no hard-coded harness/vendor; evaluation records trigger accuracy, cost, and outcome. Epic closes only after mapped skill children. |
| `2b71e189` | Skills orient before acting, announce relevant skills, and chain progressive sub-skills across harnesses. User-named/auto-trigger paths converge; unsupported next skill fails closed without expanding scope. |
| `7da81cbd` | Smith composes stage sub-skills through typed gate events and size×importance×complexity autonomy. Replay proves deterministic routing, bounded handoffs, budget/failure authority, and terminal stop. |
| `028a149e` | Skill handoffs use explicit `Skill("name")` convention in Smith, Kernel, and research with valid frontmatter. Static/parser fixtures cover all handoff sites and preserve the research single source. |
| `9aac4554` | `forge loop` is a bounded agent-agnostic tick driver that closes on terminal state. One-tick/retry/timeout replay proves cleanup and no harness scheduler dependency. |

## PR 4B — Shepherd, review, merge, and post-merge handoff

| Issue | Outcome and machine-verifiable acceptance |
| --- | --- |
| `57fb8889` | Shepherd reconciles PRs independently of sessions, survives restart/reboot, and retires cleanly. Replay covers restart/reclaim/orphan/closure and deduplicated events; no model polling or merge authority. Epic closes only after mapped Shepherd children. |
| `9af1ee0a` | Every reproducible Fable Shepherd audit gap is fixed or represented by an owned regression, including pull/bundle paths. Audit checklist has zero unowned reproducible gaps; exact-head Shepherd/pull/bundle replay passes. |
| `c2d398e5` | Singleton agent-agnostic monitor reconciles all PRs and emits only new actionable events. Tick/replay proves coverage, deduplication, event order, and stop when no PR remains; no per-agent scheduler/model poll. Epic closes only after mapped monitor/event children. |
| `f1af41ef` | One fail-closed current-head merge verdict derives from checks, threads, ancestry, and mergeability under Memory authority. Adversarial replay covers open/zero threads, torn reads, and stale heads; evidence names exact head/source. Epic closes only after mapped merge-safety children. |
| `00eef22d` | Zero actionable threads never yields `BLOCKED-THREADS`. Regression returns a non-blocking current-head verdict with empty, internally consistent blocker evidence. |
| `265774da` | Behind-base uses the current GitHub base oid/graph and does not block a zero-behind PR. A 0-behind/1-ahead fixture passes; stale/mismatched base is explicit `INCOMPLETE`/blocked; compared SHAs are emitted. |
| `52ebe3fd` | Shepherd docs/examples describe any review bot, not CodeRabbit as a dependency. Static scan has no vendor-only normative reference; provider-neutral fixtures render equivalent behavior; docs drift passes. |
| `931d73f5` | Review-bot classification uses author typename/`[bot]` and current commit, never a login allow-list. Multi-author/stale-commit fixtures pass; static scan finds no provider login equality. |
| `9df80006` | `BLOCKED-THREADS` always carries real blocker evidence and never an empty blocker. Clean state is not blocked; blocked state includes ids/reasons; required-source/verdict fields agree. |
| `a696e954` | `shepherd events --all` provides a local cross-PR digest with stable cursor, ordering, deduplication, and self-retirement. It uses no CI-token dependency. |
| `addf5297` | Tier-2 trigger fires only for a current clean verdict and enabled gate, then nudges ship without merge authority. Toggle/stale-head/open-thread matrix and event receipt pass. |
| `c66f076e` | Review list/reply/resolve uses agent-agnostic Forge verbs. Static scan finds no runtime `.claude` dependency; fake-adapter round-trip preserves current-head thread identity and propagates failure. |
| `4a65c50f` | Tier-3 maintainer path forks safely, appends idempotent verdict history, emits `pr.verdict_changed`, and cannot merge without authority. Replay binds exact head and issue. |
| `67ecc083` | Ship→Shepherd→Review handoffs preserve PR/head/issue state without dropped/duplicate transitions. End-to-end fake-provider retry is idempotent; stale/terminal transitions stop work. |
| `b03ddbf2` | `shepherd --pull` exposes actionable current-head direct comments/review summaries while filtering status noise, resolved items, and old heads in stable provider-neutral JSON. |
| `b34dfc57` | Restart adopts the reclaimed lease watcher set and reaps orphan watchers at terminal PR state. Replay proves transfer, adoption, no duplicates, cleanup, and recorded handle/lease evidence. |
| `e2420489` | Compact `shepherd <pr> --verdict --json` returns the canonical three-signal current-head verdict. Schema snapshot matches the canonical evaluator; missing evidence is `INCOMPLETE`, never `PASS`. |
| `ffbdb6b7` | Reconcile tests inject inert fakes for every environment seam. Seam inventory passes offline deterministically and retains failure-path assertions without live process/network state. |

## PR 5 — Facade, harness, and capabilities

| Issue | Outcome and machine-verifiable acceptance |
| --- | --- |
| `7268bc9b` | Hook adapter evaluates mandatory/optional/permission controls and reports honest per-harness downgrade. Policy matrix covers deny/warn/TTL approval/expiry; observational-only harnesses never claim enforcement; decisions are auditable. |
| `9658c21a` | MCP registry renders/drift-checks control state and consent at render time only. Fixtures cover control types, toggles, drift, consent expiry, and stable capability/config digests without claiming runtime enforcement. |

## PR 6 — Migration and extraction readiness

| Issue | Outcome and machine-verifiable acceptance |
| --- | --- |
| `18bee669` | Replace all 28 `beads-context.sh` shell-outs/fallbacks with Kernel-authoritative reads. Static scan finds none at runtime; populated-Kernel/missing-Beads fixture succeeds; genuinely missing context stays `FAIL`/`INCOMPLETE`. |
| `ea6c7b14` | Runtime is Beads-free; one explicit opt-in migrator is the only surviving Beads surface. Migration/rollback/interruption/post-cutover suite passes; dependency scan excludes only migrator; epic closes only after every mapped retirement child. |
| `920a086a` | D44 ledger, AGENTS, skills, and references state migrator-only Beads and remove retired runtime guidance. Link/drift/static scans pass and record `BEADS_GITHUB_SYNC` retirement. |
| `d9cb9823` | Beads retirement plan maps every slice to owner, proof artifact, rollback/`INCOMPLETE` behavior, and child issue; appendix link/render check passes. |

## PR 7 — Release convergence

| Issue | Outcome and machine-verifiable acceptance |
| --- | --- |
| `8e634347` | Cut `0.1.0` reproducibly from the accepted exact-SHA BOM. Package/version/doc/changelog sweep matches candidate; signed BOM/artifacts reproduce; tag/publish occurs only after G8 and metadata-only promotion rules. This release root tracks promotion and is not an additional implementation outcome. |
| `28d67d69` | Real `node bin/forge.js` memory add/recall/search/remember smoke catches handler/CLI drift. Spawned fixture verifies exits/stdout/schema, including `--type` versus `--kind`, with no live provider dependency. |

## Admission procedure

After proposal approval and before any implementation branch or WorkPacket:

1. Generate a canonical amendment batch for the 48 actionable `AC=no` issues from this document.
2. For each issue, compare the expected revision from the approved snapshot, write its contract to the Kernel, and read it back.
3. Refuse partial silent success: conflicts remain unadmitted and are reported; successfully amended issues retain their new revision and receipt.
4. Recompute the disposition snapshot and prove every one of the 70 work outcomes has acceptance criteria, PR owner, product owner, affected contract/risk, and validation owner. The release tracking root may be admitted only for PR 7 promotion.
5. Epic admission additionally requires an explicit mapped-child list; epic closure remains impossible while a mapped child lacks accepted completion or approved deferral evidence.
6. Publish `admission-evidence.v1.json` with before/after revisions, contract hashes, conflicts, and aggregate `PASS|FAIL|INCOMPLETE`. Only aggregate `PASS` authorizes PR 1 implementation.
