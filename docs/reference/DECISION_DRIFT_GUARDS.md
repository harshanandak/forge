# Decision Drift Guards

**Status**: Planning reference for the Forge Kernel authority reset.
**Canonical decision log**: [Locked decisions](../work/2026-04-28-skeleton-pivot/locked-decisions.md).

## Purpose

Forge has moved from a Beads/Dolt-centered plan to a Forge Kernel authority plan. This document defines the checks that keep future PRs from accidentally drifting back to the old architecture.

## Non-Negotiable Rules

1. Forge Kernel is the issue authority.
2. Beads is import/export compatibility only.
3. Local mode uses local SQLite WAL broker authority.
4. Team mode requires server authority.
5. GitHub/Linear are projections only.
6. Harness files are generated projections only.
7. Skills, MCPs, agents, commands, hooks, scripts, docs/context packs, and extensions are capability providers.
8. Users configure provider/stage bindings; Forge validates and records them.
9. Conflicts are quarantined in Forge before projection.
10. Raw prompts/tool logs remain local-only by default.

## Required Doc Updates

Any PR changing authority, storage, workflow config, provider loading, issue commands, team sync, Beads migration, or external projections must update:

- [forge-kernel-authority-control-plane.md](../work/2026-04-28-skeleton-pivot/forge-kernel-authority-control-plane.md)
- [locked-decisions.md](../work/2026-04-28-skeleton-pivot/locked-decisions.md)
- [release-plan.md](../work/2026-04-28-skeleton-pivot/release-plan.md)
- [FORGE_KERNEL_STORAGE_MODEL.md](./FORGE_KERNEL_STORAGE_MODEL.md)
- the implementation-specific guide/reference doc for the changed surface

## Evaluator Checklist

Before a release PR can be considered ready, run or manually answer these checks:

```text
Authority:
  - Does any path make Beads, GitHub, Linear, D1, or a harness file authoritative?
  - Do issue commands write through Forge Kernel?

Storage:
  - Is each new field classified as authority, cache, projection, archive, or config?
  - Is local-only sensitive data protected from server upload by default?

Team mode:
  - Are claim/start/close/stage-transition writes blocked when server authority is unavailable?
  - Are stale/reclaimable states visible and auditable?

Providers:
  - Are external skills/MCPs/agents/commands/hooks declared as provider capabilities?
  - Are required providers validated before stage execution?
  - Are unknown providers prevented from becoming required without evidence/evaluator support?

Projections:
  - Does projection failure leave Forge Kernel state intact?
  - Are dead letters visible with repair actions?

Docs:
  - Did the PR update the authority plan, storage model, and release gates if behavior changed?
```

## Forbidden Drift Patterns

- Direct `.beads/issues.jsonl` reads as current state authority.
- `bd` commands as the canonical write path after Kernel command routing lands.
- GitHub or Linear webhook payloads overwriting Forge-owned fields.
- D1 reads deciding claims or lease state.
- Generated Claude/Cursor/Codex files being edited as source of truth.
- Required skills loaded by prompt discretion instead of WorkflowGraph policy.
- Silent projection failures.
- Fixed heartbeat spam as the main liveness signal.

## Release Gate

Each Kernel-era release must include a short evaluator note with:

```text
Authority score:
Storage score:
Provider/config score:
Projection score:
Security/privacy score:
Known drift risks:
```

Target score is 100/100. Anything below 100 needs a documented follow-up or a deliberate locked decision.
