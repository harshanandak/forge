const fs = require('node:fs');
const path = require('node:path');

const { renderRulesForHarness } = require('./rules-sync');
const { getPackageRoot } = require('./package-root');

// Forge package root — the canonical `rules/` manifest lives here and is the
// single source for every harness's native rule files. On-disk under npm/npx;
// resolved to the extracted embed dir inside a compiled binary via getPackageRoot.
const PACKAGE_ROOT = path.join(__dirname, '..');

/**
 * Generate universal AGENTS.md file that works with all supported AI agents
 * @param {string} projectPath - Path to the project root
 * @returns {Promise<void>}
 */
async function generateAgentsMd(projectPath, options = {}) {
  const agentsMdPath = path.join(projectPath, 'AGENTS.md');

  // Check overwrite protection
  if (!options.overwrite && fs.existsSync(agentsMdPath)) {
    // File exists and overwrite is false - skip
    return;
  }

  // Detect project metadata
  const projectMeta = options.projectMeta || await detectProjectMetadata(projectPath);

  // Generate AGENTS.md content
  const content = generateAgentsMdContent(projectMeta);

  // Write to file
  await fs.promises.writeFile(agentsMdPath, content, 'utf-8');
}

/**
 * Detect project metadata (language, framework, scripts)
 * @param {string} projectPath - Path to the project root
 * @returns {Promise<Object>}
 */
async function detectProjectMetadata(projectPath) {
  const meta = {
    name: 'project',
    language: null,
    framework: null,
    testCommand: 'npm test',
    buildCommand: 'npm run build'
  };

  // Try to read package.json
  try {
    const packageJsonPath = path.join(projectPath, 'package.json');
    const packageJson = JSON.parse(await fs.promises.readFile(packageJsonPath, 'utf-8'));

    meta.name = packageJson.name || 'project';

    // Detect TypeScript
    if (packageJson.dependencies?.typescript || packageJson.devDependencies?.typescript) {
      meta.language = 'TypeScript';
      meta.hasTypeScript = true;
    }

    // Detect test command
    if (packageJson.scripts?.test) {
      meta.testCommand = packageJson.scripts.test;
    }

    // Detect build command
    if (packageJson.scripts?.build) {
      meta.buildCommand = packageJson.scripts.build;
    }
  } catch (_error) {
    // package.json doesn't exist or is invalid, use defaults
  }

  return meta;
}

/**
 * Generate AGENTS.md content
 * @param {Object} meta - Project metadata
 * @returns {string} - AGENTS.md content
 */
function generateAgentsMdContent(meta) {
  return `# Forge Workflow Framework

This project uses the **Forge TDD Workflow Template** for development. The commands are composable building blocks, not a mandatory fixed ladder.

## Supported AI Agents

Forge currently supports Claude Code, Codex, and Cursor. Hermes support is planned.
- **Claude Code** - Native custom slash commands, skills
- **Codex** - OpenAI's CLI agent, skills-based workflow
- **Cursor** - IDE-integrated, native Plan/Ask/Debug modes

## Skill Dispatch (auto-trigger)

Before ANY response — including clarifying questions or exploring the codebase — if there is even a 1% chance a Forge skill applies, invoke it, then announce \`Using [skill] to [purpose]\`. Invoke the \`using-forge\` dispatch skill (auto-discovered from your agent's own skills — Forge setup installs it into each harness's skills dir; it carries the 1%-rule and routing table), or run \`forge skill for "<situation>"\` for the deterministic best-fit skill. This is agent-agnostic — never branch on harness identity.

## Quick Start

\`\`\`bash
bun install          # Install dependencies
${meta.testCommand}  # Run tests
${meta.buildCommand} # Build project
\`\`\`

## Forge TDD Workflow Template

### Utility: /status
Check current context and active work
- Review git status and recent commits
- Check Beads issues (if installed) for active work
- Identify current workflow stage

### /plan
Create implementation plan
- Research with web search (parallel-ai MCP recommended)
- Document findings in \`docs/work/YYYY-MM-DD-<feature-slug>/plan.md\`
- Include decision rationale and security considerations
- Generate plan, create Beads issue, break into TDD cycles

### /dev
TDD development (RED-GREEN-REFACTOR)
- **RED**: Write failing test FIRST
- **GREEN**: Implement minimal code to pass
- **REFACTOR**: Clean up and optimize
- Commit after each cycle
- Push regularly to remote

### /validate
Validation and quality gates
- Type checking${meta.language === 'TypeScript' ? ' (TypeScript strict mode)' : ''}
- Linting (ESLint)
- Security scanning (npm audit, OWASP checks)
- Test suite (all tests must pass)
- Code coverage verification

### /ship
Create pull request
- Generate PR body with context
- Reference Beads issues
- Include test coverage metrics
- Link to research and plan documents

### /review
Address ALL PR feedback
- GitHub Actions failures
- Code review comments
- AI review tools (Greptile, CodeRabbit if configured)
- Security scan results
- Resolve all threads before merge

> **Pre-merge gate** (not a numbered stage): before merge, finish docs on the feature branch, confirm CI is green, and hand off the PR. This gate is embedded in the \`/ship\` and \`/review\` stages, not a standalone command.

### /verify
Final documentation cross-check
- Verify all docs updated correctly
- Check for broken links
- Validate code examples
- Ensure consistency across documentation

## Core Principles

### TDD-First Development
- Tests written UPFRONT in RED-GREEN-REFACTOR cycles
- No implementation without failing test first
- Commit after each GREEN cycle
- Maintain high code coverage (80%+)

### Research-First Approach
- All features start with comprehensive research
- Use web search for best practices and security analysis
- Document findings before implementation
- Include OWASP Top 10 analysis for security-critical features

### Security Built-In
- OWASP Top 10 analysis for every new feature
- Security test scenarios identified upfront
- Automated scans + manual review
- Input validation and sanitization

### Documentation Progressive
- Updated at relevant stages (not deferred to end)
- Cross-checked at /verify stage
- Never accumulate documentation debt
- Keep README, docs/, and inline comments synchronized

## Tech Stack

${meta.language ? `- **Language**: ${meta.language}` : ''}
- **Package Manager**: Bun (recommended)
- **Testing**: TDD-first with high coverage
- **Security**: OWASP Top 10 compliance
- **Version Control**: Git with conventional commits

## MCP Servers (Model Context Protocol)

If your agent supports MCP, configure these servers for enhanced capabilities:

- **parallel-ai**: Web research and data enrichment
- **context7**: Up-to-date library documentation
- **github**: Repository integration (often built-in)

Configuration: \`.mcp.json\` or agent-specific config files

## Issue Tracking

Use **Forge's Beads wrapper** for persistent tracking across sessions:

\`\`\`bash
forge create "Feature name"              # Create issue
forge claim <id>                         # Claim work
forge update <id> --append-notes "Progress" # Add notes
forge close <id>                         # Complete
forge sync                               # Sync Beads state
\`\`\`

Use \`forge issue\` subcommands for everything else, such as
\`forge issue comment\`, \`forge issue dep\`, and \`forge issue stats\`.

## Git Workflow

**Branch naming**:
- \`feat/<feature-slug>\` - New features
- \`fix/<bug-slug>\` - Bug fixes
- \`docs/<doc-slug>\` - Documentation updates

**Commit pattern**:
\`\`\`bash
git commit -m "test: add validation tests"     # RED
git commit -m "feat: implement validation"     # GREEN
git commit -m "refactor: extract helpers"      # REFACTOR
\`\`\`

**Pre-commit hooks** (automatic via Lefthook):
- TDD enforcement (source files must have tests)
- Interactive prompts (option to unstage, continue, or abort)

**Pre-push hooks** (automatic):
- Branch protection (blocks direct push to main/master)
- ESLint check (blocks on errors)
- Test suite (all tests must pass)

## Agent-Specific Enhancements

While this universal AGENTS.md works with all agents, you can optionally enable agent-specific enhancements:

- **Cursor**: \`.cursor/rules/*.mdc\` + native modes

Generate with: \`bunx forge setup --agent=<name>\`

## Support

- **Documentation**: \`docs/\` directory
- **Workflow Guide**: \`AGENTS.md\`
- **Architecture**: \`docs/ARCHITECTURE.md\` (if it exists)
- **Configuration**: \`docs/CONFIGURATION.md\` (if it exists)

For questions or issues with Forge workflow, see project documentation or GitHub repository.
`;
}

/**
 * Generate Cursor configuration files
 * @param {string} projectPath - Path to the project root
 * @param {Object} options - Generation options
 * @param {boolean} options.overwrite - Whether to overwrite existing files (default: false)
 * @returns {Promise<void>}
 */
async function generateCursorConfig(projectPath, options = {}) {
  const { overwrite = false } = options;

  // Cursor rule CONTENT is not hand-authored here. It is rendered from the
  // canonical `rules/<name>.md` manifest. Cursor is the only harness with a native
  // rule surface; Claude/Codex/Hermes receive the same policy via their AGENTS.md
  // instruction projection (no always-on `.claude/rules/*` files are generated).
  // See lib/rules-sync.js and docs/reference/AGENT_SKILL_PARITY.md.
  renderRulesForHarness({
    sourceRoot: getPackageRoot(PACKAGE_ROOT),
    targetRoot: projectPath,
    harness: 'cursor',
    overwrite,
  });
}

/**
 * Generate docs/ARCHITECTURE.md explaining Commands vs Skills vs MCP
 * @param {string} projectPath - Path to the project root
 * @param {Object} options - Generation options
 * @returns {Promise<void>}
 */
async function generateArchitectureDoc(projectPath, options = {}) {
  const { overwrite = false } = options;
  const docsDir = path.join(projectPath, 'docs');
  const architecturePath = path.join(docsDir, 'ARCHITECTURE.md');

  // Check if file exists and overwrite is false
  if (fs.existsSync(architecturePath) && !overwrite) {
    return; // Skip generation
  }

  // Ensure docs directory exists
  await fs.promises.mkdir(docsDir, { recursive: true });

  const content = generateArchitectureContent();
  await fs.promises.writeFile(architecturePath, content, 'utf-8');
}

/**
 * Generate content for ARCHITECTURE.md
 * @returns {string}
 */
function generateArchitectureContent() {
  return `# Forge Architecture: How Multi-Agent Support Works

## Overview

Forge supports multiple AI agents through a three-tier architecture:

1. **Commands** - Universal workflow stages in AGENTS.md
2. **Skills** - Agent-specific capabilities (Claude Code only)
3. **MCP Servers** - Model Context Protocol for enhanced tools

## 1. Commands (Universal)

**What**: Workflow stages defined in AGENTS.md as markdown sections

**How it works**:
- AI reads AGENTS.md and follows the documented workflow
- Works with ANY agent that supports instruction files
- Commands are just structured instructions, not executable code

**Examples**:
- \`/status\` - Check current context and active work
- \`/plan\` - Create implementation plan
- \`/dev\` - TDD development
- \`/validate\` - Run all validation checks

**Compatibility**: ✅ Universal (works with all agents)

## 2. Skills (Agent-Specific)

**What**: Executable integrations for specific agents

**How it works**:
- Defined in agent-specific directories (e.g., \`.claude/skills/\`)
- Agent loads skills and invokes them as tools
- Skills can make API calls, run commands, etc.

**Examples**:
- \`/parallel-ai\` - Web research via Parallel AI API
- \`/sonarcloud\` - Code quality analysis
- \`/context7\` - Library documentation lookup

**Compatibility**: ⚠️ Limited (only Claude Code currently supports)

## 3. MCP Servers (Model Context Protocol)

**What**: Standardized tool discovery via MCP protocol

**How it works**:
- Defined in \`.mcp.json\` or agent-specific config
- Agent auto-discovers tools at runtime
- Servers provide capabilities dynamically

**Examples**:
- \`context7\` - Up-to-date library documentation
- \`parallel-ai\` - Web search and research
- \`github\` - GitHub API integration

**Compatibility**: ✅ Growing (Claude Code, Codex, and Cursor support MCP)

## Universal vs Agent-Specific

### Universal Approach (AGENTS.md)

**Pros**:
- Works with ALL agents (100% compatibility)
- Single source of truth
- Easy to maintain
- No setup required

**Cons**:
- Commands are instructions, not executable code
- Agent must read and interpret manually

### Agent-Specific Approach (Skills/MCP)

**Pros**:
- Executable tools and APIs
- Automatic discovery (MCP)
- Enhanced capabilities

**Cons**:
- Limited agent support
- Requires configuration
- More complex setup

## Forge's Hybrid Strategy

Forge uses **both** approaches:

1. **AGENTS.md** - Baseline workflow for all agents
2. **MCP Servers** - Enhanced tools (if agent supports)
3. **Skills** - Fallback for agents without MCP

This ensures:
- ✅ Universal compatibility (AGENTS.md)
- ✅ Enhanced capabilities (MCP)
- ✅ Gradual adoption (agents add MCP support over time)

## File Organization

\`\`\`
project/
├── AGENTS.md              # Universal commands (all agents)
├── .mcp.json              # MCP servers (Claude, Codex, Cursor)
├── .claude/
│   └── skills/            # Claude-specific skills
└── .cursor/
    └── rules/             # Cursor-specific rules
\`\`\`

## For Developers

**When creating a new workflow stage:**

1. Document in AGENTS.md (required - universal)
2. Add MCP server if enhanced capability needed (optional)
3. Create skill for Claude Code if MCP not available (fallback)

**When choosing an agent:**

- All agents get full workflow via AGENTS.md
- Agents with MCP get enhanced tools automatically
- Claude Code gets additional skills

No coordination needed between agents - they all work independently.

## See Also

- [CONFIGURATION.md](./CONFIGURATION.md) - Solo vs Team setup
- [MCP_SETUP.md](./MCP_SETUP.md) - MCP server configuration
- [AGENTS.md](../AGENTS.md) - Universal agent instructions
`;
}

/**
 * Generate docs/CONFIGURATION.md explaining Solo vs Team setup
 * @param {string} projectPath - Path to the project root
 * @param {Object} options - Generation options
 * @returns {Promise<void>}
 */
async function generateConfigurationDoc(projectPath, options = {}) {
  const { overwrite = false } = options;
  const docsDir = path.join(projectPath, 'docs');
  const configPath = path.join(docsDir, 'CONFIGURATION.md');

  // Check if file exists and overwrite is false
  if (fs.existsSync(configPath) && !overwrite) {
    return; // Skip generation
  }

  // Ensure docs directory exists
  await fs.promises.mkdir(docsDir, { recursive: true });

  const content = generateConfigurationContent();
  await fs.promises.writeFile(configPath, content, 'utf-8');
}

/**
 * Generate content for CONFIGURATION.md
 * @returns {string}
 */
function generateConfigurationContent() {
  return `# Forge Configuration Guide

## Overview

Forge adapts to your workflow with two primary profiles:

- **Solo**: Individual developer, streamlined workflow
- **Team**: Multiple contributors, enforced quality gates

## Configuration File

Create \`.forgerc.json\` in your project root:

\`\`\`json
{
  "profile": "solo",  // or "team"

  "solo": {
    "branch_protection": "minimal",
    "required_reviewers": 0,
    "auto_merge": true,
    "commit_signing": "optional"
  },

  "team": {
    "branch_protection": "strict",
    "required_reviewers": 1,
    "codeowners": "required",
    "commit_signing": "required",
    "auto_merge": false
  }
}
\`\`\`

## Solo Profile

**Best for**: Individual developers, side projects, rapid prototyping

**Characteristics**:
- Minimal branch protection (can push to main)
- No review requirements
- Auto-merge when checks pass
- Optional commit signing
- Faster iteration cycle

**Setup**:
\`\`\`bash
bunx forge setup --profile=solo
\`\`\`

**Example workflow**:
\`\`\`bash
/plan feature-slug        # Research, plan, branch
/dev                      # Implement with TDD
/validate                    # Run all checks
git push                  # Direct push (no PR needed)
\`\`\`

## Team Profile

**Best for**: Teams, open-source projects, production systems

**Characteristics**:
- Strict branch protection (no direct push to main)
- Required reviewers (1+ team members)
- CODEOWNERS enforcement
- Required commit signing
- Manual merge after approval
- Quality gates enforced

**Setup**:
\`\`\`bash
bunx forge setup --profile=team --interactive
\`\`\`

**Example workflow**:
\`\`\`bash
/plan feature-slug        # Research, plan, branch + worktree
/dev                      # Implement with TDD
/validate                    # Run all checks
/ship                     # Create PR
/review                   # Address feedback
/verify                   # Post-merge verify (pre-merge gate runs in /ship + /review)
\`\`\`

## Configuration Options

### Branch Protection

**Solo**: \`minimal\`
- Allows direct push to main
- No status checks required
- Fast iteration

**Team**: \`strict\`
- Blocks direct push to main/master
- Requires PR approval
- Status checks must pass
- CODEOWNERS must approve

### Required Reviewers

**Solo**: \`0\`
- No review needed
- Self-merge allowed

**Team**: \`1\` (or more)
- At least 1 approval required
- CODEOWNERS approval for critical files

### Auto-Merge

**Solo**: \`true\`
- PRs auto-merge when checks pass
- Faster workflow

**Team**: \`false\`
- Manual merge after review
- Final approval step

### Commit Signing

**Solo**: \`optional\`
- GPG signing recommended but not required

**Team**: \`required\`
- All commits must be signed
- Verified authorship

## Detection (Auto-Configuration)

Forge auto-detects your profile during setup:

**Solo indicators**:
- Single contributor in git log
- No CODEOWNERS file
- No branch protection configured

**Team indicators**:
- Multiple contributors
- CODEOWNERS file exists
- Branch protection already set up

Override auto-detection:
\`\`\`bash
bunx forge setup --profile=team  # Force team profile
\`\`\`

## Switching Profiles

Change profile anytime:

\`\`\`bash
# Edit .forgerc.json
{
  "profile": "team"  // Change from "solo" to "team"
}

# Re-run setup
bunx forge setup
\`\`\`

Forge will update:
- Branch protection rules
- Git hooks (lefthook)
- GitHub workflows
- PR templates

## Custom Profiles

Create custom profiles for specific needs:

\`\`\`json
{
  "profile": "custom-strict",

  "custom-strict": {
    "branch_protection": "strict",
    "required_reviewers": 2,
    "codeowners": "required",
    "commit_signing": "required",
    "auto_merge": false,
    "quality_gates": {
      "coverage_threshold": 90,
      "mutation_score": 75
    }
  }
}
\`\`\`

## Environment-Specific Settings

Override for CI/CD:

\`\`\`bash
# .forgerc.ci.json (for CI/CD environments)
{
  "profile": "team",
  "ci": {
    "skip_interactive": true,
    "strict_checks": true
  }
}
\`\`\`

Load with:
\`\`\`bash
bunx forge setup --config=.forgerc.ci.json
\`\`\`

## See Also

- [ARCHITECTURE.md](./ARCHITECTURE.md) - How multi-agent support works
- [MCP_SETUP.md](./MCP_SETUP.md) - MCP server configuration
- [AGENTS.md](../AGENTS.md) - Complete workflow guide
`;
}

/**
 * Generate docs/MCP_SETUP.md explaining MCP server configuration
 * @param {string} projectPath - Path to the project root
 * @param {Object} options - Generation options
 * @returns {Promise<void>}
 */
async function generateMcpSetupDoc(projectPath, options = {}) {
  const { overwrite = false } = options;
  const docsDir = path.join(projectPath, 'docs');
  const mcpPath = path.join(docsDir, 'MCP_SETUP.md');

  // Check if file exists and overwrite is false
  if (fs.existsSync(mcpPath) && !overwrite) {
    return; // Skip generation
  }

  // Ensure docs directory exists
  await fs.promises.mkdir(docsDir, { recursive: true });

  const content = generateMcpSetupContent();
  await fs.promises.writeFile(mcpPath, content, 'utf-8');
}

/**
 * Generate content for MCP_SETUP.md
 * @returns {string}
 */
function generateMcpSetupContent() {
  return `# MCP Server Setup Guide

## What is MCP?

**Model Context Protocol (MCP)** is a standardized protocol for AI agents to discover and use external tools at runtime.

**Benefits**:
- Auto-discovery of tools (no manual configuration)
- Works across multiple AI agents
- Enhanced capabilities (web search, API access, etc.)

**Supported Agents**:
- ✅ Claude Code
- ✅ Codex
- ✅ Cursor

## Quick Start

### 1. Install MCP-Compatible Agent

Choose one of the supported agents above.

### 2. Configure MCP Servers

Each agent has a different configuration location:

**Claude Code**: \`.mcp.json\` in project root
**Codex**: \`~/.codex/config.toml\` under \`mcp_servers\`
**Cursor**: \`.cursor/mcp.json\`

### 3. Add Forge-Recommended Servers

Copy the configuration for your agent from the examples below.

## Recommended MCP Servers

### parallel-ai (Web Search & Research)

**Purpose**: Deep research with web search, data extraction, and analysis

**Setup for Claude Code**:
\`\`\`json
{
  "mcpServers": {
    "parallel-ai": {
      "command": "npx",
      "args": ["-y", "@parallel-ai/mcp-server"],
      "env": {
        "PARALLEL_AI_TOKEN": "\${env:PARALLEL_AI_TOKEN}"
      }
    }
  }
}
\`\`\`

**Get API Token**: Sign up at [parallel.ai](https://parallel.ai)

**Usage in Forge**:
- \`/plan <feature-name>\` - Research phase uses parallel-ai for web search

### context7 (Library Documentation)

**Purpose**: Up-to-date documentation for popular libraries and frameworks

**Setup for Claude Code**:
\`\`\`json
{
  "mcpServers": {
    "context7": {
      "command": "npx",
      "args": ["-y", "@context7/mcp-server"]
    }
  }
}
\`\`\`

**No API key required** - Works out of the box

**Usage in Forge**:
- Ask: "What's the latest React hooks API?"
- Ask: "How do I use TypeScript generics?"

### github (GitHub API)

**Purpose**: GitHub repository access, issues, PRs, code search

**Setup for Claude Code**:
\`\`\`json
{
  "mcpServers": {
    "github": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": {
        "GITHUB_TOKEN": "\${env:GITHUB_TOKEN}"
      }
    }
  }
}
\`\`\`

**Get Token**: Create personal access token at [github.com/settings/tokens](https://github.com/settings/tokens)

**Usage in Forge**:
- \`/ship\` - Automatically uses GitHub API to create PR
- \`/review\` - Fetches PR comments and feedback

## Agent-Specific Configuration

### Claude Code

**File**: \`.mcp.json\` in project root

**Example**:
\`\`\`json
{
  "mcpServers": {
    "parallel-ai": {
      "command": "npx",
      "args": ["-y", "@parallel-ai/mcp-server"],
      "env": {
        "PARALLEL_AI_TOKEN": "\${env:PARALLEL_AI_TOKEN}"
      }
    },
    "context7": {
      "command": "npx",
      "args": ["-y", "@context7/mcp-server"]
    }
  }
}
\`\`\`

**Environment Variables**: Set in \`.env\` or shell profile

### Cursor

**File**: \`.cursor/mcp.json\`

**Example**:
\`\`\`json
{
  "mcpServers": {
    "parallel-ai": {
      "type": "http",
      "url": "https://api.parallel-ai.com/mcp",
      "headers": {
        "Authorization": "Bearer \${env:PARALLEL_AI_TOKEN}"
      }
    },
    "context7": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@context7/mcp-server"]
    }
  }
}
\`\`\`

**Note**: Cursor supports both STDIO and HTTP MCP servers

## Setup with Forge

Forge can automatically configure MCP servers during setup:

\`\`\`bash
# Auto-detect agent and configure MCP
bunx forge setup --mcp

# Agent-specific setup with MCP
bunx forge setup --agent=claude --mcp
bunx forge setup --agent=codex --mcp
bunx forge setup --agent=cursor --mcp
\`\`\`

This will:
1. Detect installed agents
2. Create appropriate MCP config files
3. Add recommended servers (parallel-ai, context7)
4. Set up environment variable placeholders

## Environment Variables

Create \`.env\` file in project root:

\`\`\`bash
# .env (don't commit this file!)
PARALLEL_AI_TOKEN=your_token_here
GITHUB_TOKEN=your_github_token_here
\`\`\`

Add to \`.gitignore\`:
\`\`\`
.env
\`\`\`

## Verification

Test MCP setup:

**Claude Code**:
\`\`\`bash
# Ask Claude: "Search the web for best React testing practices"
# Should use parallel-ai automatically
\`\`\`

**Cursor**:
\`\`\`bash
# In Cursor, use Agent mode: "Research authentication best practices"
# Should use parallel-ai if configured
\`\`\`

## Troubleshooting

### MCP server not found

**Error**: "MCP server 'parallel-ai' not found"

**Solution**: Install server globally or ensure npx is working:
\`\`\`bash
npm install -g @parallel-ai/mcp-server
\`\`\`

### Environment variables not loading

**Error**: "PARALLEL_AI_TOKEN not found"

**Solution**: Ensure \`.env\` is in project root and agent is restarted

### STDIO vs HTTP servers

**STDIO**: Runs as local process (e.g., \`npx @context7/mcp-server\`)
**HTTP**: Calls remote API (e.g., \`https://api.parallel-ai.com/mcp\`)

Choose based on server documentation.

## See Also

- [ARCHITECTURE.md](./ARCHITECTURE.md) - How MCP fits in Forge architecture
- [CONFIGURATION.md](./CONFIGURATION.md) - Solo vs Team setup
- [MCP Protocol Spec](https://modelcontextprotocol.io) - Official MCP documentation
`;
}

module.exports = {
  detectProjectMetadata,
  generateAgentsMd,
  generateAgentsMdContent,
  generateCursorConfig,
  generateArchitectureDoc,
  generateConfigurationDoc,
  generateMcpSetupDoc
};
