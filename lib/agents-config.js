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

/**
 * Generate GitHub Copilot configuration files
 * @param {string} projectPath - Path to the project root
 * @param {Object} options - Generation options
 * @param {boolean} options.overwrite - Whether to overwrite existing files (default: false)
 * @returns {Promise<void>}
 */
async function generateCopilotConfig(projectPath, options = {}) {
  const { overwrite = false } = options;

  // Detect project metadata
  const projectMeta = await detectProjectMetadata(projectPath);

  // Create .github directory structure
  const githubDir = path.join(projectPath, '.github');
  const instructionsDir = path.join(githubDir, 'instructions');
  const promptsDir = path.join(githubDir, 'prompts');

  await fs.promises.mkdir(instructionsDir, { recursive: true });
  await fs.promises.mkdir(promptsDir, { recursive: true });

  // Helper to write file if it doesn't exist or overwrite is true
  const writeIfNeeded = async (filePath, content) => {
    const exists = await fs.promises.access(filePath).then(() => true).catch(() => false);
    if (!exists || overwrite) {
      await fs.promises.writeFile(filePath, content, 'utf-8');
    }
  };

  // 1. Create .github/copilot-instructions.md
  const copilotInstructionsPath = path.join(githubDir, 'copilot-instructions.md');
  const copilotInstructionsContent = generateCopilotInstructionsContent(projectMeta);
  await writeIfNeeded(copilotInstructionsPath, copilotInstructionsContent);

  // 2. Create .github/instructions/typescript.instructions.md
  const tsInstructionsPath = path.join(instructionsDir, 'typescript.instructions.md');
  const tsInstructionsContent = generateTypeScriptInstructionsContent();
  await writeIfNeeded(tsInstructionsPath, tsInstructionsContent);

  // 3. Create .github/instructions/testing.instructions.md
  const testInstructionsPath = path.join(instructionsDir, 'testing.instructions.md');
  const testInstructionsContent = generateTestingInstructionsContent();
  await writeIfNeeded(testInstructionsPath, testInstructionsContent);

  // 4. Create .github/prompts/red.prompt.md
  const redPromptPath = path.join(promptsDir, 'red.prompt.md');
  const redPromptContent = generateRedPromptContent();
  await writeIfNeeded(redPromptPath, redPromptContent);

  // 5. Create .github/prompts/green.prompt.md
  const greenPromptPath = path.join(promptsDir, 'green.prompt.md');
  const greenPromptContent = generateGreenPromptContent();
  await writeIfNeeded(greenPromptPath, greenPromptContent);
}

/**
 * Generate .github/copilot-instructions.md content
 */
function generateCopilotInstructionsContent(meta) {
  const packageManager = meta.testCommand?.includes('bun') ? 'bun' : 'npm';

  return `# Forge Workflow Framework

This project uses the **Forge 9-Stage TDD Workflow** for development with GitHub Copilot.

## Quick Start

\`\`\`bash
${packageManager} install      # Install dependencies
${meta.testCommand}            # Run tests
${meta.buildCommand}           # Build project
\`\`\`

## Tech Stack

${meta.language ? `- **Language**: ${meta.language} (strict mode enabled)` : '- **Language**: JavaScript'}
- **Package Manager**: ${packageManager}
- **Testing**: TDD-first approach (tests before implementation)
- **Security**: OWASP Top 10 compliance required
- **Version Control**: Git with conventional commits

## Forge 9-Stage TDD Workflow

### Stage 1: /status
Check current context and active work
- Review git status and recent commits
- Check Beads issues (if installed) for active work
- Identify current workflow stage

### Stage 2: /research
Deep research with web search
- Document findings in \`docs/research/<feature-slug>.md\`
- Include decision rationale and alternatives
- **Security**: Identify OWASP Top 10 considerations
- Extract test scenarios upfront

### Stage 3: /plan
Create formal implementation plan
- Generate plan in \`.claude/plans/<feature-slug>.md\`
- Create Beads issue (if installed)
- For strategic changes: Create OpenSpec proposal
- Break down into TDD cycles

### Stage 4: /dev
**TDD development (RED-GREEN-REFACTOR)**
- **RED**: Write failing test FIRST
- **GREEN**: Implement minimal code to pass
- **REFACTOR**: Clean up and optimize
- Commit after each cycle
- Push regularly to remote

### Stage 5: /check
Validation and quality gates
- Type checking${meta.language === 'TypeScript' ? ' (TypeScript strict mode)' : ''}
- Linting (ESLint - no errors allowed)
- Security scanning (npm audit, OWASP checks)
- Test suite (all tests must pass)
- Code coverage verification (80%+ required)

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
- **IMPORTANT**: Resolve all comment threads before merge

### Stage 8: /merge
Merge and cleanup
- Update documentation
- Merge pull request (squash commits only)
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

### 1. TDD-First Development (MANDATORY)
- Tests written UPFRONT in RED-GREEN-REFACTOR cycles
- **NO implementation without failing test first**
- Commit after each GREEN cycle
- Maintain high code coverage (80%+ minimum)

### 2. Research-First Approach
- All features start with comprehensive research
- Use web search for best practices and security analysis
- Document findings before implementation
- **Include OWASP Top 10 analysis for security-critical features**

### 3. Security Built-In
- **OWASP Top 10** analysis for every new feature:
  - A01: Broken Access Control
  - A02: Cryptographic Failures
  - A03: Injection
  - A04: Insecure Design
  - A05: Security Misconfiguration
  - A06: Vulnerable and Outdated Components
  - A07: Identification and Authentication Failures
  - A08: Software and Data Integrity Failures
  - A09: Security Logging and Monitoring Failures
  - A10: Server-Side Request Forgery (SSRF)
- Security test scenarios identified upfront
- Automated scans + manual review
- Input validation and sanitization

### 4. Documentation Progressive
- Updated at relevant stages (not deferred to end)
- Cross-checked at /verify stage
- Never accumulate documentation debt
- Keep README, docs/, and inline comments synchronized

## Git Workflow

**Branch naming**:
- \`feat/<feature-slug>\` - New features
- \`fix/<bug-slug>\` - Bug fixes
- \`docs/<doc-slug>\` - Documentation updates

**Commit pattern** (conventional commits):
\`\`\`bash
git commit -m "test: add validation tests"     # RED phase
git commit -m "feat: implement validation"     # GREEN phase
git commit -m "refactor: extract helpers"      # REFACTOR phase
\`\`\`

**Pre-commit hooks** (automatic via Lefthook):
- TDD enforcement (source files must have tests)
- Interactive prompts (option to unstage, continue, or abort)

**Pre-push hooks** (automatic):
- Branch protection (blocks direct push to main/master)
- ESLint check (blocks on errors)
- Test suite (all tests must pass)

## MCP Servers (Enhanced Capabilities)

Configure these MCP servers in \`.mcp.json\`:

- **github**: Repository integration (usually built-in)
- **parallel-ai**: Web research and data enrichment
- **context7**: Up-to-date library documentation

## Issue Tracking with Beads

Use **Beads** for persistent tracking across sessions:

\`\`\`bash
bd create "Feature name"                  # Create issue
bd update <id> --status in_progress       # Claim work
bd update <id> --append-notes "Progress"  # Add notes
bd close <id>                              # Complete
bd sync                                    # Sync with git
\`\`\`

## Code Quality Standards

${meta.language === 'TypeScript' ? `
### TypeScript
- Strict mode enabled (\`strict: true\` in tsconfig.json)
- No \`any\` types without explicit justification
- Prefer interfaces over types for object shapes
- Use const assertions for literal types
` : ''}

### Testing
- TDD-first: Write failing test BEFORE implementation
- Use descriptive test names ("it should...")
- Arrange-Act-Assert pattern
- Mock external dependencies
- Test edge cases and error scenarios

### Security
- Validate all user input
- Sanitize output to prevent XSS
- Use parameterized queries (prevent SQL injection)
- Implement proper authentication and authorization
- Never commit secrets or credentials

## Additional Resources

- **Workflow Guide**: \`docs/WORKFLOW.md\`
- **Architecture**: \`docs/ARCHITECTURE.md\`
- **Configuration**: \`docs/CONFIGURATION.md\`
`;
}

/**
 * Generate .github/instructions/typescript.instructions.md content
 */
function generateTypeScriptInstructionsContent() {
  return `---
applyTo: "**/*.ts"
---

# TypeScript Guidelines

When working with TypeScript files in this project:

## Type Safety
- **strict mode is enabled** - No shortcuts with types
- Avoid \`any\` type - Use \`unknown\` and type guards instead
- Prefer interfaces over type aliases for object shapes
- Use const assertions for literal types

## Code Style
- Use explicit return types for public functions
- Leverage type inference for local variables
- Use utility types (\`Partial\`, \`Pick\`, \`Omit\`, etc.) appropriately
- Document complex types with JSDoc comments

## Common Patterns
- Use discriminated unions for state management
- Prefer \`readonly\` for immutable data
- Use \`unknown\` instead of \`any\` for truly unknown types
- Leverage template literal types for string validation

## Error Handling
- Create custom error types for domain-specific errors
- Use type guards to narrow error types
- Always type catch clauses (\`catch (error: unknown)\`)
`;
}

/**
 * Generate .github/instructions/testing.instructions.md content
 */
function generateTestingInstructionsContent() {
  return `---
applyTo: "**/*.test.ts"
---

# Testing Guidelines

When writing tests in this project:

## TDD-First Approach
- **Write failing test BEFORE implementation** (RED phase)
- Run test to confirm it fails for the right reason
- Implement minimal code to make test pass (GREEN phase)
- Refactor while keeping tests green (REFACTOR phase)

## Test Structure
- Use descriptive test names: "it should [expected behavior] when [condition]"
- Follow Arrange-Act-Assert pattern:
  - **Arrange**: Set up test data and preconditions
  - **Act**: Execute the code under test
  - **Assert**: Verify the expected outcome

## Best Practices
- One assertion per test (or closely related assertions)
- Test edge cases and error scenarios
- Mock external dependencies (APIs, databases, file system)
- Use fixtures for complex test data
- Keep tests fast and independent

## Coverage
- Aim for 80%+ code coverage
- Focus on testing behavior, not implementation details
- Test public interfaces, not private methods
- Include integration tests for critical paths

## Security Testing
- Test input validation and sanitization
- Verify authentication and authorization
- Test error messages don't leak sensitive data
- Include security-specific test cases for OWASP Top 10
`;
}

/**
 * Generate .github/prompts/red.prompt.md content
 */
function generateRedPromptContent() {
  return `Write a failing test for the following requirement.

Follow TDD red-green-refactor cycle:
- Test should fail initially (RED phase)
- Use descriptive test name
- Follow Arrange-Act-Assert pattern
- Test one behavior per test case

Do NOT implement the feature yet - only write the test.
`;
}

/**
 * Generate .github/prompts/green.prompt.md content
 */
function generateGreenPromptContent() {
  return `Implement minimal code to make the failing test pass.

Follow TDD principles:
- Write only enough code to pass the test (GREEN phase)
- Keep implementation simple and focused
- Don't add features not covered by tests
- Ensure all tests pass

Refactoring comes after this step - focus on making it work first.
`;
}

module.exports = {
  generateAgentsMd,
  generateCopilotConfig
};
