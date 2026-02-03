# Developing Forge

> This file is NOT distributed to users.

## Quick Start

1. Clone: `git clone https://github.com/harshanandak/forge`
2. Install: `npm install`
3. Use Forge to develop Forge: `/status` → `/plan` → `/dev`

## Meta-Development Mode

This project IS the Forge workflow. We use Forge to develop Forge (dogfooding).

**When improving the workflow itself:**
- Branch: `meta/*` or `workflow/*`
- Issue: "meta: Improve /plan command"

**When adding Forge features:**
- Branch: `feat/*`, `fix/*`, `docs/*`
- Issue: "feat: Add version check"

## Key Directories

| Directory | Purpose |
|-----------|---------|
| `lib/agents/` | Agent plugins ([README](lib/agents/README.md)) |
| `.forge/hooks/` | TDD enforcement |
| `.claude/commands/` | Workflow commands |
| `.claude/skills/` | Workflow skills |
| `bin/` | CLI entry points |

## TDD Enforcement

Pre-commit hook (`.forge/hooks/check-tdd.js`) checks for tests.
- Source files need corresponding test files
- Use `--no-verify` only in emergencies

## Project Structure

```
forge/
├── bin/                    # CLI scripts (forge.js, forge-validate.js)
├── lib/
│   └── agents/             # Plugin definitions (*.plugin.json)
├── .claude/
│   ├── commands/           # Workflow commands (/status, /plan, etc.)
│   ├── rules/              # Workflow rules
│   ├── skills/             # Skills (parallel-ai, sonarcloud)
│   └── scripts/            # Helper scripts
├── .forge/
│   └── hooks/              # Git hooks (TDD enforcement)
├── docs/                   # Documentation
├── AGENTS.md               # Universal workflow guide
├── CLAUDE.md               # Claude Code specific guide
└── package.json            # npm package config
```

## More Info

- [.github/CONTRIBUTING.md](.github/CONTRIBUTING.md) - Detailed contributor guide
- [lib/agents/README.md](lib/agents/README.md) - Plugin development
- [docs/WORKFLOW.md](docs/WORKFLOW.md) - Complete workflow guide
