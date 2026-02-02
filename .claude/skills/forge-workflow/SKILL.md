---
name: forge-workflow
description: 9-stage TDD-first workflow for feature development. Use when building features, fixing bugs, or shipping PRs.
category: Development Workflow
tags: [tdd, workflow, pr, git, testing]
tools: [Bash, Read, Write, Edit, Grep, Glob]
---

# Forge Workflow Skill

A TDD-first workflow for AI coding agents. Ship features with confidence.

## When to Use

Automatically invoke this skill when the user wants to:

- Build a new feature
- Fix a bug
- Create a pull request
- Run the development workflow

## 9 Stages

| Stage | Command | Description |
| ----- | ------- | ----------- |
| 1 | `/status` | Check current context, active work, recent completions |
| 2 | `/research` | Deep research with web search, document to docs/research/ |
| 3 | `/plan` | Create implementation plan, branch, OpenSpec if strategic |
| 4 | `/dev` | TDD development (RED-GREEN-REFACTOR cycles) |
| 5 | `/check` | Validation (type/lint/security/tests) |
| 6 | `/ship` | Create PR with full documentation |
| 7 | `/review` | Address ALL PR feedback |
| 8 | `/merge` | Update docs, merge PR, cleanup |
| 9 | `/verify` | Final documentation verification |

## Workflow Flow

```text
/status -> /research -> /plan -> /dev -> /check -> /ship -> /review -> /merge -> /verify
```

## Core Principles

- **TDD-First**: Write tests BEFORE implementation (RED-GREEN-REFACTOR)
- **Research-First**: Understand before building, document decisions
- **Security Built-In**: OWASP Top 10 analysis for every feature
- **Documentation Progressive**: Update at each stage, verify at end
