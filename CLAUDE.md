# Claude Code - Project Instructions

This is a [describe what this project does in one sentence].

**Package manager**: npm (or specify: pnpm/yarn/bun)

**Build commands**:

```bash
npm install      # Install dependencies
npm run dev      # Start development
npm run build    # Production build
npm test         # Run tests
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
| 8     | `/merge`    | Update docs, merge PR, cleanup               |
| 9     | `/verify`   | Final documentation verification             |

**Flow**: `/status` → `/research` → `/plan` → `/dev` → `/check` → `/ship` → `/review` → `/merge` → `/verify`

See [docs/WORKFLOW.md](docs/WORKFLOW.md) for complete workflow guide.

---

## Core Principles

- **TDD-First**: Write tests BEFORE implementation (RED-GREEN-REFACTOR)
- **Research-First**: Understand before building, document decisions
- **Security Built-In**: OWASP Top 10 analysis for every feature
- **Documentation Progressive**: Update at each stage, verify at end

---

## MCP Servers

This project uses MCP servers for enhanced capabilities. Copy [.mcp.json.example](.mcp.json.example) to `.mcp.json`:

```json
{
  "mcpServers": {
    "context7": {
      "command": "npx",
      "args": ["-y", "@upstash/context7-mcp@latest"]
    },
    "grep-app": {
      "command": "npx",
      "args": ["-y", "@ai-tools-all/grep_app_mcp"]
    }
  }
}
```

**Available MCP servers**:

- **Context7**: Up-to-date library documentation and API reference
- **grep.app**: Search 1M+ GitHub repos for real-world code examples

See [docs/TOOLCHAIN.md](docs/TOOLCHAIN.md) for complete setup instructions.

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

- **Beads** (recommended): `npm i -g @beads/bd && bd init` - Git-backed issue tracking
- **OpenSpec** (optional): `npm i -g @fission-ai/openspec && openspec init` - Spec-driven development
- **GitHub CLI**: `gh auth login` - PR workflow

See [docs/TOOLCHAIN.md](docs/TOOLCHAIN.md) for comprehensive tool reference.

---

<!-- USER:START - Add project-specific learnings here as you work -->

💡 **Keep this section focused** - Add patterns you discover while working.

As you work, when you give the same instruction twice, add it here:

- Coding style preferences
- Architecture decisions
- Domain concepts unique to this project

<!-- USER:END -->
