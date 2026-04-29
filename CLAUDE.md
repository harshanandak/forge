# Project Instructions

Forge is a 7-stage TDD-first development workflow harness for AI coding agents (9 commands total, including utility stages).

**Package manager**: Bun (preferred for performance)

**Build commands**:

```bash
bun install      # Install dependencies
bun run dev      # Start development
bun run build    # Production build
bun test         # Run tests
```

---

## Workflow

> **IMPORTANT**: Read [AGENTS.md](AGENTS.md) using the Read tool at the start of every session to load the complete Forge 7-stage workflow, change classification, and detailed stage instructions. AGENTS.md is the single source of truth for the workflow.

---

## MCP Servers (Enhanced Capabilities)

This project uses MCP (Model Context Protocol) servers for enhanced capabilities. If your AI agent supports MCP, set up these servers:

**Available MCP servers:**

- **Context7**: Up-to-date library documentation and API reference
- **grep.app**: Search 1M+ GitHub repos for real-world code examples

**Setup for your agent:**

See [.mcp.json.example](.mcp.json.example) for configuration. Setup varies by agent:

- **Claude Code**: Copy `.mcp.json.example` to `.mcp.json` in project root
- **Cline**: Add MCP servers in VSCode settings (Extensions > Cline > MCP Servers)
- **Cursor**: Check Cursor Settings > MCP for setup
- **Your agent**: If MCP-capable, configure using the example file

See [docs/reference/TOOLCHAIN.md](docs/reference/TOOLCHAIN.md) for detailed MCP setup instructions.

---

## Toolchain

- **Beads** (recommended): Auto-installed during `bunx forge setup` - Git-backed issue tracking
- **GitHub CLI**: `gh auth login` - PR workflow

Setup prompts for Beads during interactive installation. Manual install: see [docs/reference/TOOLCHAIN.md](docs/reference/TOOLCHAIN.md).

### Shell Model

Forge commands and repo scripts assume the following shell model:

| Platform | Shell used by Forge commands and scripts |
| --- | --- |
| Windows | Git Bash for helper-backed Forge stage flows |
| macOS/Linux | Default login shell |

On Windows, Forge runtime health enforces Git Bash for helper-backed stage flows. Native PowerShell is still used by some bootstrap paths, and WSL may be useful for adjacent development tasks. See [docs/TOOLCHAIN.md](docs/reference/TOOLCHAIN.md#shell-model) for details.

---

## Git Workflow

This project uses the **Professional Git Workflow** with Lefthook for automated quality gates:

**Pre-commit hooks** (automatic):
- TDD enforcement: Source files must have corresponding tests
- Interactive prompts: Option to unstage, continue, or abort

**Pre-push hooks** (automatic):
- Branch protection: Blocks direct push to main/master
- ESLint check: Blocks on errors and warnings (strict mode, `--max-warnings 0`)
- Test suite: All tests must pass

**Pull Request workflow**:
- PR template auto-fills with standardized format
- Self-review checklist catches 80% of bugs before review
- Beads integration: Reference issues with `Closes beads-xxx`
- **All review comments must be resolved** before merge
- Squash-only merging: Clean, linear git history

**Emergency bypass** (human-only, NEVER for AI agents):
```bash
LEFTHOOK=0 git push              # Skip all pre-push hooks
git commit --no-verify           # Skip pre-commit hooks
```

**⚠️ AI agents must NEVER use `LEFTHOOK=0`, `--no-verify`, or any hook bypass.** If a hook fails, fix the underlying issue. Only humans may bypass hooks in emergencies, documented in the PR description.

**Preferred push workflow** (for AI agents and humans):
```bash
forge push              # Runs branch protection + lint + tests, then pushes
forge push --quick      # Review-cycle: lint-only push (CI runs full suite)
forge worktree create <slug>  # Creates worktree with Beads integration
forge test              # Runs tests with correct timeouts + Beads skip
forge sync              # Syncs Beads data (dolt pull + push)
forge clean             # Removes merged worktrees (stops Dolt servers)
```

See [.github/pull_request_template.md](.github/pull_request_template.md) for PR guidelines.

---

<!-- USER:START - Add project-specific learnings here as you work -->

💡 **Keep this section focused** - Add patterns you discover while working.

As you work, when you give the same instruction twice, add it here:

- **Scope discipline**: Do ONLY what was explicitly asked. Answer a question → stop. Check something → stop. Never auto-continue to next steps or pending work unless told to.
- **Stage names**: The validation stage is `/validate` (not `/check`) — renamed in PR #50.
- **Unused params**: Prefix with `_` (e.g., `_searchTerm`) — ESLint `no-unused-vars` enforced with `--max-warnings 0`.
- **Pre-push test env**: `test-env/` fixture tests can fail during actual `git push` due to git mid-push state. Fix the root cause — never use `LEFTHOOK=0`.
- **Command sync**: After editing `.claude/commands/*.md`, run `node scripts/sync-commands.js` to update all 7 agent directories. Use `--check` in CI to detect drift. Use `--dry-run` to preview.
- **Dynamic commands**: Never hardcode example output in command files (`.claude/commands/*.md`) when a script generates that output dynamically. Command files should reference the script and describe what it does — not duplicate its output with fake data that becomes stale.
- **Review follow-up completion**: After fixing review feedback, always push the changes and resolve the related GitHub review threads via the GraphQL API before considering the work complete.

<!-- USER:END -->
