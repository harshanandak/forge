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

## Forge Workflow

This project uses the **Forge 9-stage TDD workflow**:

| Stage | Command     | Purpose                                      |
|-------|-------------|----------------------------------------------|
| 1     | `/status`   | Check current context, active work           |
| 2     | `/research` | Research with web search, document findings  |
| 3     | `/plan`     | Create implementation plan, branch, OpenSpec |
| 4     | `/dev`      | TDD development (RED-GREEN-REFACTOR)         |
| 5     | `/check`    | Validation (type/lint/security/tests)        |
| 6     | `/ship`     | Create PR with documentation                 |
| 7     | `/review`   | Address ALL PR feedback                      |
| 8     | `/premerge` | Complete docs on feature branch, hand off PR |
| 9     | `/verify`   | Post-merge health check (CI, deployments)    |

**Flow**: `/status` → `/research` → `/plan` → `/dev` → `/check` → `/ship` → `/review` → `/premerge` → `/verify`

See [docs/WORKFLOW.md](docs/WORKFLOW.md) for complete workflow guide.

---

## Core Principles

- **TDD-First**: Write tests BEFORE implementation (RED-GREEN-REFACTOR)
- **Research-First**: Understand before building, document decisions
- **Security Built-In**: OWASP Top 10 analysis for every feature
- **Documentation Progressive**: Update at each stage, verify at end

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

**Agent instructions:**

```text
If you support MCP and don't have these servers configured:
1. Read .mcp.json.example to see the configuration
2. Set up Context7 and grep.app based on your MCP implementation
3. Verify by testing: "Search grep.app for React hooks examples"
```

See [docs/TOOLCHAIN.md](docs/TOOLCHAIN.md) for detailed MCP setup instructions.

---

## Multi-Agent Support

Forge now supports **5 Tier 1 agents** with universal AGENTS.md configuration:

**Tier 1 (Primary Support)**:
- ✅ **Claude Code** - Native custom slash commands, .claude/ directory
- ✅ **GitHub Copilot** - Enterprise adoption, .github/copilot-instructions.md
- ✅ **Kilo Code** - Managed indexing, auto failure recovery, .kilo.md
- ✅ **Cursor** - IDE-first, .cursor/rules/ with native modes
- ✅ **Aider** - Terminal-native, git-integrated, .aider.conf.yml

**Tier 2 (Optional Support)**:
- ⚠️ **OpenCode** (Anomaly fork) - opencode.json + AGENTS.md
- ⚠️ **Goose** - Model flexibility, open-source
- ⚠️ **Antigravity** - Google-backed, early preview

**Universal AGENTS.md**:
- Works with ALL agents (100% compatibility)
- Single source of truth for Forge workflow
- No agent-specific setup required
- Agent-specific configs are optional enhancements

**Migration from CLAUDE.md-only**:

If you're using Claude Code exclusively, no migration needed. To enable cross-agent support:

```bash
# Option 1: Generate AGENTS.md + agent-specific configs
bunx forge setup --all

# Option 2: Generate for specific agent
bunx forge setup --agent=copilot    # GitHub Copilot
bunx forge setup --agent=cursor     # Cursor IDE
bunx forge setup --agent=kilo       # Kilo Code
bunx forge setup --agent=aider      # Aider

# Option 3: Keep CLAUDE.md (Claude Code only)
# No action needed - existing setup works
```

**What gets created**:
- `AGENTS.md` - Universal workflow (all agents)
- `.github/copilot-instructions.md` - Copilot-specific (optional)
- `.cursor/rules/*.mdc` - Cursor-specific (optional)
- `.kilo.md` - Kilo-specific (optional)
- `.aider.conf.yml` - Aider-specific (optional)
- `opencode.json` - OpenCode-specific (optional)

**Benefits**:
- Switch agents anytime without reconfiguration
- Team members can use their preferred agent
- Consistent workflow across all agents
- Optional enhancements for agent-specific features

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for how Commands, Skills, and MCP work together.

---

## Quick Start

1. `/status` - Check where you are
2. `/research <feature-name>` - Research the feature
3. `/plan <feature-slug>` - Create formal plan
4. `/dev` - Implement with TDD
5. `/check` - Validate everything
6. `/ship` - Create PR

---

## Toolchain

- **Beads** (recommended): Auto-installed during `bunx forge setup` - Git-backed issue tracking
- **OpenSpec** (optional): Auto-installed during `bunx forge setup` - Spec-driven development
- **GitHub CLI**: `gh auth login` - PR workflow

Setup prompts for Beads/OpenSpec during interactive installation. Manual install: see [docs/TOOLCHAIN.md](docs/TOOLCHAIN.md).

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

- Coding style preferences
- Architecture decisions
- Domain concepts unique to this project

<!-- USER:END -->
