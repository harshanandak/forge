# Forge 0.1.0 Stable Release Plan

Date: 2026-07-28

Authority: Kernel epic `068374e5-c0af-493f-b50b-972364e5d6c7`

Current published version: `0.1.0-beta.4`

## 1. Release objective

Ship `forge-workflow@0.1.0` as a trustworthy npm product for individual developers and coding agents on Node.js `>=22.16.0`, Windows, and Linux. The stable contract is the complete supported journey:

1. Install Forge without modifying an unrelated project or parent directory.
2. Activate a suitable minimum automatically, with setup remaining progressive and reversible.
3. Orient from bounded project and issue context.
4. Automatically surface the relevant Forge skill and relevant project memory without requiring the user to name either one.
5. Execute issue, worktree, plan, development, validation, PR, shepherd, merge, close, and cleanup operations through Forge's authoritative surfaces.
6. Preserve user configuration and fail visibly when Forge cannot prove safety.
7. Upgrade or roll back without corrupting project or kernel state.

Stable does not promise every roadmap feature. It promises that the supported contract above is honest and reliable.

## 2. Verified planning baseline

- The Kernel currently contains 407 open issues: 32 P0, 77 P1, 242 P2, 50 P3, and 6 P4 after promoting the 14 S0 issues and terminal release task. The full backlog still cannot be a stable blocker set.
- The exact stable cohort is evidence-selected across priorities; P0 roadmap epics can defer while a P2 trigger or test-safety defect can block stable.
- `forge release check --target 0.1.0-beta.5 --json` currently returns success with no structural blockers. This proves the existing static release gate passes; it does not prove the stable user journey.
- Eighteen squash commits have landed since `v0.1.0-beta.4`, covering Kernel authority, Beads retirement, status/orientation, memory recall, setup, worktree cleanup, CI selection, audit repair, and test isolation.
- Publication is already guarded by GitHub Release creation, tag/version equality, tests, release readiness, `npm pack --dry-run`, npm Trusted Publishing, provenance, and prerelease dist-tag routing.

## 3. Scope rule

An issue blocks `0.1.0` only when an accepted reproduction shows that it violates one of the seven supported-journey steps, corrupts authoritative state, creates an unsafe default, or makes the release evidence unreliable.

Every open issue is classified into exactly one bucket:

- **S0 — stable blocker:** must close before `0.1.0`.
- **S1 — stable follow-up:** valuable hardening that may ship in `0.1.x`.
- **R — roadmap:** additive capability not required by the stable contract.
- **D — duplicate/obsolete/container:** close, supersede, or retain only as an epic after child reconciliation.

Priority alone does not decide the bucket. A P0 future dashboard capability can be roadmap; a P1 setup-clobber bug can block stable.

## 4. Stable blocker cohort

The beta-readiness epic, its 21 recorded children, all open issues, current release mechanics, and the 18 post-beta.4 changes were reviewed against the supported stable journey. The exact S0 cohort is:

| Lane | S0 issue | Release failure |
|---|---|---|
| Skills | `588e6973` description hygiene | Skill descriptions exceed the model trigger surface, so reliable automatic selection cannot be claimed. |
| Skills | `6bc72f4f` packaged dispatch pointer | Packaged `AGENTS.md` lacks the agent-agnostic Forge dispatch pointer, so Codex-style installs miss Forge routing. |
| Skills | `d362bd71` behavioral holdout and hook-integration loop | Stable needs one owned integration tail plus measured trigger precision, recall, variance, and regression evidence. |
| Skills | `c81eb263` skills-only/no-hooks | Users cannot adopt Forge skills without accepting unrelated enforcement. |
| Memory | `36461e50` ctx-grade federated recall | Automatic project-scoped, budgeted recall/injection, SessionStart hooks, provenance, and telemetry are not yet a dependable floor. |
| Setup | `f0385fa1` preserve `CLAUDE.md` | Setup can overwrite user-owned harness instructions. |
| Setup | `183d38fc` lazy config disables gates | Lazy-created config silently ships enforcement disabled. |
| Test safety | `10a6f241` affected-test HEAD fallback | The fast lane can report green from a shrunken or unresolved changed-file set. |
| Kernel truth | `940b904b` close exits zero without mutation | A refused issue close can report process success while leaving state unchanged. |
| Worktrees | `8606ea93` ambient-cwd creation | Worktree creation can execute against the wrong repository. |
| Worktrees | `cb8c7ab6` linkage repair | Reusing a worktree does not repair missing issue/work-folder provenance. |
| Process lifecycle | `87a8394e` orphaned shards and claims | Stopped pre-push hooks can leave test processes and claims alive after the worktree is gone. |

| Release safety | `af79e102` publication test coverage | The GitHub Release workflow tests only `test/`, excluding package-skills, environment, and full-suite coverage before Trusted Publishing. |
| PR lifecycle | `49f438f0` automatic Shepherd attachment | Active open or draft PRs are not automatically owned by Shepherd, so agents can silently fall back to manual polling and miss Forge's authoritative lifecycle. |

### Explicit post-stable scope

The following remain tracked but do not block `0.1.0`: foreign-skill governance `1b6c1529`; chain-correctness eval `3223e37e`; formal pluggable MemoryBackend `5037a7da`; attention-following PreToolUse injection `33d6dce9`; session-learning nudge `6d5ed439`; optional reranking/embeddings `9c343cdb`; progressive-disclosure recall `dae18794`; static typed-memory instruction projection `dce9da46` and broader cross-harness parity `90f2f631` unless RC evidence proves the dynamic hook cannot satisfy a supported harness; residual one-behind preflight hardening `695d4fef`; stale-hook-backup refresh `f903895c`; broad worktree sprawl `3e56f635`; Dependabot automation `1b2f0a2d`; team-server authority `926d772a`; hosted/live-dashboard work under `7c813e9d` and `32ca73fd`.

These deferments do not waive a reproduced S0 failure. If one breaks the supported stable journey during RC testing, it is promoted with evidence.

## 5. Stable automatic-context contract

Forge's skills, memory, insights, and diagnostic commands are not stable merely because they can be queried manually. Operational availability requires automatic, bounded delivery.

### Verified mechanisms to adopt

The installed context-mode and Superpowers plugins show complementary patterns:

- Context-mode declares a full lifecycle in `hooks/hooks.json`: SessionStart injection, UserPromptSubmit capture, PreToolUse routing, PostToolUse event capture, and PreCompact snapshotting.
- Context-mode always initializes a compact routing block before optional session recovery (`hooks/sessionstart.mjs:34`) and emits it through `additionalContext` (`hooks/sessionstart.mjs:165-169`). Continuity failures are logged but do not block startup (`hooks/sessionstart.mjs:152-162`).
- Its routing core normalizes tool names across harnesses and supports deny, ask, modify, targeted context, or passthrough (`hooks/core/routing.mjs:1-10,92-142`). Guidance is throttled once per session with an atomic cross-process marker (`hooks/core/routing.mjs:22-55`) instead of repeating prose on every tool call.
- Superpowers synchronously injects the complete `using-superpowers` bootstrap at SessionStart (`hooks/session-start:10-27`) and formats the correct context envelope per harness (`hooks/session-start:29-46`). Its model-visible descriptions state concrete triggering situations, including a bootstrap description that applies at the start of every conversation (`skills/using-superpowers/SKILL.md:1-4`).

Forge should combine those strengths: an unavoidable small bootstrap, complete trigger descriptions, prompt/tool-specific bounded routing, cross-harness normalization, once-per-session throttling, post-action evidence, and best-effort continuity. It should not copy Superpowers' full-body injection for the entire memory store; memory remains an index-first, top-k retrieval system.

Forge is not starting from zero. `lib/hook-renderer.js:325-357` already renders SessionStart memory injection, a shared UserPromptSubmit group with inbox, shepherd events, and query-relevant memory recall, plus PreCompact/Stop memory capture. The S0 problem is therefore end-to-end operational reliability: installation/activation coverage, whether the prompt reaches recall, retrieval quality and budgets, whether emitted context reaches the agent, cross-harness parity, and observable misses. Stable work must debug and prove this live path rather than adding a second parallel memory hook.

### 5.1 Session-start index

At session start Forge injects a small, generated orientation envelope:

- project identity and active issue/worktree;
- available authoritative skill descriptors;
- memory health and backend status;
- the retrieval policy and token budget;
- explicit commands for inspecting why something was or was not selected.

The envelope is an index, not a dump. It stays below a fixed token budget and points retrieval at authoritative stores.

### 5.2 Prompt-time retrieval

On each user prompt a hook:

1. classifies intent using deterministic signals plus the skill registry;
2. selects a small set of relevant skill candidates whose descriptions contain complete trigger information;
3. queries all enabled memory backends through one adapter;
4. applies scope, supersession, staleness, deduplication, and relevance ranking;
5. injects only the bounded top results;
6. records candidates, selected results, token cost, latency, and empty/error outcomes.

Retrieval failure does not block the user's prompt, but it must be visible in health/evidence instead of silently looking like “no memory applied.”

### 5.3 Skill authority

- Canonical skill descriptions carry all trigger conditions because the model chooses from descriptions before loading skill bodies.
- Generated harness projections are drift-checked against the canonical registry.
- Prompt-time routing surfaces applicable skills without requiring `/skill-name`.
- A selection explanation reports why a skill was selected, rejected, or unavailable.
- Stable evaluation includes positive triggers, confusing-neighbor negatives, composition conflicts, and holdout prompts.

### 5.4 Shadow-to-enforcement rollout

1. Shadow-log what Forge would inject without changing prompts.
2. Measure precision, recall, miss rate, latency, token cost, stale retrievals, and duplicate retrievals.
3. Enable bounded automatic injection by default after thresholds pass.
4. Keep per-project and per-rule disable controls.
5. Treat persistent high-confidence misses as release blockers; advanced multi-skill composition remains post-stable.

## 6. Parallel delivery lanes

Maximum WIP is four PRs. Every agent receives its own Forge-created worktree. One merge-train coordinator owns issue assignment, collision checks, current-head review settlement, and cleanup.

### Lane A — skill and diagnostic selection

S0: `588e6973`, `6bc72f4f`, `d362bd71`, `c81eb263`.

Primary surfaces: canonical skill descriptions, packaged dispatch rules, skills-only adoption, routing/evaluation fixtures. Existing capabilities such as `status`, `insights`, `doctor`, `recommend`, and `upgrade` must become agent-triggerable from evidence rather than requiring the user to name them.

Exit evidence: positive and confusing-neighbor holdouts select the correct skill/diagnostic without explicit naming, irrelevant prompts stay quiet, packaging preserves the dispatch pointer, and skills-only mode installs no unrelated enforcement. `d362bd71` owns the final cross-lane hook integration and cannot close until the memory lane has landed and the combined routing envelope passes selection, rejection, latency, token-budget, and error-telemetry gates.

### Lane B — automatic memory

S0: `36461e50`.

Primary surfaces: federated recall index, budgeted retrieval, SessionStart/UserPromptSubmit hooks, project scoping, provenance, telemetry, and holdouts.

Exit evidence: relevant project memory is automatically surfaced within budget; cross-project, stale, duplicate, and irrelevant memories do not win; misses and retrieval errors are observable rather than silent.

### Lane C — lifecycle trust

S0: `f0385fa1`, `183d38fc`, `940b904b`, `8606ea93`, `cb8c7ab6`, `87a8394e`.

Primary surfaces: setup preservation, config defaults, issue mutation exits, worktree root/provenance, process/claim reconciliation.

Exit evidence: user instructions survive setup; default gates remain truthful; refused writes exit non-zero and remain absent after re-read; worktree operations target the resolved repo; stopped hooks leave no orphaned shards or claims.

### Lane D — test and release evidence

S0: `10a6f241`, `af79e102`, `49f438f0`.

Primary surfaces: affected-test selection, automatic Shepherd attachment/containment, release readiness, npm workflow, package inspection, clean/upgrade/rollback journey fixtures.

Exit evidence: every active open or draft PR automatically acquires a contained Shepherd monitor; `gh pr view` remains an allowed instantaneous detail check but never becomes the lifecycle owner; changed-file resolution fails closed; publication consumes same-SHA full release evidence; package-skills and environment tests are covered; Windows/Linux install/upgrade/rollback journeys pass.

### Collision and merge rule

Lifecycle trust lands first because every other lane depends on truthful writes, setup, and process cleanup. Lanes A and B may proceed independently until their outputs are ready. The existing S0 issue `d362bd71` owns the integration tail and is blocked by `588e6973`, `6bc72f4f`, `c81eb263`, and `36461e50`; it wires skill, memory, insights, and diagnostic routing into one bounded hook envelope. Because terminal release task `8e634347` already depends on `d362bd71`, the release cannot unblock without accepted integration evidence. Lane D owns the exact release candidate and publication evidence. If two lanes need the same canonical source, the next-at-bat PR owns it; update only that branch, not every active branch.

### Three-hour merge cadence

The operating target is **four merged PRs per three-hour cycle**:

1. At cycle start, `forge ready` supplies unblocked S0 work and the coordinator chooses up to four issues with disjoint canonical files.
2. Each issue gets one claimed Forge worktree and one accountable owner. No agent edits the shared checkout.
3. Implementation, focused tests, review response, push, CI, current-head thread verification, merge, Kernel close, and worktree cleanup occur inside the same cycle.
4. The coordinator keeps the next cycle preloaded with test preparation and investigation for blocked work, but only four implementation PRs remain active.
5. If one lane blocks, replace its slot with another non-colliding ready S0/S1 reliability issue; do not make the other three lanes wait.
6. Track planned, opened, green, merged, cycle time, review-turn count, and blocker cause for every slot. Repeated blocker causes become Forge improvements.
7. Use the installed Codex plugin for bounded, independent implementation, test, log-analysis, and triage slots when it preserves context and throughput. Codex workers still receive isolated Forge worktrees and cannot own merge/dependency decisions.

The 14 S0 issues, including hook integration inside `d362bd71`, plus one beta.5 release PR imply about 15 PRs: four merge cycles, approximately 12 active delivery hours, with calendar allowance for CI/review. The release plan therefore targets feature-complete beta.5 on 2026-07-31 rather than 2026-08-07.

### Dogfood improvement loop

Every merged stable issue runs two reviews:

1. **Work:** Did the implementation satisfy the issue, stable contract, edge cases, and future composition?
2. **Process:** What did Forge fail to surface, automatically trigger, retrieve, enforce, diagnose, or clean up while the issue was being delivered?

The issue receives one structured stage-exit comment with non-empty labeled `Summary`, `Decisions`, `Artifacts`, and `Next` fields; `Evidence` and `Process friction` remain additional labeled fields when applicable. Repeated or structural friction is filed or linked immediately, then ranked when it improves the substrate for later issues. The program must dogfood Forge worktrees, Kernel dependencies, memory, skill/diagnostic routing, shepherd, merge, close, insights, and cleanup rather than relying on an invisible parallel process.

## 7. Merge and dependency order

1. **Stabilize the baseline:** merge PR `#460` after current-head checks, zero unresolved threads, mergeability, and quiet-time gates pass. Resolve or deliberately defer PR `#461`; a dependency-only PR does not block stable unless it exposes a real release failure.
2. **Freeze the exact cohort in the Kernel:** reconcile `068374e5` children, retain the 14 verified S0 issues, and classify all remaining work S1/R/D without implementing it. Terminal release task `8e634347` is P0 and blocked by every S0 issue.
3. **Land lifecycle trust first:** `f0385fa1`, `183d38fc`, `940b904b`, `8606ea93`, `cb8c7ab6`, `87a8394e`.
4. **Run skills and memory independently:** Lane A (`588e6973`, `6bc72f4f`, `d362bd71`, `c81eb263`) and Lane B (`36461e50`).
5. **Land the integration tail under `d362bd71`:** after its three skill dependencies and `36461e50` land, the issue wires skill, memory, insights, and diagnostic routing into one automatic, bounded, explainable, and measured hook envelope. The terminal release task remains blocked by `d362bd71`.
6. **Make PR ownership automatic:** `49f438f0` attaches contained Shepherd monitoring whenever an active open or draft PR exists; agents may use `gh pr view` for instant detail but never as the continuing monitor.
7. **Close test/release evidence:** `10a6f241` and `af79e102`; make publication consume same-SHA full evidence.
8. **Cut feature-complete beta.5 by 2026-07-31:** all S0 work merged; repair beta.4 changelog history and release reference, update version/notes, publish under npm `beta`, verify provenance, and run 48-hour postpublish smoke. No new stable-surface feature follows beta.5.
9. **Cut RC1 by 2026-08-07:** after seven days of beta.5 soak, repeat the same-SHA matrix and publish `0.1.0-rc.1` under the prerelease `beta` dist-tag.
10. **Cut RC2 by 2026-08-14:** any behavior change after RC1 requires RC2. Only reproduced release-stopper fixes may differ; repeat clean install, upgrade, rollback, automatic-context, and process-lifecycle evidence and reset every affected gate.
11. **Prepare and soak the exact stable SHA:** immediately after RC2 publishes, merge a metadata-only promotion PR whose package/changelog/release notes already say `0.1.0`, run the complete same-SHA matrix, and record the resulting `master` SHA as the stable candidate. Any later commit creates a new candidate and restarts its seven-day clock.
12. **Promote by 2026-08-21:** after the exact stable-candidate SHA has seven clean days and the program has two weekly RC gates plus at least 14 cumulative RC soak days, tag that unchanged SHA `v0.1.0`. No last-minute version or documentation commit is permitted.

## 8. Release-candidate gates

A release candidate is eligible only when all are true on the same commit:

- all required CI checks succeed;
- zero unresolved review threads;
- release readiness returns no blockers;
- `npm pack --dry-run` contains only intended public files;
- install and uninstall/disable journeys pass on clean Windows and Linux environments;
- Claude, Codex, Cursor, and Hermes clean-install, skill discovery/invocation, projection, activation, and hook-delivery paths pass wherever support is advertised;
- existing `CLAUDE.md`/agent instructions and user hooks survive setup;
- minimal/standard/full and skills-only choices behave as advertised;
- automatic skill/memory holdout evaluation meets the locked thresholds established during shadowing;
- Kernel dependency, concurrency, worktree cleanup, and check-after-write negative cases pass;
- every active open or draft PR automatically acquires a contained Shepherd monitor, and Shepherd evaluates the current head without reporting CLEAN on stale evidence;
- no deterministic failing test is waived as a flake;
- rollback to the prior beta/stable package is documented and exercised.

Stable publication uses an exact-SHA promotion gate. Immediately after RC2, the final metadata-only `0.1.0` commit is merged to `master`, the full matrix and package checks run on that resulting SHA, and that same SHA soaks for seven clean days. The `v0.1.0` tag is then applied to the unchanged candidate. A metadata or behavior change creates a new candidate; a behavior change additionally requires a new RC2 and resets the affected RC evidence.

## 9. Schedule

### 2026-07-28 through 2026-07-30 — S0 delivery

Land lifecycle trust first. Run skill/diagnostic selection and automatic memory in parallel worktrees. Land the small hook-integration tail, then close test and publication evidence. No non-S0 roadmap implementation enters this window.

### 2026-07-31 — feature-complete beta.5

Every S0 is merged and re-read done. Repair release history/docs, publish under npm `beta`, verify provenance and packed contents, and start 48-hour postpublish plus seven-day clean-install/upgrade soak.

### 2026-08-07 — RC1

Repeat the same-SHA matrix after beta.5 soak, publish RC1 under the prerelease `beta` dist-tag, and continue Windows/Linux install, upgrade, rollback, skill/memory holdout, and orphan-process evidence.

### 2026-08-14 — RC2

Any behavior change after RC1 requires RC2. Only reproduced release-stopper fixes may differ; repeat the complete matrix and reset every affected evidence gate. After RC2 publishes, merge and validate the final metadata-only `0.1.0` promotion commit, record the resulting `master` SHA, and begin its seven-day exact-SHA soak.

### 2026-08-21 — stable target

Tag the unchanged stable-candidate `master` SHA as `v0.1.0` only after that exact SHA has seven clean days, the program has passed two weekly RC gates and at least 14 cumulative RC soak days, and every S0 is verified done. Any intervening commit restarts the stable-candidate clock. Extend rather than weaken a gate. Do not extend for roadmap work.

## 10. Stop and rollback conditions

Stop promotion when any of these occurs:

- authoritative state can be corrupted or a refused mutation becomes observable;
- setup overwrites user-owned instructions or hooks;
- automatic context leaks secrets, crosses project scope, or regularly injects stale/irrelevant content;
- supported Windows/Linux install or clean removal fails;
- shepherd or readiness reports green from stale/missing evidence;
- npm package contents or tag/version mismatch;
- a deterministic test failure is unresolved.

Rollback by deprecating the affected npm version if published, restoring the prior dist-tag, reverting the release commit through a normal reviewed PR, and preserving the failing evidence as a Kernel issue and regression fixture.

## 11. Completion definition

The stable-release epic closes only after:

- `forge-workflow@0.1.0` is published with provenance;
- npm `latest` resolves to that verified version;
- the GitHub Release and changelog describe the same supported surface;
- a fresh external project completes the supported journey without repository-local maintainer state;
- every S0 issue is verified done and re-read from the Kernel;
- every deferred candidate is explicitly S1/R with rationale rather than silently forgotten.
