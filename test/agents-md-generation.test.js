const fs = require('node:fs');
const path = require('node:path');
const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
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

    assert.ok(exists, 'AGENTS.md should be created');

    const content = await fs.promises.readFile(agentsMdPath, 'utf-8');

    // Verify it contains Forge 9-stage workflow
    assert.ok(content.includes('Forge 9-Stage TDD Workflow'), 'Should document 9-stage workflow');
    assert.ok(content.includes('/status'), 'Should include /status command');
    assert.ok(content.includes('/research'), 'Should include /research command');
    assert.ok(content.includes('/plan'), 'Should include /plan command');
    assert.ok(content.includes('/dev'), 'Should include /dev command');
    assert.ok(content.includes('/check'), 'Should include /check command');
    assert.ok(content.includes('/ship'), 'Should include /ship command');
    assert.ok(content.includes('/review'), 'Should include /review command');
    assert.ok(content.includes('/merge'), 'Should include /merge command');
    assert.ok(content.includes('/verify'), 'Should include /verify command');

    // Verify it mentions all Tier 1 agents
    assert.ok(content.includes('Claude Code'), 'Should mention Claude Code');
    assert.ok(content.includes('GitHub Copilot'), 'Should mention GitHub Copilot');
    assert.ok(content.includes('Kilo Code'), 'Should mention Kilo Code');
    assert.ok(content.includes('Cursor'), 'Should mention Cursor');
    assert.ok(content.includes('Aider'), 'Should mention Aider');

    // Verify it contains TDD guidance
    assert.ok(content.includes('TDD'), 'Should include TDD guidance');
    assert.ok(content.includes('RED-GREEN-REFACTOR'), 'Should include RED-GREEN-REFACTOR cycle');
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
    assert.ok(content.includes('TypeScript'), 'Should mention TypeScript in stack');

    // Should include project commands
    assert.ok(content.includes('bun test') || content.includes('test'), 'Should document test command');
  });

  test('should be plain markdown with no complex frontmatter', async () => {
    await generateAgentsMd(tempDir);

    const agentsMdPath = path.join(tempDir, 'AGENTS.md');
    const content = await fs.promises.readFile(agentsMdPath, 'utf-8');

    // Should NOT start with YAML frontmatter (---) as that's agent-specific
    // Universal AGENTS.md is plain markdown
    const lines = content.split('\n');
    assert.notEqual(lines[0], '---', 'Universal AGENTS.md should not have YAML frontmatter');

    // Should start with a heading
    assert.ok(lines[0].startsWith('#'), 'Should start with a markdown heading');
  });

  test('should include security guidance (OWASP Top 10)', async () => {
    await generateAgentsMd(tempDir);

    const agentsMdPath = path.join(tempDir, 'AGENTS.md');
    const content = await fs.promises.readFile(agentsMdPath, 'utf-8');

    assert.ok(content.includes('OWASP') || content.includes('security'), 'Should include security guidance');
  });

  test('should document MCP server usage', async () => {
    await generateAgentsMd(tempDir);

    const agentsMdPath = path.join(tempDir, 'AGENTS.md');
    const content = await fs.promises.readFile(agentsMdPath, 'utf-8');

    assert.ok(content.includes('MCP') || content.includes('Model Context Protocol'), 'Should mention MCP servers');
  });
});
