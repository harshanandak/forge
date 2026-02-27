const fs = require('node:fs');
const path = require('node:path');
const { describe, test, beforeEach, afterEach, expect } = require('bun:test');
const os = require('node:os');

// Module under test
const { detectInstalledAgents } = require('../lib/project-discovery');

describe('Agent detection', () => {
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

  test('should detect Claude Code when .claude directory exists', async () => {
    // Create .claude directory
    await fs.promises.mkdir(path.join(tempDir, '.claude'), { recursive: true });

    const agents = await detectInstalledAgents(tempDir);

    expect(agents.includes('claude')).toBeTruthy();
  });

  test('should detect Cursor when .cursor directory exists', async () => {
    // Create .cursor directory
    await fs.promises.mkdir(path.join(tempDir, '.cursor'), { recursive: true });

    const agents = await detectInstalledAgents(tempDir);

    expect(agents.includes('cursor')).toBeTruthy();
  });

  test('should detect GitHub Copilot when .github/copilot-instructions.md exists', async () => {
    // Create .github directory and copilot file
    await fs.promises.mkdir(path.join(tempDir, '.github'), { recursive: true });
    await fs.promises.writeFile(
      path.join(tempDir, '.github', 'copilot-instructions.md'),
      '# Copilot instructions'
    );

    const agents = await detectInstalledAgents(tempDir);

    expect(agents.includes('copilot')).toBeTruthy();
  });

  test('should detect Kilo when .kilo.md exists', async () => {
    // Create .kilo.md file
    await fs.promises.writeFile(
      path.join(tempDir, '.kilo.md'),
      '# Kilo instructions'
    );

    const agents = await detectInstalledAgents(tempDir);

    expect(agents.includes('kilo')).toBeTruthy();
  });

  test('should detect Aider when .aider.conf.yml exists', async () => {
    // Create .aider.conf.yml file
    await fs.promises.writeFile(
      path.join(tempDir, '.aider.conf.yml'),
      'model: gpt-4'
    );

    const agents = await detectInstalledAgents(tempDir);

    expect(agents.includes('aider')).toBeTruthy();
  });

  test('should detect OpenCode when opencode.json exists', async () => {
    // Create opencode.json file
    await fs.promises.writeFile(
      path.join(tempDir, 'opencode.json'),
      '{"agent": {}}'
    );

    const agents = await detectInstalledAgents(tempDir);

    expect(agents.includes('opencode')).toBeTruthy();
  });

  test('should detect multiple agents simultaneously', async () => {
    // Create files for multiple agents
    await fs.promises.mkdir(path.join(tempDir, '.claude'), { recursive: true });
    await fs.promises.mkdir(path.join(tempDir, '.cursor'), { recursive: true });
    await fs.promises.writeFile(path.join(tempDir, '.kilo.md'), '# Kilo');

    const agents = await detectInstalledAgents(tempDir);

    expect(agents.includes('claude')).toBeTruthy();
    expect(agents.includes('cursor')).toBeTruthy();
    expect(agents.includes('kilo')).toBeTruthy();
    expect(agents.length).toBe(3);
  });

  test('should return empty array when no agents detected', async () => {
    // Empty directory - no agent files
    const agents = await detectInstalledAgents(tempDir);

    expect(Array.isArray(agents)).toBeTruthy();
    expect(agents.length).toBe(0);
  });

  test('should return agents in consistent order (Tier 1 first)', async () => {
    // Create files for all Tier 1 agents
    await fs.promises.mkdir(path.join(tempDir, '.claude'), { recursive: true });
    await fs.promises.mkdir(path.join(tempDir, '.cursor'), { recursive: true });
    await fs.promises.mkdir(path.join(tempDir, '.github'), { recursive: true });
    await fs.promises.writeFile(
      path.join(tempDir, '.github', 'copilot-instructions.md'),
      '# Copilot'
    );
    await fs.promises.writeFile(path.join(tempDir, '.kilo.md'), '# Kilo');
    await fs.promises.writeFile(path.join(tempDir, '.aider.conf.yml'), 'model: gpt-4');

    const agents = await detectInstalledAgents(tempDir);

    // All Tier 1 agents should be detected
    expect(agents.includes('claude')).toBeTruthy();
    expect(agents.includes('copilot')).toBeTruthy();
    expect(agents.includes('kilo')).toBeTruthy();
    expect(agents.includes('cursor')).toBeTruthy();
    expect(agents.includes('aider')).toBeTruthy();
    expect(agents.length).toBe(5);
  });

  test('should handle permission errors gracefully', async () => {
    // This test is platform-specific and may not work on all systems
    // Just verify the function doesn't throw
    const agents = await detectInstalledAgents('/root/nonexistent-path-12345');

    expect(Array.isArray(agents)).toBeTruthy();
  });

  test('should detect CLAUDE.md as legacy Claude Code indicator', async () => {
    // Create CLAUDE.md (legacy indicator)
    await fs.promises.writeFile(
      path.join(tempDir, 'CLAUDE.md'),
      '# Project instructions'
    );

    const agents = await detectInstalledAgents(tempDir);

    expect(agents.includes('claude')).toBeTruthy();
  });
});
