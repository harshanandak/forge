# Skills CLI

Universal CLI tool for managing SKILL.md files across all AI agents.

**Make skills discoverable, shareable, and manageable across Claude Code, Cursor, GitHub Copilot, and 20+ other agents through a single CLI interface.**

---

## 📋 Table of Contents

- [Why Skills CLI?](#why-skills-cli)
- [Installation](#installation)
- [Quick Start](#quick-start)
- [Commands](#commands)
- [Project Structure](#project-structure)
- [Integration with Forge](#integration-with-forge)
- [Security](#security)
- [Contributing](#contributing)

---

## Why Skills CLI?

### The Problem

AI agents (Claude Code, Cursor, Cline, Continue) each have their own skill management:
- **No central source of truth** - Skills scattered across `.cursor/`, `.github/`, `.claude/`
- **Manual duplication** - Copy SKILL.md files between agent directories
- **No discoverability** - Hard to find and reuse skills
- **Format inconsistency** - Each agent may use different formats

### The Solution

**Skills CLI** provides a universal interface for SKILL.md management:

✅ **Single source of truth** - All skills in `.skills/` directory
✅ **Auto-sync to agents** - One command syncs to all agents
✅ **Template-based creation** - 5 built-in templates (research, coding, review, testing, deployment)
✅ **Registry management** - Track all skills with metadata
✅ **Format validation** - Ensure SKILL.md follows standards
✅ **Forge integration** - Works seamlessly with Forge workflow

---

## Installation

### Global (Recommended)

```bash
bun add -g @forge/skills
# or
npm install -g @forge/skills
```

### Local (Project-specific)

```bash
bun add -d @forge/skills
# or
npm install --save-dev @forge/skills
```

### Via Bunx (No installation)

```bash
bunx @forge/skills <command>
```

---

## Quick Start

### 1. Initialize

Create `.skills/` directory and registry:

```bash
skills init
```

This creates:
- `.skills/` - Skills directory (source of truth)
- `.skills/.registry.json` - Skill catalog

### 2. Create a Skill

Interactive creation with templates:

```bash
skills create my-research-skill
```

Or use a specific template:

```bash
skills create my-skill --template=research
```

**Available templates:**
- `default` - General-purpose skill
- `research` - Web search, data extraction, analysis
- `coding` - Code generation, refactoring, debugging
- `review` - Code review, quality checks, testing
- `testing` - Test generation, TDD workflows
- `deployment` - CI/CD, deployment, infrastructure

### 3. List Skills

View all installed skills:

```bash
skills list
```

Output:
```
my-research-skill (research)
  Web research and data extraction
  Author: Your Name | Created: 2026-02-07
```

### 4. Sync to Agents

Synchronize skills to all detected agents:

```bash
skills sync
```

This copies skills from `.skills/` to:
- `.cursor/skills/` (Cursor)
- `.github/skills/` (GitHub Copilot)
- `.claude/skills/` (Claude Code)
- And more...

### 5. Validate

Check SKILL.md format and content:

```bash
skills validate my-skill
```

Validates:
- YAML frontmatter syntax
- Required fields (title, description, category)
- Category values
- Markdown structure

---

## Commands

### `skills init`

Initialize skills registry in current project.

```bash
skills init
```

Creates:
- `.skills/` directory
- `.skills/.registry.json` (skill catalog)

### `skills create <name>`

Create new skill from template.

```bash
skills create my-skill [--template=<type>]
```

**Options:**
- `--template=<type>` - Template to use (default, research, coding, review, testing, deployment)
- `--no-sync` - Skip auto-sync to agents

**Examples:**
```bash
# Interactive creation (prompts for metadata)
skills create my-skill

# Use specific template
skills create my-skill --template=research

# Create without syncing
skills create my-skill --no-sync
```

### `skills list`

Show all installed skills.

```bash
skills list
```

Displays:
- Skill name and category
- Description
- Author and timestamps

### `skills sync`

Synchronize skills to agent directories.

```bash
skills sync [--preserve-agents]
```

**Options:**
- `--preserve-agents` - Skip AGENTS.md update

**Behavior:**
- Copies from `.skills/` to agent directories
- Updates `.registry.json` with sync timestamp
- Auto-generates AGENTS.md (unless `--preserve-agents`)
- Creates `.agents.md.backup` before overwriting

### `skills validate <name>`

Validate SKILL.md format and content.

```bash
skills validate <name>
```

**Checks:**
- YAML frontmatter present and valid
- Required fields: title, description, category
- Category in allowed list
- Markdown structure

**Example:**
```bash
skills validate my-skill
# Output: ✓ Valid skill
#   Title: My Skill
#   Category: research
```

### `skills remove <name>`

Remove skill from `.skills/` and agent directories.

```bash
skills remove <name>
```

**Behavior:**
- Deletes from `.skills/<name>/`
- Removes from `.registry.json`
- Cleans up all agent directories
- Shows which agents were cleaned

---

## Project Structure

```
.
├── .skills/                  # Canonical source (managed by skills CLI)
│   ├── .registry.json        # Skill catalog
│   ├── my-skill/
│   │   ├── SKILL.md          # Skill content (YAML + Markdown)
│   │   └── .skill-meta.json  # Metadata (timestamps, usage)
│   └── another-skill/
│       ├── SKILL.md
│       └── .skill-meta.json
├── .cursor/skills/           # Synced to Cursor (copy)
│   ├── my-skill/
│   └── another-skill/
├── .github/skills/           # Synced to GitHub (copy)
│   ├── my-skill/
│   └── another-skill/
└── AGENTS.md                 # Auto-generated skill index
```

**Workflow:**
1. **Create**: `skills create my-skill` → creates in `.skills/my-skill/`
2. **Sync**: `skills sync` → copies to `.cursor/skills/`, `.github/skills/`, etc.
3. **Update**: Edit `.skills/my-skill/SKILL.md` → `skills sync` to propagate

---

## SKILL.md Format

Skills use YAML frontmatter + Markdown:

```markdown
---
title: Skill Title
description: Short description
category: research|coding|review|testing|deployment
version: 1.0.0
author: Your Name
created: 2026-02-07
updated: 2026-02-07
tags:
  - web-search
  - data-extraction
---

# Skill Name

## Purpose

What this skill helps accomplish.

## When to Use

- User asks for X
- You need to Y

## Instructions

1. First, do this...
2. Then, analyze...
3. Finally, present...

## Examples

### Example 1: Use Case
\`\`\`
Input: User request
Output: Expected result
\`\`\`

## Success Criteria

- [ ] Criterion 1
- [ ] Criterion 2
```

---

## Integration with Forge

Skills CLI is integrated into the Forge workflow:

### Installation via Forge Setup

```bash
npx forge setup
# Prompts for Skills installation and initialization
```

### Status Display

```bash
npx forge status
```

Shows:
```
Project Tools Status:
  ✓ Beads initialized - Track work: bd ready
  ✓ OpenSpec initialized - Specs in openspec/
  ✓ Skills initialized - Manage skills: skills list
```

### Auto-Setup (Quick Mode)

```bash
npx forge setup --quick
# Auto-initializes Skills if already installed
```

---

## Security

Skills CLI implements comprehensive security:

### Path Traversal Prevention

✅ Input validation with regex whitelist
✅ Path canonicalization checks
✅ Defense-in-depth validation layers

### YAML Injection Prevention

✅ Safe YAML schema (JSON types only)
✅ No custom type constructors

### Input Validation

✅ Type checking
✅ Length limits (100 chars max)
✅ Character whitelist (lowercase, numbers, hyphens, underscores)

**Security Score**: 9/10 (OWASP Top 10 compliant)

See [SECURITY.md](SECURITY.md) for full audit.

---

## Agent Support

**Fully Supported:**
- ✅ Cursor (`.cursor/skills/`)
- ✅ GitHub Copilot (`.github/skills/`)
- ✅ Claude Code (`.claude/skills/`)

**Detected (can be enabled in config):**
- Cline (`.cline/skills/`)
- Continue (`.continue/skills/`)

---

## Examples

### Example 1: Create Research Skill

```bash
# Create skill
skills create web-research --template=research

# Edit SKILL.md
code .skills/web-research/SKILL.md

# Sync to agents
skills sync

# Validate
skills validate web-research
```

### Example 2: Manage Multiple Skills

```bash
# Create multiple skills
skills create bug-fix --template=coding
skills create pr-review --template=review
skills create e2e-tests --template=testing

# List all
skills list

# Sync all
skills sync

# Remove one
skills remove e2e-tests
```

### Example 3: Preserve AGENTS.md

```bash
# Sync without updating AGENTS.md
skills sync --preserve-agents

# Or configure permanently in .skills/.registry.json:
# "config": { "preserveAgentsMd": true }
```

---

## Troubleshooting

### "Skills registry not found"

**Solution:** Run `skills init` first.

### "Skill already exists"

**Solution:** Choose different name or remove existing skill.

### "YAML parse error"

**Solution:** Check SKILL.md frontmatter syntax. Must start with `---` and end with `---`.

### "Invalid category"

**Solution:** Use one of: research, coding, review, testing, deployment.

### Skills not appearing in agent

**Solution:**
1. Check agent is detected with enabled agents display
2. Run `skills sync` to propagate changes
3. Restart your AI agent/IDE

---

## Development

### Run Tests

```bash
cd packages/skills
bun test
```

### Coverage

94 tests passing with comprehensive security coverage:
- 21 security-specific tests
- Path traversal prevention
- Input validation
- YAML injection prevention

---

## Roadmap

### v1.0 (Current)

✅ Template-based skill creation
✅ Multi-agent synchronization
✅ Format validation
✅ Forge integration
✅ Security hardening

### v1.1 (Future)

- [ ] AI-powered skill creation
- [ ] Skill refinement assistant
- [ ] Usage analytics
- [ ] Skill dependencies

### v2.0 (Future)

- [ ] Vercel registry integration (publish/install)
- [ ] Skill versioning and updates
- [ ] Community marketplace
- [ ] Skill ratings and reviews

---

## Contributing

See [CONTRIBUTING.md](../../CONTRIBUTING.md) for guidelines.

---

## License

MIT © Forge Team

---

## Links

- **Repository**: https://github.com/harshanandak/forge
- **Documentation**: See [SECURITY.md](SECURITY.md) for security audit

---

## Credits

Built with ❤️ by the Forge team using TDD and security-first development.
