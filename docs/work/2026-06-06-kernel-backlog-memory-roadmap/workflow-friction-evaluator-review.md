# Workflow Friction Amendment Evaluator Review

## First evaluator pass

Three evaluators reviewed the workflow-friction amendments from self-hosting UX/release-readiness, plumbing/state/worktree/hooks, and Project Knowledge/agent setup perspectives.

Initial scores:

| Lens | Verdict | Score | Main blockers |
| --- | --- | --- | --- |
| Self-hosting workflow UX / release readiness | REQUEST_CHANGES | 78/100 | Release-lane dependency direction was inverted; broad parent/self dependencies; hook/lint fix was coupled to downstream architecture-hook work; existing-project update path and release smoke gate were under-specified. |
| Plumbing / state / worktree / hooks | REQUEST_CHANGES | 82/100 | Dependencies were too broad; generated-state manifest/contract missing; hook install semantics, protected-state repair constraints, and Dolt hot-path criteria needed sharper acceptance. |
| Project Knowledge / setup / skills | REQUEST_CHANGES | 82/100 | `plan.md`/`plan.md` dependency cycle; orient/recap source classification missing; concrete renderer/template surfaces and evidence artifact contract were under-specified; Beads traceability needed command verification. |

## Changes made after evaluator feedback

### Dependency corrections

- Removed broad inverted dependencies from `forge-2agy.9.9`; it is now a parent-only sequencing/gating issue.
- Replaced `forge-2agy.9.7.8 -> forge-2agy.9.3` with concrete dependencies on `forge-2agy.9.3.36` and `forge-2agy.9.2.10`.
- Removed `forge-2agy.9.3.36 -> forge-2agy.9.7`; it now depends on `forge-2agy.9.3.1` for source inventory/classification.
- Decoupled `forge-2agy.9.3.37` from architecture-capture policy issues `.27`/`.32`; it now depends on CLI authority cleanup and git common-dir worktree routing.
- Updated `forge-2agy.9.7.7` to depend on concrete self-hosting blockers: hook/lint worktree reliability, worktree state bootstrap, and idempotency semantics.
- Expanded `forge-2agy.9.5.11`, `forge-2agy.9.2.10`, and `forge-2agy.9.1.8` dependencies to concrete prerequisites.
- Verified the proposed dependency graph contains no intended cycles; authoritative `bd dep cycles` must be rerun when these proposals are synchronized into Beads/Kernel state.

### Issue body hardening

- Added generated-state manifest/contract requirements: owner, protected-state category, source inputs, content hash/version, line endings, timestamps, and generated/runtime/durable classification.
- Added clean-checkout + linked-worktree lifecycle smoke gate for push/review/verify/merge/post-merge cleanup without stash/manual repair.
- Added existing-project update/repair coverage for fresh setup alignment.
- Added concrete renderer/template surfaces: `AGENTS.md`, `CLAUDE.md`, `.claude/commands/**`, `.claude/rules/**`, cross-agent skills/templates, `docs/reference/AGENT_SKILL_PARITY.md`, `lib/harness-capability-matrix.js`, and packages/skills templates.
- Added seed stale-reference surfaces for the `plan.md` to `plan.md` migration.
- Added KnowledgeStore/orient/recap source classes: `work_plan`, `legacy_work_design`, `architecture_design`, `task_list`, `decision_log`, `evidence`, `issue_body`, `comment`, `stage_run`, `generated_harness`, `runtime_projection`, `derived_summary`, and `proposal`.
- Added proof artifact classification for `evidence.md`, `validation.md`, `validation-notes.md`, stage-run logs, and command evidence.
- Added exact hook/lint Git path checks, lint discovery order, `--json`/`--dry-run`, and no-private-profile-write constraints.
- Added worktree state doctor repair requirements: common-dir Kernel DB location, idempotent repair, no overwrite, backup/quarantine, hook doctor sub-result, protected-state-aware writes.
- Added Dolt hot-path retirement hard criteria: normal Forge commands must not shell out to `bd`, read `.beads/issues.jsonl`, treat Beads/Dolt sync as authority, or require Dolt except inside import/export/projection adapters.

## Verification after fixes

- Proposed dependency graph review returned no intended dependency cycles.
- The eight workflow-friction issue body files were hardened for later `bd update --body-file`/Kernel synchronization.
- `workflow-friction-beads-proposed.tsv` and `issue-map.md` were updated with corrected dependencies.

## Second evaluator pass

Second-pass results after the dependency and issue-body fixes:

| Lens | Verdict | Score | Remaining blockers |
| --- | --- | --- | --- |
| Self-hosting workflow UX / release readiness | PASS | 94/100 | None. |
| Plumbing / state / worktree / hooks | PASS | 95/100 | None. |
| Project Knowledge / setup / skills | REQUEST_CHANGES | 92/100 | Evidence artifact contract needed concrete required fields, not only source classification. |

## Final evidence-contract fix

The Project Knowledge/setup evaluator found one remaining blocker: evidence files were classified but did not yet have a minimum contract. The plan was revised to require evidence artifacts to include:

- issue/work item id;
- stage/task id;
- command/run id;
- command string or tool name;
- exit code/verdict;
- timestamp;
- actor/session;
- stdout/stderr or log path;
- source file refs;
- commit SHA/revision/hash;
- redaction state;
- provenance/source type;
- links back to relevant `tasks.md` and `decisions.md` entries.

Applied updates:

- `beads/design-md-plan-md-migration.md` now defines the minimum evidence artifact contract and says incomplete evidence is surfaced as incomplete/proposal, not accepted proof.
- `beads/new-project-work-folder-structure.md` now teaches the same fields in fresh and existing-project setup guidance.
- `issue-map.md` and `workflow-friction-beads-proposed.tsv` now make `forge-2agy.9.7.8` depend on `forge-2agy.9.7.5` (`Define agent work contract for claims stages and evidence`).
- The proposed issue descriptions for `forge-2agy.9.7.8` and `forge-2agy.9.3.36` were aligned with the body files for later authoritative synchronization.
- The proposed dependency graph still has no intended dependency cycles; authoritative cycle checks must run when state is synchronized.

## Final expectation

Final narrow Project Knowledge/setup re-check after the evidence-contract fix returned **PASS — 96/100** with no remaining critical blockers.

The amended issue set is ready for implementation handoff.
