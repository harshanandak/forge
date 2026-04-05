const fs = require('node:fs');
const path = require('node:path');
const { describe, test, beforeEach, afterEach, expect } = require('bun:test');
const os = require('node:os');

const { generateKiloConfig, generateOpenCodeConfig } = require('../lib/agents-config');

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

  test('should create native .kilocode workflow, rules, and skill files', async () => {
    await generateKiloConfig(tempDir);

    const workflowPath = path.join(tempDir, '.kilocode', 'workflows', 'forge-workflow.md');
    const rulesPath = path.join(tempDir, '.kilocode', 'rules', 'workflow.md');
    const skillPath = path.join(tempDir, '.kilocode', 'skills', 'forge-workflow', 'SKILL.md');
    const legacyPath = path.join(tempDir, '.kilo.md');

    expect(await fs.promises.access(workflowPath).then(() => true).catch(() => false)).toBeTruthy();
    expect(await fs.promises.access(rulesPath).then(() => true).catch(() => false)).toBeTruthy();
    expect(await fs.promises.access(skillPath).then(() => true).catch(() => false)).toBeTruthy();
    expect(await fs.promises.access(legacyPath).then(() => true).catch(() => false)).toBeFalsy();

    const content = await fs.promises.readFile(workflowPath, 'utf-8');
    expect(content.includes('Forge')).toBeTruthy();
    expect(content.includes('7-Stage') || content.includes('7 Stage')).toBeTruthy();
    expect(content.includes('/status')).toBeTruthy();
    expect(content.includes('/plan')).toBeTruthy();
    expect(content.includes('/dev')).toBeTruthy();
    expect(content.includes('/validate')).toBeTruthy();
    expect(content.includes('TDD')).toBeTruthy();
  });

  test('should generate markdown-based native Kilo surfaces', async () => {
    await generateKiloConfig(tempDir);

    const workflowContent = await fs.promises.readFile(
      path.join(tempDir, '.kilocode', 'workflows', 'forge-workflow.md'),
      'utf-8'
    );
    const rulesContent = await fs.promises.readFile(
      path.join(tempDir, '.kilocode', 'rules', 'workflow.md'),
      'utf-8'
    );
    const skillContent = await fs.promises.readFile(
      path.join(tempDir, '.kilocode', 'skills', 'forge-workflow', 'SKILL.md'),
      'utf-8'
    );

    expect(workflowContent.startsWith('---')).toBeTruthy();
    expect(rulesContent.startsWith('---')).toBeTruthy();
    expect(skillContent.startsWith('---')).toBeTruthy();
  });

  test('should not overwrite existing native Kilo workflow by default', async () => {
    const workflowPath = path.join(tempDir, '.kilocode', 'workflows', 'forge-workflow.md');
    const existingContent = '---\ndescription: "Custom Kilo workflow"\n---\n# Keep me';
    await fs.promises.mkdir(path.dirname(workflowPath), { recursive: true });
    await fs.promises.writeFile(workflowPath, existingContent);

    await generateKiloConfig(tempDir, { overwrite: false });

    const content = await fs.promises.readFile(workflowPath, 'utf-8');
    expect(content).toBe(existingContent);
  });

  test('should include project metadata in native Kilo workflow', async () => {
    const packageJson = {
      name: 'test-project',
      dependencies: { typescript: '^5.0.0' },
      scripts: { test: 'bun test' }
    };
    await fs.promises.writeFile(path.join(tempDir, 'package.json'), JSON.stringify(packageJson));

    await generateKiloConfig(tempDir);

    const workflowPath = path.join(tempDir, '.kilocode', 'workflows', 'forge-workflow.md');
    const content = await fs.promises.readFile(workflowPath, 'utf-8');

    expect(content.includes('TypeScript') || content.includes('bun')).toBeTruthy();
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
    const json = JSON.parse(content);
    expect(json).toBeTruthy();
  });

  test('should include agent configuration', async () => {
    await generateOpenCodeConfig(tempDir);

    const opencodeJsonPath = path.join(tempDir, 'opencode.json');
    const content = await fs.promises.readFile(opencodeJsonPath, 'utf-8');
    const json = JSON.parse(content);

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

    const planAgent = files.find((file) => file.includes('plan'));
    expect(planAgent).toBeTruthy();
  });

  test('should create plan-review.md agent', async () => {
    await generateOpenCodeConfig(tempDir);

    const planAgentPath = path.join(tempDir, '.opencode', 'agents', 'plan-review.md');
    const exists = await fs.promises.access(planAgentPath).then(() => true).catch(() => false);

    expect(exists).toBeTruthy();

    const content = await fs.promises.readFile(planAgentPath, 'utf-8');

    expect(content.startsWith('---')).toBeTruthy();
    expect(content.includes('description:')).toBeTruthy();
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

    expect(json.mcp_servers).toBeTruthy();
  });
});
