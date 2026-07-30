# Skill Invocation Metadata Tasks

These slices are sequential. Each leaves a runnable regression check and maps directly to the
approved plan. No implementation starts until the plan is approved.

Workflow-owned artifacts:

- `AGENTS.md`
- `CHANGELOG.md`
- `docs/work/2026-07-29-skill-invocation-metadata/plan.md`
- `docs/work/2026-07-29-skill-invocation-metadata/tasks.md`
- `docs/work/2026-07-29-skill-invocation-metadata/decisions.md`

## Task 1: Lock the effective invocation metadata contract

Wave: 1

OWNS:

- `lib/using-forge.js`
- `test/using-forge.test.js`
- `test/skills/context-cost.test.js`

What to implement:

Extend the existing lightweight canonical frontmatter reader so parsed skill metadata exposes
an effective invocation. Accept exact `model` and `user`, resolve omission to `model`, and
leave invalid input observable to the gate instead of coercing it. Update the context-cost
gate to validate the enum/default while retaining its existing non-empty description,
1024-character description, and body-line checks. Do not change catalog membership, router
weights, or route results.

TDD steps:

1. RED — in `test/using-forge.test.js`, add fixtures for explicit `model`, explicit `user`,
   omitted metadata resolving to `model`, and an invalid value being rejected/flagged. Assert
   the catalog still contains user-invoked entries and existing route fixtures are unchanged.
2. RED — in `test/skills/context-cost.test.js`, make the canonical sweep fail on any effective
   invocation outside `model|user`; add an isolated invalid fixture or exported helper test
   that fails with `invalid invocation`.
3. Run:
   `bun test test/using-forge.test.js test/skills/context-cost.test.js`
   and confirm the new assertions fail because invocation is not parsed or validated.
4. GREEN — minimally extend the current `applyFrontmatterLine`/`parseFrontmatter` state in
   `lib/using-forge.js`; reuse it from the context gate rather than introducing a parser
   module or dependency.
5. Run the same command and confirm the new metadata/default tests and all existing routing
   tests pass.
6. REFACTOR — remove duplicated invocation normalization if the tests introduced any; rerun
   the same command.
7. Commit: `feat(skills): define invocation metadata contract`

Expected output:

- Exact `model|user` values pass.
- Omission resolves to `model`.
- Invalid values fail visibly.
- Existing `forge skill for` routing fixtures remain green.

Requirement anchors: success criteria 1, 2, 6, and 7; missing/invalid metadata edge cases.

## Task 2: Carry invocation through canonical listing and verbatim projections

Wave: 2

OWNS:

- `lib/skills-sync.js`
- `test/skills/skills-sync.test.js`
- `packages/skills/test/sync.test.js`

Verification-only:

- `packages/skills/src/commands/sync.js`

What to implement:

Expose the effective invocation from `listCanonicalSkills()` by reusing Task 1's metadata
reader. Preserve the existing copy implementation: user- and model-invoked skills both remain
installed, and `SKILL.md` is copied verbatim. Add equivalent packaged-sync fixtures proving
that root `skills/` and higher-precedence `.skills/` sources retain the selected source's
invocation bytes. Modify `packages/skills/src/commands/sync.js` only if a failing test proves
its existing `cpSync` path does not already satisfy the contract.

TDD steps:

1. RED — in `test/skills/skills-sync.test.js`, create canonical fixtures with omitted,
   `model`, and `user` invocation; assert `listCanonicalSkills()` reports effective values and
   `populateAgentSkills()` writes byte-identical `SKILL.md` files for both modes.
2. RED — in `packages/skills/test/sync.test.js`, add `invocation: user` to a root fixture and
   a conflicting `.skills/` fixture; assert every detected harness receives the winning
   source verbatim and the user-invoked skill is not filtered out.
3. Run:
   `bun test test/skills/skills-sync.test.js packages/skills/test/sync.test.js`
   and confirm the internal metadata-list assertion fails before implementation.
4. GREEN — add only the metadata read needed by `listCanonicalSkills()` in
   `lib/skills-sync.js`. Keep `copySkillDir` and the package `cpSync` path unchanged when the
   projection assertions already pass.
5. Run the same command and confirm internal and packaged projection tests pass.
6. REFACTOR — confirm no second invocation enum/default table was introduced; rerun the same
   command.
7. Commit: `test(skills): preserve invocation across projections`

Expected output:

- Canonical listing reports the effective invocation.
- User-invoked skills are still installed.
- Root/shadow precedence is unchanged.
- All projected `SKILL.md` content is byte-identical to the selected source.

Requirement anchors: success criteria 5 and 6; shadow precedence, explicit installation, and
byte-identity edge cases.

## Task 3: Mark the approved user-invoked skills and regenerate the committed mirror

Wave: 3

OWNS:

- `skills/ship/SKILL.md`
- `skills/ship/evals/scorecard.json`
- `skills/review/SKILL.md`
- `skills/review/evals/scorecard.json`
- `skills/rollback/SKILL.md`
- `skills/rollback/evals/scorecard.json`
- `.agents/skills/ship/SKILL.md`
- `.agents/skills/ship/evals/scorecard.json`
- `.agents/skills/review/SKILL.md`
- `.agents/skills/review/evals/scorecard.json`
- `.agents/skills/rollback/SKILL.md`
- `.agents/skills/rollback/evals/scorecard.json`

Verification-only:

- `scripts/sync-agent-skills.js`
- `test/skills/stage-skills.test.js`
- `test/structural/skills-sync-drift.test.js`
- `test/agents-skills-repo-discovery.test.js`
- `test/skill-eval.test.js`

What to implement:

Add `invocation: user` to exactly `ship`, `review`, and `rollback`. Trim only their
frontmatter descriptions to concise purpose and explicit-use cues while preserving authority
boundaries and stop conditions. Do not change bodies or any model-invoked skill. Regenerate
the deterministic canonical scorecards with `forge skill eval --static`, then regenerate the
committed `.agents/skills` copies from canonical source; never hand-edit generated artifacts.

TDD steps:

1. RED — add/extend the canonical metadata expectation so the approved user-invoked set is
   exactly `ship`, `review`, and `rollback`; run:
   `bun test test/skills/context-cost.test.js`
   and confirm it fails because the three files still default to `model`.
2. GREEN — update only the three canonical frontmatter blocks with `invocation: user` and
   concise descriptions no longer carrying dense automatic-routing prose.
3. Run:
   `bun test test/skills/context-cost.test.js test/skills/stage-skills.test.js test/using-forge.test.js`
   and confirm metadata, description budgets, YAML, and unchanged deterministic routing pass.
4. RED — run:
   `bun test test/structural/skills-sync-drift.test.js`
   and confirm the committed `.agents/skills` mirror is reported stale after canonical edits.
5. GREEN — refresh the three canonical scorecards through `forge skill eval --static`, then
   regenerate `.agents/skills` through `scripts/sync-agent-skills.js` (or the same
   `populateCodexRepoSkills` path it calls), then rerun:
   `bun test test/structural/skills-sync-drift.test.js test/agents-skills-repo-discovery.test.js`
   and `bun test test/skill-eval.test.js -t "committed scorecards stay fresh"`.
6. REFACTOR — inspect the diff and remove any body, model-skill, unrelated mirror, or
   non-generated scorecard change;
   rerun all focused tests from Tasks 1–3.
7. Commit: `feat(skills): mark explicit invocation skills`

Expected output:

- Only `ship`, `review`, and `rollback` declare `invocation: user`.
- Every other skill has effective invocation `model`.
- All descriptions remain non-empty and within 1024 characters.
- Canonical and generated harness mirrors are byte-identical.
- Canonical and mirrored scorecards equal the deterministic recomputation.
- Router behavior remains unchanged.

Requirement anchors: success criteria 3, 4, 5, 7, and 8; fixed classification and
description-trimming edge cases.

## Final focused validation

Run:

```text
bun test test/using-forge.test.js test/skills/context-cost.test.js test/skills/skills-sync.test.js test/skills/stage-skills.test.js test/structural/skills-sync-drift.test.js test/agents-skills-repo-discovery.test.js packages/skills/test/sync.test.js
bun test test/skill-eval.test.js -t "committed scorecards stay fresh"
node scripts/check-agents.js
```

Expected:

- All focused tests pass.
- `check-agents` reports no skill drift.
- `git diff --check` is clean.
- No files outside Task `OWNS` and the workflow-owned artifacts changed.

## YAGNI review

- Task 1 anchors the canonical enum/default and gate.
- Task 2 anchors projection/default compatibility and existing shadow precedence.
- Task 3 anchors the approved skill classification, concise descriptions, and byte-identical
  committed mirror.

No unanchored task remains. Router redesign, native harness metadata, adaptive evaluation, and
new configuration are intentionally absent.
