# Workflow Templates

Forge's workflow is a core product surface, not a side note. The default template gives agents a known path for planning, development, validation, shipping, review, premerge handoff, and post-merge verification.

## Default Template

The full default template is:

```text
/plan -> /dev -> /validate -> /ship -> /review -> /premerge -> /verify
```

Projects can use the full template or smaller profile-specific paths. The important boundary is that these are agent workflow stages, not necessarily standalone `forge <stage>` CLI commands.

## Why It Matters

The template gives AI-assisted work a repeatable operating model:

- `/plan` captures intent, research, branch/worktree setup, and tasks.
- `/dev` implements through a TDD-oriented loop.
- `/validate` gathers evidence from project checks.
- `/ship` prepares a reviewable PR.
- `/review` handles PR feedback and evaluator findings.
- `/premerge` finishes documentation and handoff context.
- `/verify` proves post-merge health when the workflow type requires it.

The value is not the exact number of stages. The value is recoverable state, known handoff points, validation evidence, and clear ownership while agents work.

## Customization Model

Forge treats the default workflow as a configurable template over runtime building blocks:

- stages can be skipped or shortened by workflow type,
- project setup can choose different harness targets,
- `.forge/config.yaml` records adoption profile and harness choices,
- `forge options lint`, `forge options diff`, and `forge options stages` inspect the resolved config,
- future work can add or replace stages through skills, adapters, and extension manifests.

Customization should stay explicit. Do not silently remove validation, review, or state handoff steps from high-risk work.

## Workflow Types

Current docs describe these profiles:

| Type | Intended use | Typical path |
| --- | --- | --- |
| Critical | Security, auth, payments, migrations, breaking changes | Full template |
| Standard | Normal features and enhancements | Plan through premerge |
| Simple | Small fixes and focused changes | Shorter dev, validate, ship path |
| Hotfix | Production emergencies | Short path with urgent validation |
| Docs | Documentation-only changes | Verify, ship, premerge where configured |
| Refactor | Behavior-preserving cleanup | Plan, dev, validate, ship, premerge |

Profile docs must be checked against `lib/workflow-profiles.js` and `AGENTS.md` before release because command files, skills, and runtime profiles can drift.

## Skills Direction

Forge is moving toward skills as the portable agent-facing package format. Current v0.0.11 packaging still includes command projections for several agents, and Codex already receives stage workflows as `.codex/skills/<stage>/SKILL.md`.

See [Skills and command projections](../reference/SKILLS.md) for the current source-of-truth boundary.

## Live Feature Rollout

When a planned feature becomes real, update docs in this order:

1. Verify the code, tests, package contents, and CLI output.
2. Move the feature from roadmap or experimental docs into ready-now docs.
3. Update README, Quickstart, this guide, and the relevant reference page.
4. Add migration or support notes if the feature changes setup, state, validation, or workflow behavior.
5. Refresh DeepWiki after merge and record the generated index date and commit.

Do not document future workflow customization as ready-now until the command, skill, or runtime surface exists and has validation evidence.

