Decisions needed: none.

# Top gaps

These are judgments from source reading, not tested outcomes. Sizes are rough agent-work estimates.

| Gap | Why it matters | Smallest fix | Size |
|---|---|---|---|
| No published provider check kit | A tracker author cannot independently check behavior before integration. | Export a reusable tracker contract suite with an example provider and clear pass/skip results. | Medium |
| Breaking changes are harder to find | Builders need an accessible account of what changed and how to upgrade. | Add a versioned changelog with breaking changes and upgrade steps, linked from the package README. | Small |
| Provider building path is fragmented | An outsider needs both the API contract and a working example to make a compatible replacement. | Add one complete tracker-provider example linking the interface, registration and checks, and state supported extension boundaries. | Medium |
| Inspection is split across commands | People must assemble a picture of work and its causes themselves. | Document a read-only inspection recipe combining issue, lane, configuration and receipt views. | Small |

# Where Forge is already ahead

- Read the file: Forge has an explicit dependency ledger with exact versions, integrity and rationale (Forge `docs/dependencies.md:1-10,22,33`). Board lists dependencies but the inspected package documentation does not establish a comparable ledger (`packages/board/package.json:91-101`).
- Read the file: Forge tests a dependency boundary that confines dependencies to adapters (`test/structure/dependency-boundary.integration.test.ts:20-38`). A search of Board filenames and package scripts did not establish an equivalent check. This is a narrower claim than saying Board has no architectural rules.
- Read the file: Forge's release runbook specifies registry readback on three operating systems, signatures and provenance, and separate promotion (`docs/release.md:5-21`). Board's release workflow publishes a tested artifact using trusted publishing (Board `.github/workflows/release.yml:1-3,83-101`). The evidence establishes more explicit verification in Forge's runbook, not that every release actually completed it.
- Read the file: Forge's tracker documents transaction-fenced claims and stale-holder protection (`src/blocks/work/README.md:56`); Board has fenced claims too (`packages/board/src/server/tasks.ts:260-264`). Forge's detailed recovery documentation is particularly useful (`src/blocks/work/README.md:78`).

# What not to copy from Board

- Read the file: Its local SQLite implementation is tied to Node's SQLite (`packages/board/src/store/sqlite-db.ts:1-3,18-20`), so do not assume it is portable to another runtime.
- Read the file: Its local scheduler uses process timers (`packages/board/src/scheduler/local.ts:13-25`); process loss is a durability concern. Use persistent scheduling where it matters.
- Read the file: Its inspector writes as the deployment handle using a selected profile (`packages/board/src/inspect/handler.ts:27-32,45-59`). A profile is not proof of a particular human.
- Read the file: The server backend contract is broad (`packages/board/src/server/backend.ts:169-213`), while `packages/board/package.json:28-82` exports selected entry points, not a separate reusable engine path. Do not assume that swapping only storage is a small integration.

# Scope and evidence

Forge means the tracked `origin/main` tree in `E:/Personal-Projects/forge-new`, requested at 21973354. Board means the local 0.54.0 source at `E:/tmp/forge-1662-src/board`; Board paths below are relative to that clone. All findings are rung 2, read the file, unless labelled inferred. Neither project was run, installed or built. Comparisons do not prove production behavior. Counts describe named directories and filename conventions, not quality scores. Lines are 1-based.

## 1. Extension points

- Board, read the file: `packages/board/src/server/board.ts:17-19,40-45` accepts a backend and middleware; `src/server/policy.ts:30-42` accepts authentication. Backend responsibilities include delivery and binding (`src/server/backend.ts:85-110,169-213`). Local timers sit inside that backend (`src/server/local.ts:57-63`). The public conformance guide shows how to check a backend (`docs/04-reference/05-conformance.md:20-40`, all Board paths under `packages/board/` unless stated).
- Forge, read the file: `docs/writing-a-block.md:1-54` teaches blocks; `docs/reference/service-providers.md:1-100` describes services. Interfaces include `schemas/interfaces/forge.tracker.json` and identity/authorization exports in `package.json:42-52`. Cloud holds its own project authority (`cloud/src/worker.ts:1-4`).
- Verdict: Forge behind for a complete outsider provider journey. Inferred from the guide and exported checks, not a claim that every component is replaceable in Board. A full tracker-provider sample and checks would help; medium.

## 2. Provider check kit

- Board, read the file: `packages/board/package.json:42-45` exports conformance; `docs/04-reference/05-conformance.md:20-40` shows a custom backend harness. The implementation declares 90 checks and one discovery check (`src/conformance/index.ts:455,2494-2509`); optional checks may skip (`:2535-2552`).
- Forge, read the file: tracker schema is `schemas/interfaces/forge.tracker.json`; 25 files under `cloud/conformance/` cover the cloud implementation, but the export list in `package.json:18-66` does not expose a provider suite. Searched the tracked filenames and case-insensitive content for conformance, provider, contract, compliance and test kit; this does not prove no differently named outside kit exists.
- Verdict: Forge behind. Publish a reusable tracker behavior suite and one provider harness; medium. A suite is evidence of specific behaviors, not a security certificate.

## 3. Docs for outside builders

- Board, read the file: 30 Markdown files under `packages/board/docs/`, including quickstart, backend, provider, inspector and conformance guides (`docs/index.md:1`, `docs/04-reference/05-conformance.md:20-40`).
- Forge, read the file: 12 Markdown files under `docs/`, including four dated work documents; also README, block READMEs and `examples/hello-block/` outside that count. `docs/writing-a-block.md:1-54` explains a working block and `docs/reference/service-providers.md:1` covers services.
- Verdict: Forge behind for the provider journey, not necessarily overall documentation. Inferred: the inspected guide and example do not demonstrate a complete alternate tracker implementation with a runnable external conformance suite. Add that one end-to-end example; medium. Counts cover different scopes and do not measure completeness.

## 4. Public surface and versioning

- Board, read the file: `packages/board/package.json:3,28-82` declares version 0.54.0 and public subpaths. `packages/board/CHANGELOG.md:935` explicitly labels a breaking CLI change; `:1085-1104` describes migration implications.
- Forge, read the file: `package.json:3,18-52` declares 0.0.12 and exports; `README.md:85-92` warns of one-way upgrades and backup; `docs/release.md:15-25` describes tags and promotion. The README describes 0.0.11 while package.json says 0.0.12 (`README.md:74,85`), a documentation inconsistency at this ref. Searched tracked names case-insensitively for changelog, release notes, history, upgrade and migration; no root changelog appeared in that inventory.
- Verdict: Forge behind for discoverable version-by-version change communication. Add a linked changelog with breaking changes, migration steps and a version consistency check; small. Stability guarantees beyond these texts are unknown.

## 5. Input checking at the edges

- Board, read the file: `packages/board/src/server/serve.ts:448-461` validates blocks against schemas and rejects invalid ones; `src/server/tasks.ts:29-42` checks claim parameters.
- Forge, read the file: `src/contract/schema.ts:1-3` refuses unsupported schema keywords; `src/surface/cli.ts:90-103` validates CLI scalar types; `cloud/src/state-input.ts:149-150` rejects ambiguous duplicate labels. `docs/writing-a-block.md:7-8,52` describes input/output schemas.
- Verdict: level for demonstrated validation, not a complete security audit. Neither inspected sample establishes that every entry point checks every untrusted input. Board's example route asks the integrator to verify its sender (`packages/board/docs/01-quickstart.md:105-113`); Forge's unchecked edges, if any, are unknown.

## 6. Error design

- Board, read the file: `packages/board/src/server/errors.ts:5-14,33-38` defines status, code, message and optional hint. Three examples: "`x-board-filename` is not URI-encoded" (`src/server/serve.ts:232`); "no sync entry named ${key}" (`:386`); "this board has no watcher ${id}" (`:1226`). The last is a plain Error, so not every internal failure uses the same class.
- Forge, read the file: cloud error envelopes have code, message and retry policy (`cloud/src/worker.ts:48-59`). Examples: "Expected a boolean." (`src/surface/cli.ts:96`); "Inputs must be plain JSON data" and "Contradictory or duplicate observations" (`cloud/src/merge-evidence.ts:203,257`). Some errors give recovery commands (`src/blocks/work/README.md:78`).
- Verdict: level on sampled structured errors and actionable examples. Inferred: consistency across every surface is unknown; these examples do not establish a universal standard.

## 7. Test shape

- Board, read the file: 109 files ending `.test.*` in the package, plus its exported behavior suite (`packages/board/src/conformance/index.ts:455`). The filename layout does not reliably distinguish unit and integration tests. Lease fencing is exercised by the protocol suite, but exact restart, duplicate, race and fault coverage has not been fully counted.
- Forge, read the file: 468 test files for 267 non-test source files under `src` and `cloud/src` as provided by the lead; separately, the repository tree contains 162 filenames ending `.integration.test.*` and 25 files in `cloud/conformance/`. These categories overlap and have different scopes. `test/blocks/l7-work/autopilot-restart.integration.test.ts:1` names restart; `docs/reference/cloud.md:67` describes the 100-claim race and `cloud/conformance/fault-worker.ts:1` is a fault fixture. Duplicate handling is described in `cloud/src/issue-lease.ts:1-6`. These are files and descriptions, not proof of passing tests.
- Verdict: not comparable by raw count. Both have behavior checks; Forge has explicit integration naming and fault/race fixtures. Exact behavior coverage for both remains unknown. Tests were not run.

## 8. Module size and layering

- Board, read the file: ten largest non-test JS/TS source files under `packages/board/src`, lines including blanks: `server/backend-vercel.ts` 4,082; `cli/main.ts` 2,967; `conformance/index.ts` 2,553; `server/a2.ts` 1,444; `sync/engine.ts` 1,372; `api/routes.ts` 1,332; `server/serve.ts` 1,244; `sync/slack.ts` 1,125; `client/client.ts` 964; `server/writes.ts` 932. Search of filenames and package scripts for layer, architecture, boundary and dependency did not establish a direction-enforcement check.
- Forge, read the file: equivalent under `src` and `cloud/src`: `src/core/state/index.ts` 2,631; `src/assembly/index.ts` 2,561; `src/adapters/fs/clone-files.ts` 1,412; `cloud/src/project.ts` 1,317; `src/assembly/providers.ts` 1,199; `cloud/src/dump.ts` 1,109; `cloud/src/v3-store.ts` 1,059; `src/contract/schema.ts` 967; `src/adapters/process/windows-launch.ts` 802; `src/core/config/config.ts` 751. `test/structure/dependency-boundary.integration.test.ts:20-38` checks package-to-adapter ownership, not every possible architectural layer direction.
- Verdict: Forge ahead on the identified explicit dependency boundary. Large files exist in both; length alone does not prove a defect.

## 9. Inspection tools

- Board, read the file: `packages/board/docs/01-quickstart.md:91-99` launches an interactive browser inspector; `src/inspect/handler.ts:27-32` describes its identity context.
- Forge, read the file: CLI help is machine-readable (`README.md:63-64`); issue views and `lane status` expose work and limits (`src/blocks/work/README.md:56,92`), and `config show` identifies a mismatch (`:54`). These are related views, not an equivalent GUI. Searched tracked names and text for inspector, inspect, status, doctor, observability and dashboard; this establishes only that no equivalent GUI was found in those results.
- Verdict: Forge behind for a unified visual view, but the need for a GUI is unproven. First document a read-only CLI inspection recipe; small. Do not treat Board's inspector profile as authentication.

## 10. Dependencies and supply chain

- Board, read the file: three direct runtime dependencies plus optional peers (`packages/board/package.json:91-101`); inspect the repository lockfile for exact resolution. Its release workflow uses pinned action revisions (`.github/workflows/release.yml:101`).
- Forge, read the file: three direct runtime dependencies (`package.json` dependencies); `bun.lock` stores resolved versions. `docs/dependencies.md:1-10,22,33` requires rationale and records integrity. Runtime dependency ownership is checked (`test/structure/dependency-boundary.integration.test.ts:20-38`).
- Verdict: Forge ahead on the documented dependency ledger and ownership check. Direct counts exclude transitive and optional dependencies; they do not measure total attack surface. Board's complete policy and lockfile pinning were not independently audited.

## 11. Release process

- Board, read the file: Changesets drives release PRs, then trusted publishing of the tested packed artifact (`.github/workflows/release.yml:1-3,83-101`); its changelog gives changes and breaking migrations (`packages/board/CHANGELOG.md:935,1085-1104`).
- Forge, read the file: `docs/release.md:5-21` specifies trusted publishing, provenance, signatures, readback, and staged promotion; `.github/workflows/release.yml:43-58` contains release steps and permissions.
- Verdict: Forge ahead for specified release verification; Board ahead for the visible historical changelog. Add the changelog described in dimension 4; small. Actual cadence, gate outcomes and Board's full provenance status are unknown from static reading. Do not infer that the described process ran.

## 12. Security boundaries

- Board, read the file: authentication defaults to OIDC and can be supplied by the host (`packages/board/src/server/policy.ts:30-42`); task claims keep a token hash and use constant-time comparison (`src/server/tasks.ts:69-73`); event views omit claim tokens (`src/server/feed.ts:356-361`). The inspector profile is an assertion, not independently verified identity (`src/inspect/handler.ts:27-32`).
- Forge, read the file: the cloud worker checks bearer/admin credentials before project access (`cloud/src/worker.ts:1-4,43-64`); `src/core/runtime/services.ts:277-292` redacts specified process-output secrets. Claim identity is device and session (`README.md:79-83`), not itself a verified organization person.
- Verdict: not comparable overall. Each has specific controls; static samples do not prove all authorization paths or all secret output are safe. No secrets were opened.

## 13. Events and waiting

- Board, read the file: events use a log index exposed as a cursor (`packages/board/src/server/feed.ts:108,339-347`); the feed first reads backlog and only then streams (`:561-593`). Task claims carry a lease and fencing proof (`src/server/tasks.ts:69-80,260-264`). Local scheduling uses in-process timers (`src/scheduler/local.ts:13-25`).
- Forge, read the file: the state protocol defines an exclusive event sequence cursor (`src/ports/state-protocol.ts:8-24`); cloud claims use server-held leases in transactions (`cloud/src/issue-lease.ts:1-6`), and the project authority serializes claims (`cloud/src/project.ts:1-8`). `src/blocks/work/README.md:56` documents fencing and replay.
- Verdict: not comparable: Board exposes a message-wait workflow; Forge's cited protocol and claims serve work coordination. Searched tracked sources for wait, subscribe, stream, poll, cursor, events and watch; no equivalent public backlog-first message wait was established. Do not infer Forge lacks all waiting mechanisms.

## 14. Time to a first working thing

- Board, read the file: starting from a Vercel-linked-capable project, install Vercel CLI, log in, install Board, link, check identity and post: six commands, first thread at step 3 (`packages/board/docs/01-quickstart.md:12-56`). An account and project are prerequisites; interactive login time is unspecified.
- Forge, read the file: install and help are two commands, then eight demo setup commands and five Forge commands through the passing check, 15 total (`README.md:6-47`). In an existing committed Git project with a test script, skip eight setup commands: seven including help. The first issue is created before the final check. Git and compatible Node are prerequisites.
- Verdict: not comparable as a speed measurement: the products' first outcomes and prerequisites differ; this is a documentation command count, not measured elapsed time. Forge's existing-project route is already explicit.

# Still unknown

- Actual release cadence, passing CI, published artifacts, production availability, portability and security under real failures. No tests, builds, installs, network or browser were used.
- A complete inventory of schemas at every entry point, all error conventions, Board restart and duplicate/fault tests, and full import-direction rules. Search results cannot prove universal absence.
- Whether outsiders actually need an inspector GUI or alternate tracker. The suggested recipe and provider kit are priorities inferred from the requested outside-builder comparison, not observed user demand.
- Confirm Forge's precise supported public stability promises and resolve the 0.0.11/0.0.12 documentation discrepancy before presenting a release policy as settled.

COVERED 14 OF 14
