# Forge Workflow — Google Antigravity

> **IMPORTANT**: Read [AGENTS.md](AGENTS.md) using the Read tool at the start of every session to load the complete Forge 7-stage workflow, change classification, and detailed stage instructions. AGENTS.md is the single source of truth for the workflow.

---

## Quick Reference

| Stage | Command     | Purpose                                                   |
|-------|-------------|-----------------------------------------------------------|
| utility | `/status` | Check current context, active work                      |
| 1     | `/plan`     | Design intent → research → branch + worktree + task list |
| 2     | `/dev`      | Subagent-driven TDD per task (spec + quality review)     |
| 3     | `/check`    | Validation (type/lint/security/tests)                    |
| 4     | `/ship`     | Create PR with documentation                             |
| 5     | `/review`   | Address ALL PR feedback                                  |
| 6     | `/premerge` | Complete docs, hand off PR to user                       |
| 7     | `/verify`   | Post-merge health check                                  |

See [AGENTS.md](AGENTS.md) for full details on every stage.
