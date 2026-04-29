# Superseded archived research

This directory holds research docs whose conclusions have been superseded by later
work. They are kept for historical context — do not treat them as current guidance.

| File | Superseded by | Why |
|---|---|---|
| `forge-workflow-v2.md` | `docs/work/2026-04-28-skeleton-pivot/v3-redesign-strategy.md` and `v3-skeleton-plan.md` | The v2 7-stage refactor described here is the *starting point* for the v3 pivot. v3 reframes the workflow as a layered skeleton; the v2 design lives on as the L2 default. |
| `plugin-architecture.md` | `docs/work/2026-04-28-skeleton-pivot/extension-system.md` and `skill-distribution.md` | "Universal toolchain recommender" framing replaced by L2 extension system + curated `forge-marketplace.json`. |
| `advanced-testing.md` | `docs/work/2026-04-28-skeleton-pivot/v3-skeleton-plan.md` (Wave 4 eval infra) | Mutation testing / test-quality dashboard work is folded into Wave 4 eval infrastructure under the v3 skeleton. |
| `skills-restructure.md` | `docs/work/2026-04-28-skeleton-pivot/skill-distribution.md` and `skill-generation.md` | Old skills layout for the npm-package era; v3 distributes skills via the marketplace allowlist and generates them from observed work. |
| `premerge-verify-restructure.md` | The current `/premerge` and `/verify` stages | The restructure described here shipped; this is the design doc, not current behavior. |
| `sonarcloud-perfection-plan.md` | The shipped SonarCloud quality-gate fixes | Point-in-time complexity-reduction plan; the work landed and the file no longer reflects a current goal. |
| `sonarcloud-quality-gate.md` | The shipped SonarCloud quality-gate fixes | Point-in-time Phase-2 cognitive-complexity plan; superseded by the merged fixes. |

Files moved out of this archive into `docs/reference/` (still current, not superseded):

- `dependency-chain.md` → `docs/reference/dependency-chain.md`
- `agent-permissions.md` → `docs/reference/agent-permissions.md`
- `test-environment.md` → `docs/reference/test-environment.md`
- `superpowers.md` → `docs/reference/superpowers-analysis.md`
- `superpowers-integration.md` → `docs/reference/superpowers-integration-options.md`
