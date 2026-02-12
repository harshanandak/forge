const fs = require('node:fs');
const path = require('node:path');

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

/**
 * Generate Cursor configuration files
 * @param {string} projectPath - Path to the project root
 * @param {Object} options - Generation options
 * @param {boolean} options.overwrite - Whether to overwrite existing files (default: false)
 * @returns {Promise<void>}
 */
async function generateCursorConfig(projectPath, options = {}) {
  const { overwrite = false } = options;

  // Detect project metadata
  const projectMeta = await detectProjectMetadata(projectPath);

  // Create .cursor/rules directory structure
  const cursorDir = path.join(projectPath, '.cursor');
  const rulesDir = path.join(cursorDir, 'rules');

  await fs.promises.mkdir(rulesDir, { recursive: true });

  // Helper to write file if it doesn't exist or overwrite is true
  const writeIfNeeded = async (filePath, content) => {
    const exists = await fs.promises.access(filePath).then(() => true).catch(() => false);
    if (!exists || overwrite) {
      await fs.promises.writeFile(filePath, content, 'utf-8');
    }
  };

  // 1. Create .cursor/rules/forge-workflow.mdc
  const workflowPath = path.join(rulesDir, 'forge-workflow.mdc');
  const workflowContent = generateCursorWorkflowContent(projectMeta);
  await writeIfNeeded(workflowPath, workflowContent);

  // 2. Create .cursor/rules/tdd-enforcement.mdc
  const tddPath = path.join(rulesDir, 'tdd-enforcement.mdc');
  const tddContent = generateCursorTddContent();
  await writeIfNeeded(tddPath, tddContent);

  // 3. Create .cursor/rules/security-scanning.mdc
  const securityPath = path.join(rulesDir, 'security-scanning.mdc');
  const securityContent = generateCursorSecurityContent();
  await writeIfNeeded(securityPath, securityContent);

  // 4. Create .cursor/rules/documentation.mdc
  const docsPath = path.join(rulesDir, 'documentation.mdc');
  const docsContent = generateCursorDocumentationContent();
  await writeIfNeeded(docsPath, docsContent);
}

/**
 * Generate .cursor/rules/forge-workflow.mdc content
 */
function generateCursorWorkflowContent(meta) {
  const packageManager = meta.testCommand?.includes('bun') ? 'bun' : 'npm';

  return `---
description: "When working with Forge workflow stages"
alwaysApply: true
---

# Forge 9-Stage TDD Workflow

Always follow these stages in order:

## Stage 1: /status
Check current context and active work
- Review git status and recent commits
- Check Beads issues (if installed) for active work
- Identify current workflow stage

## Stage 2: /research
Deep research with parallel-ai
- Document findings in \`docs/research/<feature-slug>.md\`
- Include decision rationale and alternatives
- **Security**: OWASP Top 10 analysis
- Extract test scenarios upfront

## Stage 3: /plan
Create formal plan before implementation
- Generate plan in \`.claude/plans/<feature-slug>.md\`
- Create Beads issue (if installed)
- For strategic changes: Create OpenSpec proposal
- Break down into TDD cycles

## Stage 4: /dev
**TDD development (RED-GREEN-REFACTOR)**
- **RED**: Write failing test FIRST
- **GREEN**: Implement minimal code to pass
- **REFACTOR**: Clean up and optimize
- Commit after each cycle
- Push regularly to remote

## Stage 5: /check
Validation (type/lint/tests/security)
- Type checking${meta.language === 'TypeScript' ? ' (TypeScript strict mode)' : ''}
- Linting (ESLint - no errors)
- Security scanning (npm audit, OWASP)
- Test suite (all tests must pass)
- Code coverage (80%+ required)

## Stage 6: /ship
Create PR with documentation
- Generate PR body with context
- Reference Beads issues
- Include test coverage metrics
- Link to research and plan documents

## Stage 7: /review
Address ALL PR feedback
- GitHub Actions failures
- Code review comments
- AI review tools (Greptile, CodeRabbit)
- Security scan results
- **IMPORTANT**: Resolve all comment threads

## Stage 8: /merge
Update docs, merge PR, cleanup
- Update documentation
- Merge pull request (squash commits only)
- Delete feature branch
- Archive completed work
- Close Beads issues

## Stage 9: /verify
Final documentation verification
- Verify all docs updated correctly
- Check for broken links
- Validate code examples
- Ensure consistency across documentation

## TDD Requirements

**MANDATORY - No implementation without failing test**:
- Write test FIRST (RED phase)
- Implement minimal code to pass (GREEN phase)
- Refactor and commit (REFACTOR phase)
- No code changes without corresponding tests

## Tech Stack

${meta.language ? `- **Language**: ${meta.language}` : '- **Language**: JavaScript'}
- **Package Manager**: ${packageManager}
- **Testing**: TDD-first approach (tests before implementation)
- **Security**: OWASP Top 10 compliance
- **Version Control**: Git with conventional commits

## Cursor Native Modes

Leverage Cursor's built-in modes:
- **Agent Mode** (default): Full tools for implementation
- **Ask Mode**: Read-only exploration and learning
- **Plan Mode** (Shift+Tab): Create plans before coding
- **Debug Mode**: Specialized bug hunting with instrumentation

Use Plan Mode for complex features and architectural decisions.
`;
}

/**
 * Generate .cursor/rules/tdd-enforcement.mdc content
 */
function generateCursorTddContent() {
  return `---
description: "TDD patterns and enforcement"
globs: ["**/*.ts", "**/*.js", "**/*.test.ts", "**/*.test.js"]
---

# TDD Enforcement

## RED-GREEN-REFACTOR Cycle

### RED Phase (Write Failing Test)
1. **Write test FIRST** - Before any implementation
2. Run test to confirm it fails for the right reason
3. Commit: \`git commit -m "test: add [feature] tests (RED)"\`

### GREEN Phase (Make Test Pass)
1. **Write minimal code** to make the test pass
2. Keep implementation simple and focused
3. Don't add features not covered by tests
4. Commit: \`git commit -m "feat: implement [feature] (GREEN)"\`

### REFACTOR Phase (Clean Up)
1. Improve code while keeping tests green
2. Extract helpers, remove duplication
3. Optimize performance if needed
4. Commit: \`git commit -m "refactor: [description]"\`

## Test Structure

### Naming Convention
\`\`\`javascript
test('should [expected behavior] when [condition]', async () => {
  // Arrange: Set up test data
  // Act: Execute code under test
  // Assert: Verify outcome
});
\`\`\`

### Best Practices
- One assertion per test (or closely related assertions)
- Test edge cases and error scenarios
- Mock external dependencies (APIs, databases, file system)
- Use fixtures for complex test data
- Keep tests fast and independent

## Coverage Requirements
- Minimum 80% code coverage
- Focus on testing behavior, not implementation
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
 * Generate .cursor/rules/security-scanning.mdc content
 */
function generateCursorSecurityContent() {
  return `---
description: "OWASP Top 10 security checks"
---

# Security Scanning Guidelines

## OWASP Top 10 (2021)

For every new feature, analyze these security risks:

### A01: Broken Access Control
- Verify authorization checks on all protected resources
- Test that users can't access data they shouldn't
- Implement principle of least privilege

### A02: Cryptographic Failures
- Never store passwords in plaintext
- Use strong encryption algorithms (AES-256, RSA-2048+)
- Protect data in transit (HTTPS, TLS 1.2+)
- Secure key management

### A03: Injection
- **SQL Injection**: Use parameterized queries
- **XSS**: Sanitize output, use Content Security Policy
- **Command Injection**: Validate and sanitize all inputs
- Never concatenate user input into commands or queries

### A04: Insecure Design
- Security requirements defined upfront
- Threat modeling for new features
- Defense in depth (multiple security layers)
- Secure defaults

### A05: Security Misconfiguration
- Remove default credentials
- Disable unnecessary features and services
- Keep dependencies up to date
- Implement security headers

### A06: Vulnerable and Outdated Components
- Regular dependency audits (\`npm audit\`)
- Update dependencies promptly
- Use Software Composition Analysis (SCA) tools
- Monitor security advisories

### A07: Identification and Authentication Failures
- Implement multi-factor authentication where appropriate
- Secure password storage (bcrypt, Argon2)
- Protect against brute force attacks (rate limiting)
- Secure session management

### A08: Software and Data Integrity Failures
- Verify digital signatures
- Use integrity checks for critical data
- Implement code signing
- Secure CI/CD pipelines

### A09: Security Logging and Monitoring Failures
- Log all security-relevant events
- Protect logs from tampering
- Implement alerting for suspicious activity
- Regular log review

### A10: Server-Side Request Forgery (SSRF)
- Validate and sanitize all URLs
- Use allowlists for external requests
- Disable unnecessary protocols
- Network segmentation

## Security Testing Checklist

For each feature:
- [ ] Input validation implemented and tested
- [ ] Output sanitization verified
- [ ] Authentication and authorization tested
- [ ] Error messages don't leak sensitive data
- [ ] Dependencies scanned for vulnerabilities
- [ ] Security test cases added to test suite
- [ ] OWASP Top 10 risks analyzed
`;
}

/**
 * Generate .cursor/rules/documentation.mdc content
 */
function generateCursorDocumentationContent() {
  return `---
description: "Progressive documentation standards"
---

# Documentation Standards

## Progressive Documentation

Update documentation at relevant stages (not deferred to end):

### During /research (Stage 2)
- Document findings in \`docs/research/<feature-slug>.md\`
- Include decision rationale
- Document alternatives considered
- Security considerations (OWASP analysis)

### During /plan (Stage 3)
- Create implementation plan in \`.claude/plans/<feature-slug>.md\`
- Document test scenarios
- Identify affected files

### During /dev (Stage 4)
- Add inline code comments for complex logic
- Update JSDoc/TSDoc for public APIs
- Keep comments synchronized with code changes

### During /ship (Stage 6)
- Update README if user-facing changes
- Update CHANGELOG with conventional commit summary
- Document breaking changes
- Add migration guide if needed

### During /verify (Stage 9)
- Cross-check all documentation updated
- Validate code examples still work
- Check for broken internal links
- Ensure terminology consistency

## Documentation Types

### Code Comments
- **What to comment**: Why, not what
- Document non-obvious decisions
- Explain complex algorithms
- Note security considerations
- Reference tickets/issues for context

### API Documentation
- Use JSDoc/TSDoc for public APIs
- Include parameter types and return types
- Provide usage examples
- Document error conditions
- List breaking changes in version updates

### README Updates
- Keep Quick Start section current
- Update feature list
- Maintain installation instructions
- Document configuration options
- Include troubleshooting section

## Documentation Quality

### Consistency
- Use consistent terminology across docs
- Follow project style guide
- Maintain consistent formatting
- Use same voice and tone

### Clarity
- Write for your audience (developers, users, etc.)
- Use examples liberally
- Avoid jargon without explanation
- Keep sentences short and clear

### Maintainability
- Link to code where appropriate
- Use relative links for internal docs
- Keep docs close to the code they describe
- Remove outdated documentation promptly
`;
}

/**
 * Generate Kilo Code configuration file
 * @param {string} projectPath - Path to the project root
 * @param {Object} options - Generation options
 * @param {boolean} options.overwrite - Whether to overwrite existing files (default: false)
 * @returns {Promise<void>}
 */
async function generateKiloConfig(projectPath, options = {}) {
  const { overwrite = false } = options;

  // Detect project metadata
  const projectMeta = await detectProjectMetadata(projectPath);

  const kiloMdPath = path.join(projectPath, '.kilo.md');

  // Check if file exists
  const exists = await fs.promises.access(kiloMdPath).then(() => true).catch(() => false);
  if (exists && !overwrite) {
    return; // Don't overwrite
  }

  // Generate .kilo.md content (plain markdown, no frontmatter)
  const content = generateKiloMdContent(projectMeta);

  await fs.promises.writeFile(kiloMdPath, content, 'utf-8');
}

/**
 * Generate .kilo.md content
 */
function generateKiloMdContent(meta) {
  const packageManager = meta.testCommand?.includes('bun') ? 'bun' : 'npm';

  return `# Forge Workflow Framework - Kilo Code

This project uses the **Forge 9-Stage TDD Workflow** with Kilo Code.

## Quick Start

\`\`\`bash
${packageManager} install      # Install dependencies
${meta.testCommand}            # Run tests
${meta.buildCommand}           # Build project
\`\`\`

## Kilo Built-in Commands

Kilo Code provides built-in commands:
- \`/plan\` - Create implementation plans (similar to Forge Stage 3)
- \`/deploy\` - Deploy to production
- \`/review\` - Code review assistance

These complement the Forge workflow stages below.

## Forge 9-Stage TDD Workflow

### Stage 1: /status
Check current context and active work
- Review git status and recent commits
- Check Beads issues (if installed)

### Stage 2: /research
Deep research with web search
- Document findings in \`docs/research/<feature-slug>.md\`
- Security: OWASP Top 10 analysis
- Extract test scenarios upfront

### Stage 3: /plan
Create formal implementation plan
- Generate plan in \`.claude/plans/<feature-slug>.md\`
- Create Beads issue
- Break down into TDD cycles

### Stage 4: /dev
**TDD development (RED-GREEN-REFACTOR)**
- **RED**: Write failing test FIRST
- **GREEN**: Implement minimal code to pass
- **REFACTOR**: Clean up and optimize
- Commit after each cycle

### Stage 5: /check
Validation (type/lint/tests/security)
- Type checking${meta.language === 'TypeScript' ? ' (TypeScript strict mode)' : ''}
- Linting (ESLint)
- Security scanning
- Test suite (all tests must pass)
- Code coverage (80%+ required)

### Stage 6: /ship
Create pull request
- Generate PR body with context
- Reference Beads issues
- Include test coverage metrics

### Stage 7: /review
Address ALL PR feedback
- GitHub Actions failures
- Code review comments
- AI review tools
- Resolve all comment threads

### Stage 8: /merge
Merge and cleanup
- Update documentation
- Merge PR (squash commits)
- Delete feature branch
- Close Beads issues

### Stage 9: /verify
Final documentation verification
- Verify all docs updated
- Check for broken links
- Validate code examples

## TDD Requirements

**MANDATORY**:
- Write test FIRST (RED phase)
- Implement minimal code to pass (GREEN phase)
- Refactor and commit (REFACTOR phase)
- No code changes without corresponding tests

## Tech Stack

${meta.language ? `- **Language**: ${meta.language}` : '- **Language**: JavaScript'}
- **Package Manager**: ${packageManager}
- **Testing**: TDD-first approach
- **Security**: OWASP Top 10 compliance
- **Version Control**: Git with conventional commits

## Security

For every new feature, analyze OWASP Top 10:
- A01: Broken Access Control
- A02: Cryptographic Failures
- A03: Injection
- A04: Insecure Design
- A05: Security Misconfiguration
- A06: Vulnerable and Outdated Components
- A07: Authentication Failures
- A08: Software and Data Integrity Failures
- A09: Security Logging and Monitoring Failures
- A10: Server-Side Request Forgery (SSRF)
`;
}

/**
 * Generate Aider configuration file
 * @param {string} projectPath - Path to the project root
 * @param {Object} options - Generation options
 * @param {boolean} options.overwrite - Whether to overwrite existing files (default: false)
 * @returns {Promise<void>}
 */
async function generateAiderConfig(projectPath, options = {}) {
  const { overwrite = false } = options;

  // Detect project metadata
  const projectMeta = await detectProjectMetadata(projectPath);

  const aiderConfPath = path.join(projectPath, '.aider.conf.yml');

  // Check if file exists
  const exists = await fs.promises.access(aiderConfPath).then(() => true).catch(() => false);
  if (exists && !overwrite) {
    return; // Don't overwrite
  }

  // Generate .aider.conf.yml content (YAML format)
  const content = generateAiderConfContent(projectMeta);

  await fs.promises.writeFile(aiderConfPath, content, 'utf-8');
}

/**
 * Generate .aider.conf.yml content
 */
function generateAiderConfContent(meta) {
  return `# Aider Configuration for Forge Workflow

# System prompt with Forge 9-Stage TDD Workflow
system-prompt: |
  You are working on a project using the Forge 9-Stage TDD Workflow.

  MANDATORY: Follow TDD (Test-Driven Development):
  - RED: Write failing test FIRST
  - GREEN: Implement minimal code to pass
  - REFACTOR: Clean up and optimize
  - Commit after each GREEN cycle

  Workflow Stages:
  1. /status - Check current context and active work
  2. /research - Deep research with OWASP Top 10 security analysis
  3. /plan - Create formal implementation plan
  4. /dev - TDD development (RED-GREEN-REFACTOR)
  5. /check - Validation (type/lint/tests/security)
  6. /ship - Create pull request with documentation
  7. /review - Address ALL PR feedback
  8. /merge - Merge and cleanup
  9. /verify - Final documentation verification

  Security: Analyze OWASP Top 10 for every new feature.
  Documentation: Update progressively, not at the end.
  Git: Use conventional commits (feat:, fix:, test:, refactor:).

# Auto-commit after successful changes
auto-commits: true

# Commit message format
commit-message-template: |
  {message}

  Co-Authored-By: Aider <noreply@aider.chat>

# Show diffs before committing
show-diffs: true

# Git add/commit behavior
git-add-auto: true

# Editor for complex prompts
editor: null

# Model configuration (can be overridden)
# model: gpt-4
# model: claude-sonnet-4-20250514

# Test command
test-cmd: "${meta.testCommand || 'npm test'}"

# Lint command
lint-cmd: "npm run lint"
`;
}

/**
 * Generate OpenCode configuration files
 * @param {string} projectPath - Path to the project root
 * @param {Object} options - Generation options
 * @param {boolean} options.overwrite - Whether to overwrite existing files (default: false)
 * @returns {Promise<void>}
 */
async function generateOpenCodeConfig(projectPath, options = {}) {
  const { overwrite = false } = options;

  // Detect project metadata
  const projectMeta = await detectProjectMetadata(projectPath);

  // Create .opencode/agents directory
  const opencodeDir = path.join(projectPath, '.opencode');
  const agentsDir = path.join(opencodeDir, 'agents');
  await fs.promises.mkdir(agentsDir, { recursive: true });

  // Helper to write file if it doesn't exist or overwrite is true
  const writeIfNeeded = async (filePath, content) => {
    const exists = await fs.promises.access(filePath).then(() => true).catch(() => false);
    if (!exists || overwrite) {
      await fs.promises.writeFile(filePath, content, 'utf-8');
    }
  };

  // 1. Create opencode.json
  const opencodeJsonPath = path.join(projectPath, 'opencode.json');
  const opencodeJsonContent = generateOpenCodeJsonContent(projectMeta);
  await writeIfNeeded(opencodeJsonPath, opencodeJsonContent);

  // 2. Create .opencode/agents/plan-review.md
  const planAgentPath = path.join(agentsDir, 'plan-review.md');
  const planAgentContent = generateOpenCodePlanAgentContent();
  await writeIfNeeded(planAgentPath, planAgentContent);

  // 3. Create .opencode/agents/tdd-build.md
  const buildAgentPath = path.join(agentsDir, 'tdd-build.md');
  const buildAgentContent = generateOpenCodeBuildAgentContent();
  await writeIfNeeded(buildAgentPath, buildAgentContent);
}

/**
 * Generate opencode.json content
 */
function generateOpenCodeJsonContent(_meta) {
  return JSON.stringify({
    "$schema": "https://opencode.ai/config.json",
    "agent": {
      "build": {
        "mode": "primary",
        "model": "anthropic/claude-sonnet-4-20250514",
        "tools": {
          "write": true,
          "edit": true,
          "bash": true
        }
      },
      "plan": {
        "mode": "primary",
        "model": "anthropic/claude-haiku-4-20250514",
        "tools": {
          "write": false,
          "edit": false,
          "bash": false
        }
      }
    },
    "mcp_servers": {
      "parallel-ai": {
        "type": "stdio",
        "command": "npx",
        "args": ["-y", "@parallel-ai/mcp-server"],
        "env": {
          "API_KEY": "${env:PARALLEL_AI_TOKEN}"
        }
      },
      "context7": {
        "type": "stdio",
        "command": "npx",
        "args": ["-y", "@context7/mcp-server"]
      }
    }
  }, null, 2);
}

/**
 * Generate .opencode/agents/plan-review.md content
 */
function generateOpenCodePlanAgentContent() {
  return `---
description: Read-only planning and analysis
mode: subagent
model: anthropic/claude-sonnet-4-20250514
temperature: 0.1
tools:
  write: false
  edit: false
  bash: false
---

# Planning & Review Agent

You are in **planning mode** for the Forge 9-Stage TDD Workflow.

## Your Role

Focus on:
- Understanding requirements thoroughly
- Researching existing patterns in the codebase
- Creating detailed implementation plans
- Identifying test scenarios upfront
- Analyzing OWASP Top 10 security considerations
- **NO code changes allowed** - planning only

## Forge Planning Stages

### Stage 2: /research
- Use web search for best practices
- Document findings in \`docs/research/<feature-slug>.md\`
- Include security analysis (OWASP Top 10)
- Extract test scenarios

### Stage 3: /plan
- Create detailed plan in \`.claude/plans/<feature-slug>.md\`
- Break down into TDD cycles (RED-GREEN-REFACTOR)
- Identify files to create/modify
- Document dependencies and risks

## Output Format

Your plan should include:
1. **Requirements Summary** - What needs to be built
2. **Test Scenarios** - All tests to write (RED phase)
3. **Implementation Steps** - Minimal code to pass tests (GREEN phase)
4. **Security Analysis** - OWASP Top 10 relevant risks
5. **Files Affected** - List of files to create/modify
6. **Verification** - How to test end-to-end

**Remember**: You are read-only. No code changes. Planning only.
`;
}

/**
 * Generate .opencode/agents/tdd-build.md content
 */
function generateOpenCodeBuildAgentContent() {
  return `---
description: TDD implementation with full tools
mode: primary
model: anthropic/claude-sonnet-4-20250514
temperature: 0
tools:
  write: true
  edit: true
  bash: true
---

# TDD Build Agent

You are in **implementation mode** for the Forge 9-Stage TDD Workflow.

## MANDATORY TDD Process

**RED-GREEN-REFACTOR** - No exceptions:

### RED Phase
1. Write failing test FIRST
2. Run test to confirm it fails for the right reason
3. Commit: \`git commit -m "test: add [feature] tests (RED)"\`

### GREEN Phase
1. Write minimal code to make the test pass
2. Keep implementation simple
3. Don't add features not covered by tests
4. Commit: \`git commit -m "feat: implement [feature] (GREEN)"\`

### REFACTOR Phase
1. Clean up code while keeping tests green
2. Extract helpers, remove duplication
3. Commit: \`git commit -m "refactor: [description]"\`

## Forge Development Stages

### Stage 4: /dev
Implement features using TDD:
- Follow RED-GREEN-REFACTOR for each feature
- Commit after each GREEN cycle
- Push regularly to remote

### Stage 5: /check
Validate before creating PR:
- Type checking (TypeScript strict mode)
- Linting (ESLint - no errors)
- Security scanning (npm audit)
- Test suite (all must pass)
- Code coverage (80%+ required)

## Security

For every feature, check OWASP Top 10:
- Input validation
- Output sanitization
- Authentication/Authorization
- Cryptography
- Dependency vulnerabilities

## Quality Standards

- Tests written BEFORE implementation
- 80%+ code coverage
- No ESLint errors
- Security vulnerabilities addressed
- Documentation updated progressively
`;
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
- \`/research\` - Deep research with web search
- \`/plan\` - Create implementation plan
- \`/dev\` - TDD development
- \`/check\` - Run all validation checks

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

**Compatibility**: ✅ Growing (Claude Code, GitHub Copilot, Cursor, OpenCode support MCP)

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
├── .mcp.json              # MCP servers (Claude, Copilot, Cursor, OpenCode)
├── .claude/
│   └── skills/            # Claude-specific skills
├── .github/
│   └── copilot-instructions.md  # Copilot-specific instructions
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
/research feature-name    # Research and document
/plan feature-slug        # Create plan
/dev                      # Implement with TDD
/check                    # Run all checks
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
/research feature-name    # Research and document
/plan feature-slug        # Create plan + branch
/dev                      # Implement with TDD
/check                    # Run all checks
/ship                     # Create PR
/review                   # Address feedback
/merge PR_NUMBER          # Merge after approval
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
- [WORKFLOW.md](./WORKFLOW.md) - Complete workflow guide
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
- ✅ GitHub Copilot (VS Code extension)
- ✅ Cursor
- ✅ OpenCode

## Quick Start

### 1. Install MCP-Compatible Agent

Choose one of the supported agents above.

### 2. Configure MCP Servers

Each agent has a different configuration location:

**Claude Code**: \`.mcp.json\` in project root
**GitHub Copilot**: \`.mcp.json\` in project root (VS Code)
**Cursor**: \`.cursor/mcp.json\`
**OpenCode**: \`opencode.json\` under \`mcp_servers\`

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
- \`/research <feature-name>\` - Automatically uses parallel-ai for web search

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

**Setup for GitHub Copilot** (built-in):
- No configuration needed, included by default in VS Code extension

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

### GitHub Copilot

**File**: \`.mcp.json\` in project root (VS Code)

**Example**:
\`\`\`json
{
  "mcpServers": {
    "context7": {
      "type": "local",
      "command": "npx",
      "args": ["-y", "@context7/mcp-server"]
    }
  }
}
\`\`\`

**Note**: GitHub MCP server is built-in, no config needed

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

### OpenCode

**File**: \`opencode.json\` (add under \`mcp_servers\`)

**Example**:
\`\`\`json
{
  "mcp_servers": {
    "parallel-ai": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@parallel-ai/mcp-server"],
      "env": {
        "API_KEY": "\${env:PARALLEL_AI_TOKEN}"
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

## Setup with Forge

Forge can automatically configure MCP servers during setup:

\`\`\`bash
# Auto-detect agent and configure MCP
bunx forge setup --mcp

# Agent-specific setup with MCP
bunx forge setup --agent=claude --mcp
bunx forge setup --agent=copilot --mcp
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

**GitHub Copilot**:
\`\`\`bash
# In VS Code, ask Copilot: "What's the latest TypeScript syntax?"
# Should fetch from context7
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
  generateCopilotConfig,
  generateCursorConfig,
  generateKiloConfig,
  generateAiderConfig,
  generateOpenCodeConfig,
  generateArchitectureDoc,
  generateConfigurationDoc,
  generateMcpSetupDoc
};
