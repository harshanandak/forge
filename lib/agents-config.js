const fs = require('node:fs');
const path = require('node:path');

/**
 * Generate universal AGENTS.md file that works with all supported AI agents
 * @param {string} projectPath - Path to the project root
 * @returns {Promise<void>}
 */
async function generateAgentsMd(projectPath) {
  const agentsMdPath = path.join(projectPath, 'AGENTS.md');

  // Detect project metadata
  const projectMeta = await detectProjectMetadata(projectPath);

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
    }

    // Detect test command
    if (packageJson.scripts?.test) {
      meta.testCommand = packageJson.scripts.test;
    }

    // Detect build command
    if (packageJson.scripts?.build) {
      meta.buildCommand = packageJson.scripts.build;
    }
  } catch (error) {
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

This project uses the **Forge 9-Stage TDD Workflow** for development.

## Supported AI Agents

This workflow works with all major AI coding agents:
- **Claude Code** - Native custom slash commands, skills
- **GitHub Copilot** - Enterprise support, multi-editor, MCP
- **Kilo Code** - Auto failure recovery, managed indexing
- **Cursor** - IDE-integrated, native Plan/Ask/Debug modes
- **Aider** - Terminal-native, git-integrated, open source

## Quick Start

\`\`\`bash
bun install          # Install dependencies
${meta.testCommand}  # Run tests
${meta.buildCommand} # Build project
\`\`\`

## Forge 9-Stage TDD Workflow

### Stage 1: /status
Check current context and active work
- Review git status and recent commits
- Check Beads issues (if installed) for active work
- Identify current workflow stage

### Stage 2: /research
Deep research with web search (parallel-ai MCP recommended)
- Document findings in \`docs/research/<feature-slug>.md\`
- Include decision rationale and alternatives
- Identify security considerations (OWASP Top 10)
- Extract test scenarios upfront

### Stage 3: /plan
Create formal implementation plan
- Generate plan in \`.claude/plans/<feature-slug>.md\`
- Create Beads issue (if installed)
- For strategic changes: Create OpenSpec proposal
- Break down into TDD cycles

### Stage 4: /dev
TDD development (RED-GREEN-REFACTOR)
- **RED**: Write failing test FIRST
- **GREEN**: Implement minimal code to pass
- **REFACTOR**: Clean up and optimize
- Commit after each cycle
- Push regularly to remote

### Stage 5: /check
Validation and quality gates
- Type checking${meta.language === 'TypeScript' ? ' (TypeScript strict mode)' : ''}
- Linting (ESLint)
- Security scanning (npm audit, OWASP checks)
- Test suite (all tests must pass)
- Code coverage verification

### Stage 6: /ship
Create pull request
- Generate PR body with context
- Reference Beads issues
- Include test coverage metrics
- Link to research and plan documents

### Stage 7: /review
Address ALL PR feedback
- GitHub Actions failures
- Code review comments
- AI review tools (Greptile, CodeRabbit if configured)
- Security scan results
- Resolve all threads before merge

### Stage 8: /merge
Merge and cleanup
- Update documentation
- Merge pull request (squash commits)
- Delete feature branch
- Archive completed work
- Close Beads issues

### Stage 9: /verify
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

Use **Beads** for persistent tracking across sessions:

\`\`\`bash
bd create "Feature name"              # Create issue
bd update <id> --status in_progress   # Claim work
bd update <id> --comment "Progress"   # Add notes
bd close <id>                          # Complete
bd sync                                # Sync with git
\`\`\`

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

- **GitHub Copilot**: \`.github/copilot-instructions.md\` + path-specific instructions
- **Cursor**: \`.cursor/rules/*.mdc\` + native modes
- **OpenCode**: \`opencode.json\` + custom agents
- **Kilo**: \`.kilo.md\` + built-in commands
- **Aider**: \`.aider.conf.yml\` + system prompts

Generate with: \`bunx forge setup --agent=<name>\`

## Support

- **Documentation**: \`docs/\` directory
- **Workflow Guide**: \`docs/WORKFLOW.md\`
- **Architecture**: \`docs/ARCHITECTURE.md\` (if it exists)
- **Configuration**: \`docs/CONFIGURATION.md\` (if it exists)

For questions or issues with Forge workflow, see project documentation or GitHub repository.
`;
}

module.exports = {
  generateAgentsMd
};
