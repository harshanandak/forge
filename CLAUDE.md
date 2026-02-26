# Project Instructions

This is a [describe what this project does in one sentence].

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
- **Continue**: Add to `.continue/config.json` under `mcpServers`
- **Cursor**: Check Cursor Settings > MCP for setup
- **Your agent**: If MCP-capable, configure using the example file

See [docs/TOOLCHAIN.md](docs/TOOLCHAIN.md) for detailed MCP setup instructions.

---

## Toolchain

- **Beads** (recommended): Auto-installed during `bunx forge setup` - Git-backed issue tracking
- **GitHub CLI**: `gh auth login` - PR workflow

Setup prompts for Beads during interactive installation. Manual install: see [docs/TOOLCHAIN.md](docs/TOOLCHAIN.md).

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

**Emergency bypass**:
```bash
LEFTHOOK=0 git push              # Skip all pre-push hooks
git commit --no-verify           # Skip pre-commit hooks
```

**⚠️ Only use bypasses for emergencies.** Document reason in PR description.

See [.github/pull_request_template.md](.github/pull_request_template.md) for PR guidelines.

---

<!-- USER:START - Add project-specific learnings here as you work -->

💡 **Keep this section focused** - Add patterns you discover while working.

As you work, when you give the same instruction twice, add it here:

- **Scope discipline**: Do ONLY what was explicitly asked. Answer a question → stop. Check something → stop. Never auto-continue to next steps or pending work unless told to.
- Coding style preferences
- Architecture decisions
- Domain concepts unique to this project

<!-- USER:END -->
