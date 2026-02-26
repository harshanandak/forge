---
description: Deep research with parallel-web-search, document findings
---

> **Note**: `/research` is now Phase 2 of `/plan`.
>
> The research phase has been absorbed into the `/plan` command, which runs a full 3-phase workflow:
> - **Phase 1**: Brainstorming — design intent, constraints, success criteria
> - **Phase 2**: Technical research — web search, OWASP, codebase exploration, TDD scenarios
> - **Phase 3**: Setup — branch, worktree, Beads issue, task list
>
> Run `/plan <feature-slug>` to start the complete planning workflow.

# Research (Legacy Alias)

This command previously ran a standalone research phase. It is now embedded in `/plan` as Phase 2.

## If you want to run just the research phase

Jump to Phase 2 of `/plan` manually:

1. Read or create the design doc at `docs/plans/YYYY-MM-DD-<slug>-design.md`
2. Run parallel web search using the `parallel-web-search` skill
3. Run OWASP Top 10 analysis for the feature
4. Use the Explore agent for codebase exploration
5. Identify at least 3 TDD test scenarios
6. Append findings under `## Technical Research` in the design doc

Then continue with `/plan <slug> --continue` to run Phase 3 (setup + task list).

## Integration with Workflow

```
Utility: /status     → Understand current context before starting
Stage 1: /plan       → Design intent → research → branch + worktree + task list
Stage 2: /dev        → Implement each task with subagent-driven TDD
Stage 3: /check      → Type check, lint, tests, security — all fresh output
Stage 4: /ship       → Push + create PR
Stage 5: /review     → Address GitHub Actions, Greptile, SonarCloud
Stage 6: /premerge   → Update docs, hand off PR to user
Stage 7: /verify     → Post-merge CI check on main
```
