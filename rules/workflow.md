---
description: "When working with Forge workflow commands"
alwaysApply: true
globs: []
---

# Forge TDD Workflow Template

TDD-first workflow. This rule is a **thin pointer** — the authoritative contract
lives in `AGENTS.md`, and each stage's detailed steps live in its skill
(`skills/<stage>/SKILL.md`). Do not duplicate policy here.

Stages: `/plan` → `/dev` → `/validate` → `/ship` → `/review` → `/verify`
(pre-merge gate before merge). `/status` and `/shepherd` are utilities, not stages.

- `/plan` — design intent → research → branch + worktree + task list
- `/dev` — subagent-driven TDD per task (RED → GREEN → REFACTOR)
- `/validate` — type check, lint, tests, security (HARD-GATE on exit)
- `/ship` — push and open a PR referencing the design doc
- `/review` — resolve ALL PR feedback (CI, Greptile, SonarCloud)
- `/verify` — post-merge health check on the default branch

> **Pre-merge gate** (not a numbered stage): finish docs on the branch, confirm CI
> is green, hand off the PR. Embedded in `/ship` and `/review`, not a command.

Load the matching stage skill for the full procedure. Default stack: `bun` test
runner, Git conventional commits, OWASP-aware. See `AGENTS.md` for the rest.
