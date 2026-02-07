# @forge/skills

Universal CLI tool for managing SKILL.md files across all AI agents.

## Installation

```bash
npm install -g @forge/skills
```

## Usage

```bash
# Initialize skills registry
skills init

# Create a skill from template
skills create my-skill
skills create my-skill --template=research

# List all skills
skills list
skills list --category=research

# Sync skills to agent directories
skills sync
skills sync --preserve-agents

# Remove a skill
skills remove my-skill
skills remove my-skill --force

# Validate SKILL.md
skills validate .skills/my-skill/SKILL.md

# Install from Vercel registry
skills add awesome-skill

# Publish to Vercel registry
skills publish my-skill

# Search registry
skills search react
```

## Features

- **Template-based creation**: 5 built-in templates (research, coding, review, testing, deployment)
- **Multi-agent sync**: Sync to .cursor/skills/, .claude/skills/, .github/skills/
- **Vercel registry**: Publish and install skills from central marketplace
- **AGENTS.md integration**: Auto-generate AGENTS.md from skills
- **Validation**: YAML frontmatter + Markdown linting
- **Cross-platform**: Windows, macOS, Linux

## Documentation

See [openspec/changes/skills-cli/](../../openspec/changes/skills-cli/) for complete proposal and design docs.

## Development

```bash
# Install dependencies
bun install

# Run tests
bun test

# Test CLI locally
node bin/skills.js --help
```

## License

MIT
