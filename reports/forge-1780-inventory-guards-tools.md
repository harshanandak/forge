Decisions needed: none

# Forge beyond its commands

Evidence scale: **read the file** means inspection of `origin/main` at the path and line shown. **Inferred** means a conclusion from those files, not a live demonstration. This report describes the fetched ref, not the current working tree. Test paths are references to existing test files, not claims that tests were run or passed. No builds, tests, Forge commands, browser or credentials were used.

## At a glance

| Item | What it gives an owner | State |
|---|---|---|
| 1. Delivery template | A preselected set of work, memory, checking and agent capabilities. | Working |
| 2. Guards | Optional harness rules for dangerous actions, secret exposure and unsupported completion claims. | Working |
| 3. Memory startup | A scoped memory pointer and optional standing-note text at session start. | Working |
| 4. Six skills | Written instructions for turning an idea into reviewed, landed work. | Working |
| 5. Agent setups | Explicit Claude, Codex and T3 setup and fallback guidance for others. | Working |
| 6. Lanes | Separate workspaces and evidence-driven review; repository-specific runners coordinate workers. | Internal only |
| 7. Other tools | Build, CI, release, import, benchmark and lint helpers for Forge maintainers. | Internal only |
| 8. Ports | Named boundaries that allow internal capabilities to be connected to outside systems. | Unclear |
| 9. Adapters | Concrete connections to Git, storage, processes, identity and other systems. | Working |
| 10. Extension | A way to package, check and approve a custom block and reuse templates and skills. | Working |

## Ten things an outsider would not guess Forge already does

1. It can warn if a tool response appears to contain a credential, without repeating it. Read the file: `templates/delivery/harness/output-guard.md:5-7`.
2. A stop hook can challenge a completion claim unless the agent supplies a current-head pass receipt or labels it unverified. Read the file: `templates/delivery/harness/done-claim.md:5`.
3. It can put scoped rule notes into a new session with a bounded text budget. Read the file: `templates/delivery/harness/memory-rules.md:30-44,73-79`.
4. The delivery template gives claims a two-hour default. Read the file: `templates/delivery/forge.template.json:19-22`.
5. Its intake instructions track unresolved decisions before work is sliced. Read the file: `templates/delivery/skills/forge-intake/SKILL.md:11-25`.
6. A slice records what files it owns and what one-way doors it touches. Read the file: `templates/delivery/skills/forge-cut/SKILL.md:20-27`.
7. Its review guidance caps a PR at two review rounds before re-planning. Read the file: `templates/delivery/skills/forge-review/SKILL.md:42-46`.
8. Its merge guidance pins the exact PR head and checks receipts, CI and unresolved threads. Read the file: `templates/delivery/skills/forge-land/SKILL.md:10-26`.
9. A custom block is checked without running its handler, then admitted against an exact content digest. Read the file: `docs/writing-a-block.md:125-161,170-171`.
10. Its repo-specific lane tester tries acceptance cases in a temporary project before push. Read the file: `tools/lane-test.md:1-3,20-25`.

## 1. Delivery template

**State: Working.** Read the file: `templates/delivery/forge.template.json:1-35`. Importing `harsha/delivery` configures five built-in blocks: accounts, agent, work, memory and check. Work orders priorities p0 through p4 and sets a 7,200-second claim TTL. The template describes the cut, build, review and land loop, with intake and loop routing. Read the file: `README.md:54-55`. Import adds blocks to project configuration; a separate `skills sync` writes skills. It does not itself install trusted hooks. Test reference: `test/templates/delivery/delivery-template.test.ts`; test file presence only, not executed.

## 2. Harness guards

**State: Working.** This describes available mechanisms, not proof that the owner has installed them or that every harness invokes them. Test references: `test/templates/delivery/command-guard.integration.test.ts`, `done-claim.integration.test.ts`, and `output-guard.integration.test.ts`.

- **Ask first.** Read the file: `templates/delivery/harness/ask-first.md:1-7,32-55`. Owner copies permission rules into Claude or Codex. On matching publish, force-push or branch-delete commands, the harness asks for permission, or denies if configured to do so. T3 inherits its underlying harness permissions. Rule: “They ask; they do not judge.” Prefix matching and full-access modes can miss or suppress prompts, and scripts or aliases can evade text matching.
- **Command guard.** Read the file: `templates/delivery/harness/command-guard.md:3-22` and `guard.mjs:1-13,169-186`. Before a Bash tool call, it checks the command text without executing it. It refuses environment dumps, secret-variable printing, credential-file reading, provider secret listing and recursive root/home removal. Refusals exit 2 with a fixed reason on stderr; accepted calls exit 0 silently. Rule: “This is a text check, not a sandbox.” It does not cover PowerShell, aliases, scripts and several other execution paths. The owner must merge the printed hook and trust it.
- **Done-claim guard.** Read the file: `templates/delivery/harness/done-claim.md:1-7`. At Stop, after excluding code, words such as done, fixed, ready or verified trigger a check. The response needs an `Unverified:` line, or `Not covered: ...` plus a current-head PASS receipt within the first three receipt IDs. On a failure, the hook blocks the stop with a reason. It skips outside a Forge project and respects the active stop-hook flag. Rule: “Progress such as ‘not done yet’ also blocks once”.
- **Output guard.** Read the file: `templates/delivery/harness/output-guard.md:1-17`, `output-guard.mjs:1-10,39-63`, `output-scanner.mjs:1-16,30-64`. An opt-in PostToolUse hook searches returned text for recognizable provider credentials, named secret assignments and password-bearing connection URIs. It adds a fixed warning to avoid repeating the credential and ask for rotation. Rule: “The guard is warning-only.” The result has already reached the model. Malformed or excessive payloads fail open, and live harness delivery is explicitly unverified in the documentation. Claude also covers PostToolUseFailure; Codex needs hooks enabled.

## 3. Memory rules and startup

**State: Working.** Read the file: `templates/delivery/harness/memory-rules.md:3-44,52-84` and `memory-start.mjs:4-46`. The basic pointer is under 400 characters and counts live general and current-project notes without revealing their text or IDs. The shipped start companion requests `notes: true`, so it additionally supplies applicable `rule` notes, capped at 6,000 characters on whole lines. It instructs agents to search and show relevant notes on demand. These notes are untrusted data, not binding instructions. Scope comes from configuration, device alias or checkout name. It prints an unavailable code instead of stopping the session on failure. Hook setup must be merged and trusted. Test references: `test/blocks/memory/start-notes.test.ts`, `recipes.integration.test.ts`.

## 4. Six workflow skills

**State: Working.** These are instructions to an agent, not an autonomous guarantee that a harness follows them. Read the named files; test references: `test/templates/delivery/skill-contract.test.ts`, `skills.integration.test.ts`.

- **forge-intake:** Clarifies vague intent, researches facts, tracks decisions, and hands a settled map to cut. Uses `forge issue create` and linked issue context. Read the file: `templates/delivery/skills/forge-intake/SKILL.md:3,11-26`.
- **forge-cut:** Turns settled work into small dependency-linked deliverable slices, recording acceptance, file ownership, risk and doors. Uses `forge issue create`, `issue dep`, `issue show`, `issue release`, `issue ready` and `issue close`. Read the file: `templates/delivery/skills/forge-cut/SKILL.md:8-38`.
- **forge-build:** Reproduces the premise, runs red then green, retains check receipts, and stops at push. Uses `forge pr state`, `issue call/resume/comments/comment`, `accounts plan`, `check run/list/show`. Read the file: `templates/delivery/skills/forge-build/SKILL.md:3,11-58`.
- **forge-review:** Triages conflicts, PR threads and CI, checks findings, fixes in-scope serious findings and files other work, with two rounds maximum. Uses `forge pr state`, `issue call/comment/create`, `agent wait`, plus GitHub tools. Read the file: `templates/delivery/skills/forge-review/SKILL.md:8-46`.
- **forge-land:** Gates and pins merge, verifies the merged result, closes the issue or lane with proof, records learning and re-plans. Uses `forge check gate`, `pr merge`, `issue claim/links/link/close/ready`, `lane close`, `agent wait`, `memory add`, `decision propose`. Read the file: `templates/delivery/skills/forge-land/SKILL.md:8-46`.
- **forge-loop:** Routes start, resume and wakeups to the right skill, dispatches bounded work and stops at one-way doors. Uses `forge issue ready`, `issue stale`, `issue show` and commands named in the linked instructions. Read the file: `templates/delivery/skills/forge-loop/SKILL.md:7-26`.

## 5. Agent setups

**State: Working.** Read the files: `templates/delivery/agents/claude.yaml:1-7`, `codex.yaml:1-8`, `t3.yaml:1-10`. Claude uses `.claude/skills`, detects `CLAUDECODE`, watches via monitor and describes hooks in Claude settings. Codex uses `.agents/skills`, detects `CODEX_THREAD_ID`, wins over Claude when both match, watches with gh checks, and uses Codex hooks. T3 detects its CLI or thread signals, wins over both, and uses the T3 watch tool; its underlying harness handles hooks. Test references: `test/blocks/agent/memory.test.ts`, `wait-guard.test.ts`.

Read the file: `templates/delivery/harness/memory-rules.md:88-113`. Pi has a manual startup-extension recipe on macOS/Linux and a Windows fallback; OpenCode has an AGENTS.md pointer fallback. These are memory recipes, not delivery agent YAML adapters. Case-insensitive search for `cursor`, `opencode`, `pi`, `gemini`, `hermes` under `templates/delivery/agents`, delivery harness and loop found Pi and OpenCode recipes, no named Cursor, Gemini or Hermes agent setup in those searched paths. A broader search in `templates`, `src/blocks`, and `src/adapters` included unrelated pagination cursors. This is not proof that those tools cannot be used through generic instructions elsewhere.

## 6. Lanes

**State: Internal only** for the `tools/` runner described here. A lane in plain words is a separate checkout and branch assigned to an issue, with a brief and a known stop point. The product also exposes `forge lane` operations; those are not classified as internal by this report. Read the file: `tools/lane.ts:1,56-63,182-203`, `templates/delivery/skills/forge-land/SKILL.md:30-35`.

Start and close through `forge lane start` and `forge lane close`; `tools/lane.ts:1` explicitly routes those operations away from the helper. A brief includes goal, acceptance test, files, forbidden actions, stop point and prior art (`tools/lane.ts:56-63`). The repo runner launches builder, fixer, reviewer or tester with a record of the run (`tools/lane-run.ts:51-68,286-305,541-547,672-699`). The independent tester checks acceptance cases and tries adverse cases; the reviewer reports findings without edits; the fixer addresses P1 findings. Read the files: `tools/lane-test.md:1-25`, `lane-review.md:1-13`, `lane-fix.md:1-15`, `lane-brief.md:1-29,40-46`. `lane-control.ts:151-153` checks that the checkout matches the attached lane, and `lane-registry.ts:19-21` releases a registry lease.

Read the file: `tools/lane-tier.ts:4,43-52,78-107`. Its review tiers are light, code and security, based on trusted main-branch policy globs and changed files. Security wins over code; light applies when neither matches. Code adds an independent reviewer, security adds a security reviewer, while light includes tester and GitHub Codex. These are distinct from cut's light/standard/heavy size bands. Read the file: `package.json:18-63,84-86`, `tools/build-assets.ts:1-12`. The package includes `dist`, templates, the example and author guide; raw `tools/` is not listed, and the public exports do not expose lane tooling. Inferred: the repo runner is for developing Forge; shipped lane commands are separate. Test references: `test/tools/lane.integration.test.ts`, `lane-run.integration.test.ts`, and `test/blocks/l7-work/lane-start.integration.test.ts`. Cloud has an explicit limitation: `docs/reference/cloud.md:268` says `lane.close` is refused there.

## 7. Other tools

**State: Internal only** as a group, with the public lint exports noted below. Read the tree: `tools/`; read package boundary: `package.json:18-25,55-63,68-86`. The descriptions below are inferred from filenames, package scripts and the named entry points; individual implementations were not fully audited.

- `tools/ci/`, `ci-compare.ts`, `ci-unacquired.ts`: CI scope, sharding, tracing and reports for maintainers; normal users do not run these.
- `import-current*`, `cloud-to-local-delta.ts`, `prepare-tracker-input.ts`: import and reconciliation helpers for project/cloud data; maintainer use, not established as a supported user interface here.
- `release/dry-run.ts`, `release/journeys.mjs`, `release/readback.mjs`, `restore-cloud.ts`, `pack-smoke/`: release rehearsal, installed-package journeys, readback and restoration checks; maintainers operate these.
- `bench/`: CLI speed, comparisons, samples and footprint measurements; maintainers use them.
- `checks/no-comments.ts`, `lint/no-comments.ts`, `checks/comment-diff.ts`: comment-related check/lint tools. Exception: `package.json:18-20` explicitly exports the two no-comments entry points, so users can import those even though source tooling is not generally shipped.
- `gen/`, `build-assets.ts`, bundle scripts and `bun-builtin.ts`: generate and assemble the package and run build-time utilities; maintainers use these via package scripts.
- `digest.ts`, `check-admit.ts`, `git-executable.ts`, `run-command.ts`, `practice-compare.ts`: supporting digest, admission, Git, process and comparison tooling; exact supported user workflows are unclear from the filenames alone.

Test references: `test/tools/ci-report.test.ts`, `test/tools/gen-block-docs.test.ts`, `test/cloud/import-current.integration.test.ts`; not executed.

## 8. Ports

**State: Unclear.** Read the first lines of each `src/ports` file below. These are code boundaries, not necessarily user-facing extension APIs. Several corresponding adapter tests exist, but documentation and a test reference for every individual port were not established. Each entry is **read the file**, line 1 unless otherwise indicated; description is an inference from its interface name and comments.

- `authorization.ts`: asks whether a principal can perform an action in a project.
- `clock.ts`: supplies time for expiry checks.
- `cloud-login.ts`: describes results of cloud login and logout.
- `config-codec.ts`: encodes and decodes configuration.
- `device-files.ts`: accesses private device documents, locks and scratch space.
- `device-identity.ts`: provides a persistent local holder identity.
- `identity-mint.ts`: creates a verified identity after proof is checked.
- `identity.ts`: represents authenticated identity claims and verification.
- `index.ts`: re-exports selected port types, rather than representing an outside system itself.
- `lifetime.ts`: owns or borrows a provider handle and closes owned resources.
- `mcp-transport.ts`: connects Forge tools to MCP protocol transport.
- `package-manager.ts`: detects and interacts with the project's package manager.
- `private-files.ts`: applies and reads native private-file security.
- `process.ts`: launches and supervises external processes.
- `runner-output.ts`: recognizes structured test-runner evidence.
- `state-protocol.ts`: defines requests and versions for remote state.
- `state.ts`: offers namespaced, versioned state to blocks.
- `store-export.ts`: exports stored data and its digest.
- `store.ts`: abstracts the internal storage driver.
- `tracker.ts`: describes the work-item tracker interface.
- `vcs.ts`: connects to version control.

Test references include `test/adapters/l4-config/config-codec.test.ts`, `test/assembly/store-export.test.ts`, `test/adapters/vcs-git/vcs-git.unit.test.ts` and `test/adapters/runner-output/receipt-integrity.test.ts`.

## 9. Adapters

**State: Working.** Read each named `adapter.json` at line 1, except multiline manifests at lines 1-4. The port names below are the manifests' own declarations. Test references include `test/adapters/l4-config/config-codec.test.ts`, `test/adapters/package-manager/package-manager.test.ts`, `test/adapters/oidc/verify.test.ts`, and `test/adapters/workers-oauth/flow.test.ts`.

| Adapter folder | Wraps | Port served |
|---|---|---|
| `src/adapters/config-yaml` | yaml package | ConfigCodecPort |
| `src/adapters/fs` | node:fs | ConfigFiles |
| `src/adapters/http` | node:https | CloudHttp |
| `src/adapters/mcp-transport` | MCP server package | McpTransportPort |
| `src/adapters/node-runtime` | Node executable | FileCapturePort, RunIsolationPort |
| `src/adapters/oidc` | node:crypto | IdentityVerifier |
| `src/adapters/package-manager` | npm, pnpm, yarn, bun | package-manager |
| `src/adapters/process` | koffi and process support | process |
| `src/adapters/runner-output` | Vitest, Jest, pytest output | RunnerOutputPort |
| `src/adapters/store-sqlite` | node:sqlite | StorePort |
| `src/adapters/vcs-git` | Git | vcs |
| `cloud/src/adapters/workers-oauth` | Cloudflare Workers OAuth provider | OAuthVerificationPort |
| `cloud/src/adapters/workers-oauth/clerk` | Clerk binding | ClerkBinding and IdentityVerifier verification |

Read the file: `README.md:106`. Cloud sign-in is described as experimental. Experimental is not by itself a half-built classification.

## 10. Extending Forge

**State: Working.** Read the file: `docs/writing-a-block.md:1-6,39-54,125-171`. An outsider can copy `examples/hello-block/`, declare operations and schemas, write a handler, and run `block check`, `block add`, then `block admit`. Check validates without executing the handler or registering the block; add registers its source; admit approves the exact captured content digest. Changed captured files require another review and admission. Admission protects against silently executing unapproved or changed block code; it is an approval of specific content, not proof that the code is harmless. The first agent admission requires an owner reply tied to a request; MCP cannot admit code. A local terminal has a separate confirmation flow, and an owner-approved unattended policy can permit some operations.

Read the file: `schemas/interface.json:2-18`, `schemas/interfaces/forge.tracker.json:2-6`, `src/ports/state.ts:1-2`, `src/ports/lifetime.ts:1-3`. Interface documents describe provider operations and major-version compatibility; the included tracker interface describes work items. Blocks can use their own namespaced state, not direct SQL or another block's namespace. Outside block authors do not get provider setup/dispose hooks. Project and leased operations require a cloud version of the block (`docs/writing-a-block.md:67`).

Read the file: `README.md:19,36-37,54-55`. A user can import the delivery template and sync its skills. The requested `template list/show/import/remove` operations are part of the command surface, but their exact removal and conflict semantics were not established in the files inspected; do not assume removal reverses all past effects. Test references: `test/integration/custom-block/packed.integration.test.ts`, `test/core/l4-config/templates.test.ts`, `test/assembly/template-skills/template-skills.test.ts`.

## Still unknown

- No live harness session was exercised. Hook trust, delivery, false positives and local configuration were not verified. The output guard itself states live harness delivery remains unverified (`templates/delivery/harness/output-guard.md:17`).
- The exact behavior and packaging of every individual maintainer helper and every port was not fully inspected. Item 8 is therefore Unclear; item 7 contains explicitly marked inferences.
- No tests were run. Listed test references establish file presence, not passing behavior. Exact `template remove` semantics were not checked.
- The fetched ref's freshness relative to the remote server was not checked; no fetch was requested. Cloud support has documented limits, including lane closure (`docs/reference/cloud.md:268`).

COVERED 10 OF 10
