# Incremental Runtime Building-Block Release Plan

**Date**: 2026-05-06
**Status**: Active release-numbered roadmap
**Supersedes**: the old major-version roadmap from D39

## Verified State

- Current package: `forge-workflow@0.0.10`.
- Default branch: `origin/master`.
- The active release path is GitHub Release driven: `.github/workflows/npm-publish.yml` runs tests, verifies `npm pack --dry-run`, then publishes with npm provenance.
- The `2026-04-28-skeleton-pivot` folder name is a historical codename. It is not the package version plan.

## Release Principle

Ship small `0.0.x` releases. Each release must deliver a usable slice, update docs, run the relevant evaluator regions, and be publishable through GitHub Release to npm.

Do not describe active package plans with the old major-version labels.

Future releases get detailed task breakdowns only when that release starts. The roadmap should define sequence, contracts, gates, and release value now; it should not pre-split every future issue into implementation tasks before the preceding release has landed.

After `0.0.18`, keep the same release discipline but shift the product lens from "board/dashboard" to "Forge Kernel authority control plane." Boards remain views over the runtime ledger. Forge owns the issue graph, local broker, protected state surfaces, memory projections, workflow assembly, and adapter contracts; Beads, GitHub, Linear, Claude, Cursor, Codex, and other agents are projections or adapters over that control plane.

**Authority reset (2026-05-29)**: Forge is internal-only, so the post-0.0.18 plan no longer treats Beads/Dolt compatibility as a public-user constraint. The active architecture is [Forge Kernel authority control plane](./forge-kernel-authority-control-plane.md): local SQLite WAL broker first, Cloudflare team authority second, Beads as import/export projection only. The evaluator loop in that plan scores the final architecture **100/100** across architecture, security/privacy, user perspective, UX, edge cases, implementation simplicity, scalability, and plan alignment.

## Current Baseline After Recent Merges

The latest `origin/master` baseline already includes the initial migrate dry-run slice from `docs/work/2026-05-05-w0-migrate-dry-run/`, `lib/migrate-dry-run.js`, `lib/commands/migrate.js`, and `test/migrate-dry-run.test.js`.

Treat that work as available baseline for later releases:

- `0.0.12` should reuse the dry-run command path when proving the graph contract.
- `0.0.13` should expose dry-run decisions through config and introspection instead of creating a separate dry-run surface.
- `0.0.16` should extend the existing migrate dry-run into upgrade, rollback, patch, and fixture safety rather than rebuilding migration discovery.

## After 0.0.11: Execution Sequence

1. `0.0.12` starts only after the active docs point to the building-block refinement and the release-numbering evaluator passes.
2. `0.0.12` publishes the runtime graph contract first: phases, actions, artifacts, evaluator regions, gates, and evidence. It must prove the current command flow can be represented without replacing the runtime.
3. `0.0.13` consumes the `0.0.12` graph contract and makes it configurable and explainable through `.forge/config.yaml` and `forge options *`.
4. `0.0.14` consumes the graph and config surfaces, then makes evaluator regions and evidence attachable to plans, research, development, validation, review, claims, and transitions.
5. `0.0.15` consumes graph, config, and evaluator regions to ship starter templates and install profiles. Templates compose primitives only.
6. `0.0.16` consumes the template/config baseline and the existing migrate dry-run baseline to make patch intent, upgrade, rollback, and fixture compatibility safe.
7. `0.0.17` consumes evidence and review history to propose skills, evaluator regions, and workflow improvements with accept/reject audit trails.
8. `0.0.18` consumes issue adapters, run state, evidence, and review packets to ship the team runtime dashboard without requiring a Forge-owned orchestration layer.

## Release Slice Rule

Each release should have:

- One primary user value.
- One required contract or behavior surface.
- One release-specific evaluator region.
- One validation gate that proves the slice is usable.
- Documentation updates that explain adoption and limits.
- A package release through the existing GitHub Release to npm path.

Do not start later-release implementation until the previous release has either shipped or explicitly recorded why it was deferred.

## 0.0.11 Exit / 0.0.12 Entry Handoff

`0.0.11` can exit when:

- Active docs link to `runtime-building-blocks-refinement.md`.
- Active roadmap language uses `0.0.x` release numbering.
- Templates are described as adoption scaffolds, not the product.
- Skills are described as executable playbooks, not the enforcement layer.
- Version-language and concept evaluators pass.
- Validation status is recorded, including any unrelated baseline failures.

`0.0.12` can start when:

- The graph schema file locations are chosen.
- The refined N2 issue is claimed or created against the current baseline.
- The existing strict workflow is represented as graph fixtures.
- The existing migrate dry-run path is identified as the proof surface for resolved graph output.
- Backward-compatibility checks against command docs are listed before implementation starts.

## 0.0.11 - Design Alignment Release

Scope:

- Add `runtime-building-blocks-refinement.md`.
- Supersede active `v3.x` release language.
- Update `README.md`, `FINAL-THESIS.md`, `release-plan.md`, `layered-skeleton-config.md`, and `template-library-and-merge-flow.md`.
- Reframe templates as adoption scaffolds, not product.
- Reframe skills as executable playbooks, not the enforcement layer.

Evaluator regions:

- Doc alignment evaluator.
- Version-language evaluator: active roadmap text must use `0.0.x`, not `v3.x`.
- Concept evaluator: building blocks > templates > skills.

Release gate:

- `runtime-building-blocks-refinement.md` is linked from the folder README.
- `release-plan.md` maps future work to `0.0.x` increments.
- Existing strict workflow remains expressible as a template.

## 0.0.12 - Runtime Graph Contract

Scope:

- Replace the old stage-only contract with graph primitives:
  - `Phase`
  - `Action`
  - `Artifact`
  - `EvaluatorRegion`
  - `Gate`
  - `Evidence`
- Define the placeholder `IssueAdapter` contract shape early enough that graph, evidence, dashboard, and extension work do not leak Beads-specific fields into core.
- Start from N2, but refine it beyond `Stage { enter, run, exit }`.

Evaluator regions:

- Schema conformance.
- Backward compatibility against current command docs.
- Dry-run graph evaluator.

Release gate:

- A workflow graph schema is published.
- Current command flow can be represented by the graph.
- `forge run --dry-run` can print the resolved graph without side effects.
- Issue-facing runtime fields have an adapter boundary. Under the authority reset, that boundary now targets Forge Kernel first and treats Beads as import/export projection.

## 0.0.13 - Config And Introspection

Scope:

- Refined N3, N4, N5.
- `.forge/config.yaml` loads workflow graph defaults and project overrides.
- `forge options *` explains phases, actions, gates, evaluators, adapters, and why each is active.
- `protectedPaths` appear in `forge options *` output with source, owner, status, and validation state.

Evaluator regions:

- Config lint.
- Disabled-but-known behavior.
- L1 rail cannot-disable evaluator.

Release gate:

- `forge options why <id>` cites the source of each decision.
- L1 rails cannot be disabled by config, template, or patch.
- Disabled phases/actions remain known, addressable, and auditable.
- Protected paths are explainable before they become fully enforced.

## 0.0.14 - Evaluator Regions And Evidence

Scope:

- Evaluators attach anywhere: plan, research, dev, validation, review, claim, transition, run failure, and dashboard recommendation.
- Evidence capture becomes first-class.
- Gate and evaluator records include trace identity, target, policy, evidence pointers, and result.

Evaluator regions:

- Plan quality.
- Research citation quality.
- TDD evidence.
- Review packet completeness.

Release gate:

- An evaluator region can target a plan artifact before development.
- An evaluator region can target a patch before validation.
- Evidence is captured in a structured report.
- Trace ids connect gate decisions to evidence and later dashboard/audit views.

## 0.0.15 - Adoption Templates And Install Profiles

Scope:

- N6 plus refined N15.
- Starter templates:
  - `strict-tdd`
  - `fast-bugfix`
  - `research-first`
  - `external-orchestrator`
  - `team-runtime`
- Templates compose primitives only.

Evaluator regions:

- Template round-trip.
- Generated config validates.
- Template docs match actual output.

Release gate:

- `forge new <template>` writes a valid config and records template ancestry.
- Users can inspect and override every generated primitive.

## 0.0.16 - Safety, Patch, Upgrade

Beads: includes `forge-30k` for documentation link checking and docs-validation automation.

Scope:

- N11, N12, `forge-1nh6`, `forge-c11n`.
- `patch.md` intent records.
- Rollback snapshots.
- v2 fixture corpus.
- Upgrade dry-run.
- Protected-write intent records for config, generated files, lockfiles, memory projections, and Beads-related state.
- Documentation automation substage: `forge docs detect/verify` direction, markdown link checking, stale-doc detection, docstring coverage, and docs-update prompts before premerge/release.
- Docs validation must be adapter-driven, not a permanent Forge-only clone of existing tools. Discovery should detect docs roots and documentation systems, then select adapters such as Lychee for broad link checks, Linkspector/reviewdog for PR comments, remark-validate-links for local Markdown anchors, and eslint-plugin-jsdoc for JavaScript/TypeScript docstring requirements.
- Docs validation should support project-specific modes: `report`, `new-only`, and `strict`, with baselines for existing link/docstring debt and generated GitHub Action/Lefthook projections that can be toggled on or off per project.
- Package docs validation as a skill-backed validation substage. `forge docs detect/verify` remains the CLI projection, while `.forge/config.yaml`, local hooks, GitHub Actions, and the local UI/TUI all resolve the same skill metadata and baseline policy.

Evaluator regions:

- Upgrade idempotency.
- Rollback restore.
- Fixture compatibility.

Release gate:

- Upgrade can be dry-run against representative fixtures.
- Rollback restores the previous managed surfaces.
- Patch intent survives upstream changes.
- Protected state changes have before/after diffs and rollback snapshots.
- Documentation checks can catch broken internal markdown links before push, report docstring coverage, and expose the selected adapter/config/baseline so projects with different docs structures can adapt without hand-editing generated files.

## 0.0.17 - Skills And Insights

Scope:

- N13 and `forge-besw.24`.
- Pattern detection proposes skills/evaluators from observed review failures.
- Planning skill becomes one configurable template, not the canonical workflow.
- Planning phases are exposed as callable sub-skills, so the runtime can invoke the full `/plan` super-skill or only `plan.intent_capture`, `plan.parallel_research`, `plan.parallel_critics`, `plan.synthesis`, or `plan.final_lock`.
- Built-in Claude command files become compatibility aliases for stage skills. The canonical source moves to `SKILL.md` packages that can sync into `.claude/skills/`, `.codex/skills/`, Cursor-compatible locations, and future agent skill roots.
- Memory and proposal records carry category, source, written_by, timestamp, cited interactions, and accept/reject decision.

Evaluator regions:

- Insight quality.
- Skill proposal usefulness.
- Accept/reject audit trail.
- Super-skill stability: full-skill and sub-skill invocation produce consistent graph state, evidence, and gate outcomes.
- Command-shadowing detection: stale `.claude/commands/*` files cannot silently diverge from same-named skills.

Release gate:

- `forge insights --review-feedback` produces ranked proposals with evidence.
- Accepted proposals can become skills or evaluator suggestions.
- `forge options why <skill-id>` explains full `/plan` invocation, partial sub-skill invocation, skipped phases, and replacement by accepted local skills.
- Memory and skill proposals cannot mutate shared projection files without a recorded proposal and audit trail.
- `skills sync` can project canonical stage skills into Claude and Codex without making command files the source of truth.

## 0.0.18 - Team Runtime Dashboard

Scope:

- `forge board` / dashboard.
- IssueAdapter SPI.
- Run ledger.
- Review packets.
- Ready, blocked, in-flight, stale, review-needed, and conflict-risk views.

Evaluator regions:

- Claim recommendation quality.
- Stale-run detection.
- Review packet completeness.

Release gate:

- Team dashboard can operate without a Forge-owned orchestrator.
- External orchestrators can consume the same runtime state.
- Runtime ledger, evidence records, adapter health, and bounded memory/context summaries are present before dashboard views claim confidence.
- Dashboard views use the Forge Kernel/IssueAdapter surface and do not perform raw `.beads` file writes.
- Ready, blocked, stale, review-needed, and conflict-risk views have deterministic fixtures and evaluator outputs.

Non-goals:

- No local config-editing UI yet.
- No direct `.beads` file mutation from the dashboard.
- No memory projection or hook projection layer beyond the existing runtime/evidence surfaces.
- No rich thousand-issue UI beyond bounded dashboard views.

## 0.0.19 - Protected State Surfaces

Beads: `forge-2agy.1` under parent epic `forge-2agy`.

Primary value:

- Agents can work quickly while Forge prevents unsafe edits to state files that must be mutated through controlled APIs.

Scope:

- `.forge/protected-paths.yaml` or equivalent resolved config surface.
- Protected categories for Beads state, Forge config, memory projection files, generated harness files, extension manifests, lockfiles, workflows, secrets, immutable paths, and append-only logs.
- Pre-edit enforcement where the harness supports hooks, plus pre-commit and CI backstop checks.
- Refuse-with-hint messages that tell the agent which Forge command or MCP method to use.
- Append-only edit-attempt audit records.

Evaluator regions:

- Protected-path policy coverage.
- Bypass detection and audit completeness.
- Refuse-with-hint clarity.

Release gate:

- Direct edits to protected Beads/config/memory/generated files are blocked or flagged with a repair hint.
- Allowed writes through Forge APIs still work.
- The audit log records attempted, blocked, and accepted mutations with actor, path, decision, and required surface.

## 0.0.20 - Forge Kernel Schema And Local Broker Contract

Beads: supersedes `forge-2agy.2` Beads-control-plane framing; depends on `forge-2agy.1`.

Primary value:

- Agents and UI stop thinking in raw Beads files. They use a Forge Kernel API backed by a local SQLite WAL broker as the default issue authority.

Scope:

- Canonical Forge Kernel contract: issues, dependencies, comments, priorities, statuses, claims, stages, sessions, worktrees, runs, events, projections, and dead letters.
- Local broker contract keyed by Git common-dir, not individual worktree path.
- Append-first event schema with idempotency key, expected revision, entity revision, actor, session, worktree, and origin.
- Beads import/export adapter contract. Beads is not the write authority.
- Field authority table: Forge-owned, provider-owned, configured GitHub/Linear-owned, and projection-only fields.
- Conflict quarantine before projection.

Evaluator regions:

- Kernel schema completeness.
- Local broker write/read correctness.
- Beads import fidelity.
- Dependency graph correctness.
- Local multi-worktree write safety.
- Conflict quarantine correctness.

Release gate:

- A UI, CLI, or MCP caller can update issue priority/status/dependencies through Forge Kernel without touching `.beads` files.
- Local SQLite broker is the default local authority for new Forge issue state.
- Beads import/export is present but not required for runtime correctness.
- A synthetic large issue set has bounded list/filter latency and no N+1 detail fetch in default views.

## 0.0.21 - Local Worktree Coordination And Lease Engine

Beads: replaces `forge-2agy.3` local UI-first ordering; depends on `0.0.20`.

Primary value:

- A single internal user can work across multiple local worktrees and sessions without double-claiming issues or corrupting issue state.

Scope:

- Claim lease model: active, stale, reclaimable, released.
- Change-driven freshness from meaningful issue/comment/stage/run events instead of fixed heartbeat spam.
- Worktree/session registry keyed by Git common-dir, branch, path, and actor.
- `forge ready/show/list/update/claim/comment/close` route through Forge Kernel.
- Explicit stale/reclaim audit events.
- Local outbox for accepted local events and later server sync.

Evaluator regions:

- Parallel claim race.
- Stale/crashed session recovery.
- Multi-worktree branch/path isolation.
- Idempotent duplicate command handling.
- Beads-free command path coverage.

Release gate:

- Twenty parallel local claim attempts produce exactly one accepted claim.
- A crashed or abandoned worktree becomes stale/reclaimable through explicit policy.
- Issue commands no longer require Beads/Dolt for core local authority.

## 0.0.22 - Workflow Assembly Over Forge Kernel

Beads: reframes `forge-2agy.4`; depends on `0.0.21`.

Primary value:

- The Stage Capability Graph and provider strictness model run on Forge Kernel issue/run state instead of Beads-owned issue state.

Scope:

- Import the workflow assembly control-plane decisions: stages/substages are slots, providers fill slots, evaluators prove slot completion.
- Strictness modes: `required`, `recommended`, `manual`, `disabled_by_policy`, `backstop_only`.
- Unknown providers enter quarantine until mapped, trusted, locked, and evaluator-backed.
- Workflow config changes use transactional plan/apply/rollback.
- UI/MCP/harness calls wrap Forge APIs and do not write generated files, Beads internals, or protected config.
- Normalized lifecycle events attach to Kernel issues, claims, stages, runs, and evidence.

Evaluator regions:

- Stage Capability Graph correctness.
- Provider quarantine and trust drift.
- Transaction rollback preview.
- Required-provider preflight.
- Kernel-backed run/evidence linkage.

Release gate:

- A required stage cannot proceed without its provider, evidence contract, and evaluator region.
- Workflow apply can preview, apply, and roll back a provider/stage change without touching generated harness files directly.
- Stage/run events are stored in Forge Kernel and visible through issue/run queries.

## 0.0.23 - Memory Projection And Continuous Learning

Beads: reframes `forge-2agy.5`; depends on `0.0.22`.

Primary value:

- Forge turns durable learning into controlled, project-scoped memory projections instead of letting each agent create divergent private memory.

Scope:

- Forge canonical memory categories and provenance requirements remain the source.
- Typed memory hardening: all categories round-trip with provenance; `forget` and `compact` behavior is defined or explicitly rejected for the backing adapter.
- Redaction runs before memory writes and proposal generation, with tests for tokens, absolute paths, env names, URLs, and secrets.
- Continuous-learning pass mines high-signal episodes, recurring corrections, accepted insights, and stable workspace facts.
- Continuous-learning config is parsed from `.forge/config.yaml` with observe/detect/propose autonomy levels, rate limits, and dry-run output.
- Projection adapters emit controlled updates to `AGENTS.md`, `CLAUDE.md`/rules, Cursor rules or `AGENTS.md`, Codex memory/context surfaces, and MCP resources.
- Memory updates use reviewable proposals or transaction manifests for shared files.
- Secrets, one-off instructions, and stale facts are filtered out.

Evaluator regions:

- Durable-signal precision.
- Cross-agent memory consistency.
- Secret/stale-memory rejection.

Release gate:

- A completed session can produce a memory proposal, show evidence/provenance, update the chosen projection surface, and audit the change.
- Existing agent-native memories are treated as generated/local recall, not canonical Forge state.
- Memory writes cannot reach shared projection files until redaction, provenance, and proposal/accept audit checks pass.

## 0.0.24 - Extension-Contributed Runtime Components

Beads: reframes `forge-2agy.6`; depends on `0.0.23`.

Primary value:

- Users and third parties can add stages, substages, verification regions, evidence collectors, hooks, adapters, templates, commands, and UI panels without forking Forge.

Scope:

- Extension manifest `contributes` schema for stages, substages, evaluator regions, evidence collectors, hooks, adapters, templates, commands, and local UI panels.
- `SKILL.md` package contribution is the canonical agent-facing format. Commands, slash aliases, hook files, generated docs, and UI panels are projections from the manifest, not separate hand-maintained sources.
- Week 3 capability-pack resolver from [week-3-runtime-capability-packs.md](./week-3-runtime-capability-packs.md): Forge keeps the stable workflow shell while project/user-selected packs replace, extend, disable, or gate individual stage implementations.
- On-demand skills MCP contract: installed skills can remain discoverable, hidden, gated, or execution-only until `resolve_required_capabilities` or `load_skill` is called by the runtime.
- Runtime-enforced invocation policy: required stage/gate skills cannot be skipped by harness prompt discretion, and expensive or risky skills cannot be randomly auto-invoked.
- Plugin/workflow discovery and recommendation: Forge scans installed packs, harness configs, MCP configs, and marketplace cache, then proposes project-level workflow changes with evidence, config diff, rollback path, and harness projection impact.
- skills.sh/GitHub import path through `packages/skills`: import disabled by default, pin source/ref, validate `SKILL.md`, record trust/permission metadata, then allow project-level enablement through config or UI.
- Documentation validators are a required example extension type: a docs adapter can declare supported file types, discovery signals, config files, CI projections, local hook projections, and UI fields.
- Resolver adds source, trust, permission, collision, and config-source metadata into the runtime graph.
- UI and CLI can enable/disable extension components with `why`, `diff`, and rollback.
- Sandboxed lifecycle hooks stay opt-in and audited.

Evaluator regions:

- Manifest validation.
- Collision and trust handling.
- Toggle/rollback correctness.
- Skill package provenance and permission review.
- Required skill loading and gated-skill non-invocation.
- Harness projection status: `native`, `translated`, `backstop_only`, `unsupported_known_issue`, or `disabled_by_policy`.
- Evaluator cross-check loop that compares the resolved workflow graph to generated harness projections, proposes minimal repair diffs, and re-runs until `pass`, `blocked`, or `known_issue`.
- Negative evaluator fixtures for omitted required skills, ungated gated skills, leaked hidden skills, stale disabled-pack artifacts, and unsupported native hook claims.

Release gate:

- A local extension can contribute a verification substage and UI panel, be toggled on for one project, and be removed without leaving generated artifacts behind.
- A third-party skill package can be imported, reviewed, pinned, enabled for one project, projected into at least Claude and Codex, and disabled without leaving stale command aliases.
- A project can replace Forge `/plan` with a Superpowers-style planning pack, extend frontend review with an Impeccable-style pack, and emit machine-readable evidence showing required skills loaded, optional skills skipped, and per-harness projection status.
- The evaluator catches at least one intentionally broken projection, emits a repair recommendation, and passes after the projection is regenerated.
- The release evidence distinguishes landed behavior from in-flight PR behavior so the plan never claims unmerged parity as current `master` capability.

## 0.0.25 - Cloudflare Team Authority And Projection Workers

Beads: replaces `forge-2agy.7` Beads-plus-remote-projection framing; depends on `0.0.24`.

Primary value:

- Forge can coordinate team work through a server authority while preserving local mode for solo/internal multi-worktree use.

Scope:

- Cloudflare Worker API for auth, routing, and dashboard/API requests.
- Durable Object per project/repo as serialized authority for claims and issue mutations.
- D1 read model for queryable issue, claim, run, projection, and dashboard state.
- Queues for GitHub/Linear/Beads projection jobs, retry, and dead letter handling.
- R2 for large evidence bundles, validation artifacts, and archived session data.
- Server-required team mode. No offline team writes.
- Projection workers for GitHub/Linear run from the server, not local agents.

Evaluator regions:

- Thousand-issue performance.
- Lease correctness.
- Stale/crashed worker detection.
- Cloudflare authority serialization.
- Projection retry/dead-letter correctness.
- Dashboard freshness and provenance.
- Cross-projection consistency.

Release gate:

- Forge can display and filter a large issue graph, claim work for multiple users/agents through server authority, detect stale work, and keep projection failures visible without corrupting Forge Kernel state.

## Public Release Train Discipline After 0.0.18

Each release after `0.0.18` must ship through the same public cadence:

1. Create a Forge Kernel issue or, until the Kernel lands, a Beads issue/epic for the release slice.
2. Open a release branch/worktree.
3. Add or update the design note, acceptance matrix, and evaluator region before implementation.
4. Implement only the release slice.
5. Run targeted tests, release-specific evaluators, `bun run check`, and `npm pack --dry-run`.
6. Run the [Decision drift guards](../../reference/DECISION_DRIFT_GUARDS.md) evaluator checklist for authority, storage, providers, projections, and security/privacy.
7. Publish release notes that include: user value, migration notes, feature flags, known limitations, rollback path, and adapter compatibility.
8. Publish through GitHub Release to npm.
9. Verify the installed package in a clean repo and close or update the Forge Kernel/Beads/GitHub release issue.

## Deferred

- Marketplace allowlist N16.
- Full five resolver set N8; start with local and GitHub only.
- Hardened sandbox.
- Central orchestration layer before the local Kernel and Cloudflare authority contracts are proven.
- Auto-merge by default.
- Direct agent writes to Beads internals, generated harness files, memory projection files, or Forge lock/config/kernel state.
- Treating agent-native memory files as Forge's canonical memory store.

## Deployment Per Release

1. Implement on a release branch/worktree.
2. Run `bun run check`, targeted tests, and release-specific evaluator regions.
3. Bump `package.json` to the next `0.0.x`.
4. Tag and create a GitHub Release.
5. Let `.github/workflows/npm-publish.yml` publish to npm.
6. Verify the npm package and update related Forge Kernel/Beads/GitHub issues.
