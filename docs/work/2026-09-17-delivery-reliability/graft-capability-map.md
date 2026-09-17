# Forge capability map and bounded Graft pilot

Prepared 2026-09-17. Planning issue: `86c08a2e-7ccc-4da0-8912-1fd4ec5e3495`.
Status: source map completed; Graft execution blocked before graph generation. No product implementation or PR authorized by this artifact.

## Result

Forge already has useful public execution, feedback, evidence and monitoring primitives. The strongest gaps in the inspected surfaces are public initialization of local knowledge storage and authority, and a monitoring composition that does not require private root modules. This supports extracting a few useful consumer journeys before deciding more package or namespace boundaries.

Graft remains a plausible exploration aid, but this pilot produced no graph and establishes no time, token or correctness improvement. A selective native dependency rebuild could not find a usable Windows C++ toolchain. Stop the tooling investigation here; preserve the source map and rerun the pilot only in an environment with the required build prerequisites. Do not make Graft a prerequisite for the architecture work.

## Scope and sources

The user selected the capability-map option: reconcile saved research with actual public APIs and dependencies, using Graft where possible. This authorizes research, isolated tool evaluation and preservation of findings, not adoption or capability implementation.

- Implementation baseline: fetched `origin/master`, `bd1abbd8ab63b590fd916dad379e0a575542fcc7`. Source references below are relative to that commit in [harshanandak/forge](https://github.com/harshanandak/forge/tree/bd1abbd8ab63b590fd916dad379e0a575542fcc7).
- Design baseline: `docs/architecture-research-checkpoint`, `d5438badcb8c71e946fe87018173bf1ad76d3f31`, directory `docs/work/2026-09-15-architecture-research-checkpoint/`: `capability-scope-architecture.md`, `capability-extraction-map.md`, and `discussion-reconciliation.md`.
- Luna reconciled the saved capability inventory; Sol mapped tracked implementation and public exports; an independent Astra review challenged the inference from source structure to independence. The lead integrated findings and attempted the isolated Graft run.
- Evidence level: implementation findings are rung 2, pointed at tracked source. The local tool failure was run and observed, rung 4. Neither is runtime proof of Forge capability independence.

The settled direction remains one supported distribution with independently useful capability APIs. The eight namespaces below are candidates; the earlier 24 families are an inventory, not a requirement for 24 packages or extension points. Public operations may be in-process or remote. Setups compose APIs into explicit workflows or agent-directed sections. No central network service is required by this model.

Historical archive statements about Beads or other release scope are not release decisions in this map. This work does not reopen or settle those separate corrections.

## Capability-to-source map

Here, public means reachable from a package's declared entry point. An internal CommonJS export alone is not a supported external API. Root `forge-workflow` declares CLI bins and no `main` or `exports` (`package.json:6-12`). Export reachability also does not prove a stable compatibility promise or independent runtime behavior.

| Candidate scope | Existing capability and source | Boundary to prove or clarify |
|---|---|---|
| Authority | Memory wraps an injected Kernel broker and exposes PR lifecycle packets and receipts: `packages/memory/src/authority-provider.js:3-66`, `pr-lifecycle-authority.js:821-946`; exported at `packages/memory/index.js:319-330`. | Consumers need a supported way to obtain and close an authority provider. Concrete broker creation and storage are currently root-private in the inspected paths. Do not expose database internals merely to remove a private import. |
| Knowledge | Public registry defines add, recall, search, capture and digest: `packages/memory/src/backend-registry.js:3-23,79-165`. Local behavior runs through `lib/memory/router.js` and `lib/project-memory.js`. | A registry interface exists; public initialization of a usable local store, configuration and lifecycle remains the gap. |
| Evidence | Public schema validation, canonicalization and hashing in `packages/contracts/index.js:17-31`; usage evidence in `packages/memory/src/usage-evidence.js:142-205`. | Audit recording is root-internal (`lib/audit-evidence.js:140-240`). Separate evidence production, storage and authority acceptance; do not make every receipt helper a public extension point. |
| Feedback | Public `createFeedbackReport` and `createFeedbackIntake`: consent, redaction, durable acceptance callback and optional delivery (`packages/memory/src/feedback-intake.js:66-234`, export at `index.js:322`). | Persistence and transport are injected. Prove a useful independent consumer journey and its failure/deletion behavior before adding a packaged service. |
| Execution | Public packet executor, receipt creation, bounded loops, skills and process lifecycle (`packages/flow/index.js:3-29,39-113`, `src/executor.js:217-279`). | This is the strongest existing public starting point. Prove execution without a Memory service or a prescribed Forge workflow. Namespace renaming is not required to run that proof. |
| Monitoring | Public Flow reduction/receipt/bridge primitives and Memory durable monitor storage (`packages/flow/index.js:5-11,26-29,103-112`, `packages/memory/index.js:265-330`). | Actual PR monitoring composes them through private root setup (`lib/pr-monitor/flow-monitor.js:6-17`). Separate observation/storage from authority to execute privileged actions. |
| Integration | Harness capability model and probes (`lib/capabilities/model.js:88-140`, `probes.js:328-346`). Contracts include a capability-manifest schema. | These probe exports are internal root modules, not a declared package API. A public provider or bridge registry was not found in the inspected surfaces; this is a bounded finding, not a repository-wide absence proof. |
| Composition | Root CLI loads commands, resolves options/config and dispatches (`bin/forge.js:3728-3809`); distribution bundles the existing packages (`package.json:118-130`). | A working CLI composition exists. A reusable public composition contract must be grounded in an actual custom setup, not created merely to mirror the CLI. |

Both `@forge/memory` and `@forge/flow` declare only `@forge/contracts` as a runtime dependency in their inspected manifests (`package.json:15-16` in each package). That is encouraging structural evidence. It does not establish that every useful journey is available without root-private bootstrap.

## Concrete coupling to investigate

1. **Local knowledge storage:** `lib/project-memory.js:7-11,20-37` imports Kernel path resolution, broker and SQLite driver, and caches concrete drivers. Define initialization, ownership, close and error behavior at a supported API; keep the database implementation replaceable behind that boundary.
2. **Configuration mixed with storage routing:** `lib/memory/router.js:59-140,384-451` reads project config and applies dependency/environment/config/local precedence around private reads and writes. Determine which resolved values the consumer supplies and which defaults belong to a setup.
3. **Monitoring bootstrap:** `lib/commands/shepherd.js:312-323` and `lib/pr-monitor/reconcile-executor.js:1082-1095` combine public monitor storage with private broker/driver setup. Identify what the broker contributes before deciding whether the public dependency is monitoring, authority or execution.
4. **Root composition:** `package.json:118-130` and `bin/forge.js:3728-3809` connect distribution, CLI and command/config machinery. Co-installation is compatible with the proposed single distribution; forced activation or private access is the concern to test.

These are research targets, not instructions to publish internal modules unchanged or create four new abstractions.

## Graft pilot receipt

| Item | Observed result |
|---|---|
| Tool | `@nanonets/graft@0.18.0`, registry integrity `sha512-sNshNND1Q/qSXiuSh9nW8NniWyaD+m55oJZ6oCGJsLzxot52WSJrdThsQ3NZVTNT+lqivlYkkqN8b/nf22S/Xw==` |
| Tool directory | `C:/tmp/forge-graft-tools-20260917`; isolated npm prefix, not a Forge dependency |
| Source directory | `C:/tmp/forge-graft-map-20260917`; disposable local clone, detached at the implementation baseline |
| Install | 45 packages installed in approximately 30 seconds with lifecycle scripts initially disabled; this install success did not establish runtime readiness |
| Public API | `import { Graft } from '@nanonets/graft'`; `new Graft().graph(root, { llm: false, lsp: false, reuse: true, onlyDirs: ['bin', 'lib', 'packages', 'scripts'] })`, followed by `checkGraph` if successful |
| Isolation settings | `DO_NOT_TRACK=1`, `GRAFT_NO_GITIGNORE=1`, `GRAFT_NO_IGNORE=1`; no `init`, harness wiring or global hook edits |
| First execution | Node 24.18.0 on Windows x64; exit 1 in about 1.9 seconds while loading `tree-sitter-kotlin@0.3.8`, before graph construction |
| Bounded recovery | Selective `npm rebuild tree-sitter-kotlin tree-sitter-swift tree-sitter` in the isolated prefix; Kotlin's `node-gyp-build` failed because node-gyp could not find a usable Visual Studio C++ toolchain |
| Limited WSL probe | Ubuntu had Node and Python; no `g++` or `make` was resolved, and `npm` resolved to the Windows executable. No Linux install or graph build was attempted |
| Outcome | No graph, query results, cache measurement or comparative benchmark. No conclusion that Graft is universally unsupported on Windows |

The initial error reported runtime `electron` and ABI 137; the subsequent native build identified Node 24.18.0. Do not attribute the whole problem to that runtime label: the observed recovery blocker was toolchain discovery. A normal full lifecycle install was not tested. Installing a system compiler or patching Graft to remove its Kotlin import is outside this bounded pilot.

The public SDK was selected because the inspected CLI has a background update check (`dist/cli.js:170`, `dist/upkeep.js:117`). SDK use avoided that CLI path. Model enrichment and telemetry were disabled through supported options/settings; this was not a sandbox or a network-isolation test. The rebuild downloaded Node headers into the normal node-gyp cache. No secrets or private transcripts were supplied to a remote model.

Official references: [Graft project](https://trailhq.com/graft), [README and documented commands](https://github.com/trailhq/Graft/blob/main/README.md). The installed version's source was used for SDK, lifecycle and settings behavior because current website and repository descriptions can drift from a published package.

## Reproducible next evaluation

Retain the existing source-search map as the baseline. Once an environment can run the pinned tool, use these five targets on the same Forge commit:

| Target | Independent source check |
|---|---|
| `packages/memory/index.js` exports | Follow spread exports and confirm declared-entry reachability; a graph symbol alone is insufficient |
| `lib/memory/router.js::appendWithReceipt` | Trace registry to private local writes and SQLite initialization |
| `packages/flow/src/executor.js::createWorkPacketExecutor` | Confirm contract validation edges and inspect runtime-injected dependencies |
| `packages/memory/index.js::createMonitorStore` | Enumerate callers and separate driver injection from private Kernel construction |
| `bin/forge.js::main` | Trace dynamic command loading, option resolution and dispatch; report unresolved dynamic edges |

Record actual extraction scope, unsupported files and unresolved edges before making absence claims. The requested graph scope omits root-level files, tests and hidden hook configuration; package metadata, public exports and saved intent still need direct inspection. Measure setup, cold build, warm query and branch/edit refresh costs. The later matched exploration benchmark in plan.md remains unrun, including its proposed 20% promotion threshold.

A graph can suggest coupling, affected files and repeated exploration shortcuts. It cannot establish authorization, semantic correctness, independent installation, successful initialization, safe cross-process behavior or permission to skip required tests. It does not supply thinking capability to Forge's mechanical checks.

## Next discussion, with foundations retained

Independent review recommends deciding only the boundaries exposed by concrete journeys:

1. Define a knowledge-only capture/recall journey and an execution-only packet/receipt journey, then the same operation across a serialized boundary. Preserve the earlier local/cloud/hybrid direction without forcing network calls into local use.
2. Define who creates, owns and closes storage and authority providers, and the minimum public operations consumers need. Keep schemas and private database handles out of that contract.
3. Define the separation between monitoring observations, durable storage and authorized actions. A custom setup must be able to choose behavior without granting every observer execution authority.

Use the existing public APIs where they already support these journeys; expose or adjust only the demonstrated gap. Package count, a marketplace, a generic registry, and a Graft adapter remain separate decisions. No additional code is authorized by the source map.
