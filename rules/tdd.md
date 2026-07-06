---
description: "TDD patterns and enforcement"
alwaysApply: false
globs: ["**/*.ts", "**/*.js", "**/*.test.ts", "**/*.test.js"]
---

# TDD Enforcement

Thin pointer — the full TDD procedure lives in the `dev` skill
(`skills/dev/SKILL.md`) and `AGENTS.md`. Do not duplicate it here.

**RED → GREEN → REFACTOR** is mandatory. No implementation without a failing
test first:

- **RED** — write the failing test first; run it and see it fail for the right reason.
- **GREEN** — write the minimal code to pass; nothing beyond the test's scope.
- **REFACTOR** — clean up while keeping tests green; commit each phase.

Test behavior, not implementation. Cover edge cases, errors, and OWASP-relevant
inputs. Load the `dev` skill for the enforced HARD-GATE loop and decision gate.
