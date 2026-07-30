# Skill Invocation Metadata Plan

## Feature

- Slug: `skill-invocation-metadata`
- Date: 2026-07-29
- Classification: Standard
- Forge issue: `588e6973-842c-47aa-aff3-77434e0ccdcc`
- Status: Approved on 2026-07-30; implementation complete
- Planning path: `plan.final_lock` completed

## External planner evidence

This lock reuses already-approved evidence rather than reopening the design:

- The issue defines the description-hygiene problem and the model-versus-user invocation split.
- The issue audit comment fixes the rework-prevention seam: one harness-neutral
  `invocation: model|user`, missing means `model`, every projection derives from the same
  metadata, and generated mirrors remain byte-identical.
- `docs/work/2026-07-28-stable-release/plan.md` makes this issue an S0 prerequisite for the
  later behavioral-evaluation integration owned by `d362bd71`.
- `docs/work/2026-07-05-efficiency-extensibility-strategy/strategy.md` identifies
  `rollback` as explicitly invoked and warns against host-specific frontmatter.

The live repository changes one historical premise: `bun test
test/skills/context-cost.test.js` currently passes, and all 25 descriptions are already
within the 1024-character cap. This issue therefore locks the durable metadata contract and
prevents regression; it does not claim the old 17/19 overflow is still present.

## Purpose

Give Forge one portable way to distinguish skills that need model-selection prose from skills
that users invoke explicitly. This lets user-invoked descriptions stay concise without
inventing separate Claude, Codex, Cursor, or Hermes metadata and gives gates and sync code one
effective invocation value.

## Success criteria

1. Canonical skill metadata accepts only lowercase `invocation: model` or
   `invocation: user`; omission resolves to `model` for backward compatibility.
2. Invalid invocation values fail the canonical metadata/context-cost gate instead of being
   silently treated as model-invoked.
3. The initial explicit user-invoked set is exactly `ship`, `review`, and `rollback`; all
   other current skills remain model-invoked through the default and keep their routing prose.
4. The three user-invoked descriptions are concise, non-empty, and at most 1024 characters.
   The live 1024-character cap continues to apply to every skill.
5. Internal and packaged skill sync preserve the selected canonical `SKILL.md` verbatim,
   including `invocation`, across `.agents`, `.claude`, `.codex`, `.cursor`, and `.hermes`.
6. Missing metadata in an older or third-party skill still projects and behaves as
   model-invoked; a user-invoked skill is still projected because explicit invocation needs
   the skill body.
7. The existing deterministic router and behavioral evaluator remain behaviorally unchanged;
   their current tests continue to pass.
8. Focused metadata, description-budget, sync, mirror-drift, and repository-discovery tests
   pass.

## Approach selected

Extend the existing lightweight frontmatter reader in `lib/using-forge.js` with one effective
invocation field. Reuse that result from the internal canonical-skill listing instead of
creating a second runtime metadata abstraction. Keep both sync paths as whole-directory,
verbatim copies; add regression fixtures proving the metadata survives and that omission has
the model default. Add `invocation: user` only to the three approved explicit skills and
regenerate the committed `.agents/skills` mirror.

This is the smallest approach that makes the contract machine-readable while preserving the
current router and byte-identical projection architecture.

## Constraints

- Canonical source remains `skills/<name>/SKILL.md`.
- `invocation` is harness-neutral and has exactly two values: `model` and `user`.
- Omitted metadata means `model`; do not mass-edit every model-invoked skill.
- Do not emit `disable-model-invocation`, `context:fork`, `model`, or any other
  harness-specific field.
- Do not filter user-invoked skills out of generated directories.
- Do not add a dependency or a new parser module; reuse the current frontmatter readers and
  the package sync's existing whole-file copy.
- Do not change route weights, intent rules, stage ordering, or evaluation thresholds.
- Generated mirror content must remain byte-identical to canonical content, aside from the
  drift check's existing CRLF normalization.

## Owned implementation and generated files

Implementation and approved generated follow-ups may change only these files unless an
ambiguity gate stops the task first:

- `docs/work/2026-07-29-skill-invocation-metadata/plan.md`
- `docs/work/2026-07-29-skill-invocation-metadata/tasks.md`
- `docs/work/2026-07-29-skill-invocation-metadata/decisions.md`
- `lib/using-forge.js`
- `lib/skills-sync.js`
- `test/using-forge.test.js`
- `test/skills/context-cost.test.js`
- `test/skills/skills-sync.test.js`
- `packages/skills/test/sync.test.js`
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

Existing verification-only surfaces:

- `test/skills/stage-skills.test.js`
- `test/structural/skills-sync-drift.test.js`
- `test/agents-skills-repo-discovery.test.js`
- `test/skill-eval.test.js`
- `scripts/sync-agent-skills.js`
- `packages/skills/src/commands/sync.js`

## Edge cases

- Missing `invocation`: resolve to `model`, including older and third-party skills.
- Exact values only: reject different casing, booleans, arrays, empty values, and unknown
  strings.
- Invalid or missing YAML/frontmatter and an empty description retain their existing failures.
- `.skills/` shadow precedence in the packaged CLI remains unchanged; whichever source wins is
  copied byte-for-byte with its invocation metadata.
- A user-invoked skill remains installed in every configured harness so explicit use still
  works.
- Absent gitignored harness directories remain a supported skip in drift checks.
- CRLF/LF differences remain non-drift; semantic or byte changes remain drift.
- Description trimming must not remove the skill's purpose, explicit invocation cue, authority
  boundary, or stop condition.
- The historical 17/19 count must not be encoded in a test because the live skill set and
  descriptions have already changed.

## Security and reliability

No new trust boundary, network call, secret handling, or executable input is introduced.
Invocation is repository-authored metadata. Validation is a closed enum and invalid values fail
before projection, preventing an accidental or malicious scalar from silently changing
selection policy. Existing path-validation, safe skill names, shadow precedence, and
whole-directory copy behavior remain unchanged.

## Ambiguity policy

Use the `/dev` seven-dimension decision rubric. At 80% or greater confidence, choose the
smallest option consistent with this plan and record it in `decisions.md`. Below 80%, stop and
ask.

Always stop rather than infer when:

- another skill appears to need `invocation: user`;
- a harness requires a native, harness-specific metadata field;
- making projections honor the field would require filtering skills or changing router
  selection;
- a test implies adaptive-review or behavioral-evaluation changes.

Those are design changes beyond this lock, not implementation details.

## Out of scope

- Router, `INTENT_RULES`, route weights, dispatch bootstrap, or automatic hook redesign.
- Adaptive reviewer, live model evaluation, holdout thresholds, or description-improvement
  loops owned by `d362bd71`.
- New harness adapters or native per-harness invocation fields.
- New workflow stages, commands, config toggles, schemas, dependencies, or registries.
- Reclassifying skills beyond `ship`, `review`, and `rollback`.
- Broad wording cleanup of model-invoked skill descriptions.

## Planning graph record

- `plan.intent_capture`: skipped; satisfied by the approved issue, audit constraint, and stable
  release plan.
- `plan.parallel_research`: skipped; no new external API or dependency is involved, and the
  required codebase inspection was performed locally.
- `plan.parallel_critics`: skipped; the approved seam is narrow and the final lock adds no new
  architecture.
- `plan.synthesis`: skipped as a separate node; the approved artifacts already provide the
  synthesis used by this lock.
- `plan.final_lock`: completed; the plan and `tasks.md` were approved before implementation.
- Full baseline suite: skipped for this partial planning lock; the focused live context-cost
  baseline passed.

## Coordination evidence

- Claim ownership: `codex-wave-588` holds the live, unexpired lease.
- File collision check: no indexed conflict was found; the issue is not yet in the file index.
- Branch merge simulation: clean against `master`.
- Global merge ordering: advisory failed because the repository currently reports a dependency
  cycle; this lock did not mutate dependencies.
- Team verification: GitHub authentication passed, but the local identity is absent from
  `team-map.jsonl`; adding a team identity requires a separate user/team decision.
- Dependency ripple check: advisory tooling could not read this Kernel UUID and proposed no
  dependency mutation.
