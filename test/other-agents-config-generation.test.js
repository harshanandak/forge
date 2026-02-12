const fs = require('node:fs');
const path = require('node:path');
const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');

// Module under test
const { generateKiloConfig, generateAiderConfig, generateOpenCodeConfig } = require('../lib/agents-config');

describe('Kilo Code config generation', () => {
  let tempDir;

  beforeEach(async () => {
    tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'forge-test-'));
  });

  afterEach(async () => {
    if (tempDir) {
      await fs.promises.rm(tempDir, { recursive: true, force: true });
    }
  });

  test('should create .kilo.md file', async () => {
    await generateKiloConfig(tempDir);

    const kiloMdPath = path.join(tempDir, '.kilo.md');
    const exists = await fs.promises.access(kiloMdPath).then(() => true).catch(() => false);

    assert.ok(exists, '.kilo.md should be created');

    const content = await fs.promises.readFile(kiloMdPath, 'utf-8');

    // Should include Forge workflow
    assert.ok(content.includes('Forge'), 'Should mention Forge');
    assert.ok(content.includes('9-Stage') || content.includes('9 Stage'), 'Should mention 9-stage workflow');

    // Should include all workflow stages
    assert.ok(content.includes('/status'), 'Should include /status');
    assert.ok(content.includes('/plan'), 'Should include /plan');
    assert.ok(content.includes('/dev'), 'Should include /dev');
    assert.ok(content.includes('/check'), 'Should include /check');

    // Should include TDD guidance
    assert.ok(content.includes('TDD'), 'Should include TDD');
  });

  test('should be plain markdown without frontmatter', async () => {
    await generateKiloConfig(tempDir);

    const kiloMdPath = path.join(tempDir, '.kilo.md');
    const content = await fs.promises.readFile(kiloMdPath, 'utf-8');

    // Kilo uses plain markdown
    assert.ok(content.startsWith('#'), 'Should start with markdown heading, not frontmatter');
  });

  test('should not overwrite existing .kilo.md by default', async () => {
    const kiloMdPath = path.join(tempDir, '.kilo.md');
    const existingContent = '# Custom Kilo Config\n\nDo not overwrite!';
    await fs.promises.writeFile(kiloMdPath, existingContent);

    await generateKiloConfig(tempDir, { overwrite: false });

    const content = await fs.promises.readFile(kiloMdPath, 'utf-8');
    assert.strictEqual(content, existingContent, 'Should not overwrite when overwrite=false');
  });

  test('should include project metadata', async () => {
    const packageJson = {
      name: 'test-project',
      dependencies: { typescript: '^5.0.0' },
      scripts: { test: 'bun test' }
    };
    await fs.promises.writeFile(path.join(tempDir, 'package.json'), JSON.stringify(packageJson));

    await generateKiloConfig(tempDir);

    const kiloMdPath = path.join(tempDir, '.kilo.md');
    const content = await fs.promises.readFile(kiloMdPath, 'utf-8');

    assert.ok(content.includes('TypeScript') || content.includes('bun'), 'Should include project metadata');
  });
});

describe('Aider config generation', () => {
  let tempDir;

  beforeEach(async () => {
    tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'forge-test-'));
  });

  afterEach(async () => {
    if (tempDir) {
      await fs.promises.rm(tempDir, { recursive: true, force: true });
    }
  });

  test('should create .aider.conf.yml file', async () => {
    await generateAiderConfig(tempDir);

    const aiderConfPath = path.join(tempDir, '.aider.conf.yml');
    const exists = await fs.promises.access(aiderConfPath).then(() => true).catch(() => false);

    assert.ok(exists, '.aider.conf.yml should be created');

    const content = await fs.promises.readFile(aiderConfPath, 'utf-8');

    // Should be YAML format
    assert.ok(content.includes(':'), 'Should be YAML format with key:value pairs');

    // Should include system prompt or instructions
    assert.ok(content.includes('system-prompt') || content.includes('instructions'),
      'Should include system prompt or instructions field');
  });

  test('should include Forge workflow in system prompt', async () => {
    await generateAiderConfig(tempDir);

    const aiderConfPath = path.join(tempDir, '.aider.conf.yml');
    const content = await fs.promises.readFile(aiderConfPath, 'utf-8');

    // Should mention Forge workflow
    assert.ok(content.includes('Forge') || content.includes('TDD'),
      'Should include Forge workflow or TDD guidance');
  });

  test('should not overwrite existing .aider.conf.yml by default', async () => {
    const aiderConfPath = path.join(tempDir, '.aider.conf.yml');
    const existingContent = 'model: gpt-4\nsystem-prompt: "Custom prompt"';
    await fs.promises.writeFile(aiderConfPath, existingContent);

    await generateAiderConfig(tempDir, { overwrite: false });

    const content = await fs.promises.readFile(aiderConfPath, 'utf-8');
    assert.strictEqual(content, existingContent, 'Should not overwrite when overwrite=false');
  });
});

describe('OpenCode config generation', () => {
  let tempDir;

  beforeEach(async () => {
    tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'forge-test-'));
  });

  afterEach(async () => {
    if (tempDir) {
      await fs.promises.rm(tempDir, { recursive: true, force: true });
    }
  });

  test('should create opencode.json file', async () => {
    await generateOpenCodeConfig(tempDir);

    const opencodeJsonPath = path.join(tempDir, 'opencode.json');
    const exists = await fs.promises.access(opencodeJsonPath).then(() => true).catch(() => false);

    assert.ok(exists, 'opencode.json should be created');

    const content = await fs.promises.readFile(opencodeJsonPath, 'utf-8');

    // Should be valid JSON
    const json = JSON.parse(content);
    assert.ok(json, 'Should be valid JSON');
  });

  test('should include agent configuration', async () => {
    await generateOpenCodeConfig(tempDir);

    const opencodeJsonPath = path.join(tempDir, 'opencode.json');
    const content = await fs.promises.readFile(opencodeJsonPath, 'utf-8');
    const json = JSON.parse(content);

    // Should have agent or agents configuration
    assert.ok(json.agent || json.agents, 'Should include agent configuration');
  });

  test('should create .opencode/agents directory', async () => {
    await generateOpenCodeConfig(tempDir);

    const agentsDir = path.join(tempDir, '.opencode', 'agents');
    const exists = await fs.promises.access(agentsDir).then(() => true).catch(() => false);

    assert.ok(exists, '.opencode/agents directory should be created');
  });

  test('should create custom agent files', async () => {
    await generateOpenCodeConfig(tempDir);

    const agentsDir = path.join(tempDir, '.opencode', 'agents');
    const files = await fs.promises.readdir(agentsDir);

    assert.ok(files.length > 0, 'Should create at least one custom agent file');

    // Check for plan agent
    const planAgent = files.find(f => f.includes('plan'));
    assert.ok(planAgent, 'Should include plan agent');
  });

  test('should create plan-review.md agent', async () => {
    await generateOpenCodeConfig(tempDir);

    const planAgentPath = path.join(tempDir, '.opencode', 'agents', 'plan-review.md');
    const exists = await fs.promises.access(planAgentPath).then(() => true).catch(() => false);

    assert.ok(exists, 'plan-review.md should be created');

    const content = await fs.promises.readFile(planAgentPath, 'utf-8');

    // Should have frontmatter
    assert.ok(content.startsWith('---'), 'Should have YAML frontmatter');
    assert.ok(content.includes('description:'), 'Should include description');

    // Should mention planning
    assert.ok(content.includes('plan') || content.includes('Plan'), 'Should mention planning');
  });

  test('should not overwrite existing opencode.json by default', async () => {
    const opencodeJsonPath = path.join(tempDir, 'opencode.json');
    const existingContent = JSON.stringify({ custom: 'config' }, null, 2);
    await fs.promises.writeFile(opencodeJsonPath, existingContent);

    await generateOpenCodeConfig(tempDir, { overwrite: false });

    const content = await fs.promises.readFile(opencodeJsonPath, 'utf-8');
    assert.strictEqual(content, existingContent, 'Should not overwrite when overwrite=false');
  });

  test('should include MCP server configuration', async () => {
    await generateOpenCodeConfig(tempDir);

    const opencodeJsonPath = path.join(tempDir, 'opencode.json');
    const content = await fs.promises.readFile(opencodeJsonPath, 'utf-8');
    const json = JSON.parse(content);

    // Should have mcp_servers configuration
    assert.ok(json.mcp_servers, 'Should include mcp_servers configuration');
  });
});
