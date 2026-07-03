const fs = require('node:fs');
const path = require('node:path');
const { describe, test, beforeEach, afterEach, expect } = require('bun:test');

const os = require('node:os');

// Module under test
const { generateAgentsMd } = require('../lib/agents-config');

describe('AGENTS.md generation', () => {
  let tempDir;

  beforeEach(async () => {
    // Create temporary directory for testing
    tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'forge-test-'));
  });

  afterEach(async () => {
    // Cleanup temporary directory
    if (tempDir) {
      await fs.promises.rm(tempDir, { recursive: true, force: true });
    }
  });

  test('should generate universal AGENTS.md for all Tier 1 agents', async () => {
    await generateAgentsMd(tempDir);

    const agentsMdPath = path.join(tempDir, 'AGENTS.md');
    const exists = await fs.promises.access(agentsMdPath).then(() => true).catch(() => false);

    expect(exists).toBeTruthy();

    const content = await fs.promises.readFile(agentsMdPath, 'utf-8');

    // Verify it contains the Forge workflow template
    expect(content.includes('Forge TDD Workflow Template')).toBeTruthy();
    expect(content.includes('/status')).toBeTruthy();
    expect(content.includes('/plan')).toBeTruthy();
    expect(content.includes('/dev')).toBeTruthy();
    expect(content.includes('/validate')).toBeTruthy();
    expect(content.includes('/ship')).toBeTruthy();
    expect(content.includes('/review')).toBeTruthy();
    // Pre-merge is an embedded documentation gate inside /ship and /review — NOT a
    // numbered stage or a standalone /premerge command. The generated AGENTS.md must
    // present the gate model, never emit a /premerge stage/command.
    expect(content.includes('/premerge')).toBeFalsy();
    expect(content).toMatch(/pre-merge gate/i);
    expect(content.includes('/verify')).toBeTruthy();

    // Verify it mentions supported Tier 1 agents
    expect(content.includes('Claude Code')).toBeTruthy();
    expect(content.includes('Codex')).toBeTruthy();
    expect(content.includes('Cursor')).toBeTruthy();

    // Verify it contains TDD guidance
    expect(content.includes('TDD')).toBeTruthy();
    expect(content.includes('RED-GREEN-REFACTOR')).toBeTruthy();
  });

  test('should include project-specific metadata in AGENTS.md', async () => {
    // Create a mock package.json
    const packageJson = {
      name: 'test-project',
      version: '1.0.0',
      dependencies: {
        typescript: '^5.0.0'
      },
      scripts: {
        test: 'bun test',
        build: 'bun run build'
      }
    };

    await fs.promises.writeFile(
      path.join(tempDir, 'package.json'),
      JSON.stringify(packageJson, null, 2)
    );

    await generateAgentsMd(tempDir);

    const agentsMdPath = path.join(tempDir, 'AGENTS.md');
    const content = await fs.promises.readFile(agentsMdPath, 'utf-8');

    // Should detect TypeScript
    expect(content.includes('TypeScript')).toBeTruthy();

    // Should include project commands
    expect(content.includes('bun test') || content.includes('test')).toBeTruthy();
  });

  test('should be plain markdown with no complex frontmatter', async () => {
    await generateAgentsMd(tempDir);

    const agentsMdPath = path.join(tempDir, 'AGENTS.md');
    const content = await fs.promises.readFile(agentsMdPath, 'utf-8');

    // Should NOT start with YAML frontmatter (---) as that's agent-specific
    // Universal AGENTS.md is plain markdown
    const lines = content.split('\n');
    expect(lines[0]).not.toBe('---');

    // Should start with a heading
    expect(lines[0].startsWith('#')).toBeTruthy();
  });

  test('should include security guidance (OWASP Top 10)', async () => {
    await generateAgentsMd(tempDir);

    const agentsMdPath = path.join(tempDir, 'AGENTS.md');
    const content = await fs.promises.readFile(agentsMdPath, 'utf-8');

    expect(content.includes('OWASP') || content.includes('security')).toBeTruthy();
  });

  test('should document MCP server usage', async () => {
    await generateAgentsMd(tempDir);

    const agentsMdPath = path.join(tempDir, 'AGENTS.md');
    const content = await fs.promises.readFile(agentsMdPath, 'utf-8');

    expect(content.includes('MCP') || content.includes('Model Context Protocol')).toBeTruthy();
  });

  test('should not mention removed agents', async () => {
    await generateAgentsMd(tempDir);

    const agentsMdPath = path.join(tempDir, 'AGENTS.md');
    const content = await fs.promises.readFile(agentsMdPath, 'utf-8');

    expect(content.includes('Copilot')).toBeFalsy();
    expect(content.includes('OpenCode')).toBeFalsy();
    expect(content.includes('Kilo')).toBeFalsy();
    expect(content.includes('Cline')).toBeFalsy();
    expect(content.includes('Roo')).toBeFalsy();
  });
});
