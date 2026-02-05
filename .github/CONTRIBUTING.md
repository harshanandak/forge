# Contributing to Forge

Thank you for your interest in contributing to Forge!

## Development Setup

1. Clone: `git clone https://github.com/harshanandak/forge`
2. Install: `bun install`
3. Read: [DEVELOPMENT.md](../DEVELOPMENT.md) for quick start

## Branch Naming

| Prefix | Purpose | Example |
|--------|---------|---------|
| `meta/` | Workflow improvements | `meta/improve-plan-output` |
| `workflow/` | Principle changes | `workflow/add-security-stage` |
| `feat/` | CLI features | `feat/add-version-check` |
| `fix/` | Bug fixes | `fix/windows-path-handling` |
| `plugin/` | New agent plugins | `plugin/add-zed-support` |
| `docs/` | Documentation | `docs/update-examples` |

## Issue Tracking (Beads)

We use [Beads](https://github.com/beads-ai/bd) for issue tracking:

```bash
bd create --title "Your issue title" --type task
bd update <id> --status in_progress
bd close <id>
```

**Issue prefixes:**
- `meta:` - Workflow improvements
- `plugin:` - Agent plugin work
- `feat:` - New features
- `fix:` - Bug fixes

## Plugin Development

See [lib/agents/README.md](../lib/agents/README.md) for the complete guide.

Quick steps:
1. Create `lib/agents/your-agent.plugin.json`
2. Follow the schema in README
3. Test: `bunx forge setup --agents your-agent`
4. Submit PR

## TDD Requirements

Pre-commit hook enforces TDD:
- Source files need corresponding test files
- Use `--no-verify` only in emergencies
- See [.forge/hooks/check-tdd.js](../.forge/hooks/check-tdd.js)

## Pull Request Process

1. Fork the repo and create your branch (see naming above)
2. Make changes following branch naming conventions
3. Ensure tests pass and TDD hook is satisfied
4. Run `/check` to validate (type check, lint, tests, security)
5. Submit PR with clear description
6. Address review feedback

## Code Style

- Use Prettier for formatting
- Follow existing patterns in the codebase
- Add JSDoc comments for public functions
- Keep commits atomic (one change per commit)

## Commit Messages

Follow conventional commits:
```
type: short description

Longer description if needed.

Refs: #issue-number
```

Types: `feat`, `fix`, `docs`, `test`, `refactor`, `chore`

## Questions?

- Open an issue for bugs or feature requests
- Check existing issues before creating new ones
- Be respectful and constructive
