const fs = require('node:fs');
const path = require('node:path');
const { describe, test, beforeEach, afterEach, expect } = require('bun:test');
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

    expect(exists).toBeTruthy();

    const content = await fs.promises.readFile(kiloMdPath, 'utf-8');

    // Should include Forge workflow
    expect(content.includes('Forge')).toBeTruthy();
    expect(content.includes('9-Stage') || content.includes('9 Stage')).toBeTruthy();

    // Should include all workflow stages
    expect(content.includes('/status')).toBeTruthy();
    expect(content.includes('/plan')).toBeTruthy();
    expect(content.includes('/dev')).toBeTruthy();
    expect(content.includes('/check')).toBeTruthy();

    // Should include TDD guidance
    expect(content.includes('TDD')).toBeTruthy();
  });

  test('should be plain markdown without frontmatter', async () => {
    await generateKiloConfig(tempDir);

    const kiloMdPath = path.join(tempDir, '.kilo.md');
    const content = await fs.promises.readFile(kiloMdPath, 'utf-8');

    // Kilo uses plain markdown
    expect(content.startsWith('#')).toBeTruthy();
  });

  test('should not overwrite existing .kilo.md by default', async () => {
    const kiloMdPath = path.join(tempDir, '.kilo.md');
    const existingContent = '# Custom Kilo Config\n\nDo not overwrite!';
    await fs.promises.writeFile(kiloMdPath, existingContent);

    await generateKiloConfig(tempDir, { overwrite: false });

    const content = await fs.promises.readFile(kiloMdPath, 'utf-8');
    expect(content).toBe(existingContent);
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

    expect(content.includes('TypeScript') || content.includes('bun')).toBeTruthy();
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

    expect(exists).toBeTruthy();

    const content = await fs.promises.readFile(aiderConfPath, 'utf-8');

    // Should be YAML format
    expect(content.includes(':')).toBeTruthy();

    // Should include system prompt or instructions
    expect(content.includes('system-prompt') || content.includes('instructions')).toBeTruthy();
  });

  test('should include Forge workflow in system prompt', async () => {
    await generateAiderConfig(tempDir);

    const aiderConfPath = path.join(tempDir, '.aider.conf.yml');
    const content = await fs.promises.readFile(aiderConfPath, 'utf-8');

    // Should mention Forge workflow
    expect(content.includes('Forge') || content.includes('TDD')).toBeTruthy();
  });

  test('should not overwrite existing .aider.conf.yml by default', async () => {
    const aiderConfPath = path.join(tempDir, '.aider.conf.yml');
    const existingContent = 'model: gpt-4\nsystem-prompt: "Custom prompt"';
    await fs.promises.writeFile(aiderConfPath, existingContent);

    await generateAiderConfig(tempDir, { overwrite: false });

    const content = await fs.promises.readFile(aiderConfPath, 'utf-8');
    expect(content).toBe(existingContent);
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

    expect(exists).toBeTruthy();

    const content = await fs.promises.readFile(opencodeJsonPath, 'utf-8');

    // Should be valid JSON
    const json = JSON.parse(content);
    expect(json).toBeTruthy();
  });

  test('should include agent configuration', async () => {
    await generateOpenCodeConfig(tempDir);

    const opencodeJsonPath = path.join(tempDir, 'opencode.json');
    const content = await fs.promises.readFile(opencodeJsonPath, 'utf-8');
    const json = JSON.parse(content);

    // Should have agent or agents configuration
    expect(json.agent || json.agents).toBeTruthy();
  });

  test('should create .opencode/agents directory', async () => {
    await generateOpenCodeConfig(tempDir);

    const agentsDir = path.join(tempDir, '.opencode', 'agents');
    const exists = await fs.promises.access(agentsDir).then(() => true).catch(() => false);

    expect(exists).toBeTruthy();
  });

  test('should create custom agent files', async () => {
    await generateOpenCodeConfig(tempDir);

    const agentsDir = path.join(tempDir, '.opencode', 'agents');
    const files = await fs.promises.readdir(agentsDir);

    expect(files.length > 0).toBeTruthy();

    // Check for plan agent
    const planAgent = files.find(f => f.includes('plan'));
    expect(planAgent).toBeTruthy();
  });

  test('should create plan-review.md agent', async () => {
    await generateOpenCodeConfig(tempDir);

    const planAgentPath = path.join(tempDir, '.opencode', 'agents', 'plan-review.md');
    const exists = await fs.promises.access(planAgentPath).then(() => true).catch(() => false);

    expect(exists).toBeTruthy();

    const content = await fs.promises.readFile(planAgentPath, 'utf-8');

    // Should have frontmatter
    expect(content.startsWith('---')).toBeTruthy();
    expect(content.includes('description:')).toBeTruthy();

    // Should mention planning
    expect(content.includes('plan') || content.includes('Plan')).toBeTruthy();
  });

  test('should not overwrite existing opencode.json by default', async () => {
    const opencodeJsonPath = path.join(tempDir, 'opencode.json');
    const existingContent = JSON.stringify({ custom: 'config' }, null, 2);
    await fs.promises.writeFile(opencodeJsonPath, existingContent);

    await generateOpenCodeConfig(tempDir, { overwrite: false });

    const content = await fs.promises.readFile(opencodeJsonPath, 'utf-8');
    expect(content).toBe(existingContent);
  });

  test('should include MCP server configuration', async () => {
    await generateOpenCodeConfig(tempDir);

    const opencodeJsonPath = path.join(tempDir, 'opencode.json');
    const content = await fs.promises.readFile(opencodeJsonPath, 'utf-8');
    const json = JSON.parse(content);

    // Should have mcp_servers configuration
    expect(json.mcp_servers).toBeTruthy();
  });
});
