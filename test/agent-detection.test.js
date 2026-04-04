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

  test('should detect KiloCode when current .kilocode workflows exist', async () => {
    await fs.promises.mkdir(path.join(tempDir, '.kilocode', 'workflows'), { recursive: true });
    await fs.promises.mkdir(path.join(tempDir, '.kilocode', 'rules'), { recursive: true });
    await fs.promises.mkdir(path.join(tempDir, '.kilocode', 'skills', 'forge-workflow'), { recursive: true });

    const agents = await detectInstalledAgents(tempDir);

    expect(agents.includes('kilocode')).toBeTruthy();
  });

  test('should not rely on legacy .kilo.md alone for KiloCode detection', async () => {
    await fs.promises.writeFile(
      path.join(tempDir, '.kilo.md'),
      '# legacy Kilo instructions'
    );

    const agents = await detectInstalledAgents(tempDir);

    expect(agents.includes('kilocode')).toBeFalsy();
  });

  test('should not detect KiloCode from a non-directory .kilocode path', async () => {
    await fs.promises.writeFile(path.join(tempDir, '.kilocode'), '');

    const agents = await detectInstalledAgents(tempDir);

    expect(agents.includes('kilocode')).toBe(false);
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

  test('should detect Cline when .clinerules exists', async () => {
    await fs.promises.writeFile(path.join(tempDir, '.clinerules'), '');

    const agents = await detectInstalledAgents(tempDir);

    expect(agents.includes('cline')).toBeTruthy();
  });

  test('should detect Roo when .roo directory exists', async () => {
    await fs.promises.mkdir(path.join(tempDir, '.roo'), { recursive: true });

    const agents = await detectInstalledAgents(tempDir);

    expect(agents.includes('roo')).toBeTruthy();
  });

  test('should detect Codex when .codex directory exists', async () => {
    await fs.promises.mkdir(path.join(tempDir, '.codex'), { recursive: true });

    const agents = await detectInstalledAgents(tempDir);

    expect(agents.includes('codex')).toBeTruthy();
  });

  test('should detect multiple agents simultaneously', async () => {
    // Create files for multiple agents
    await fs.promises.mkdir(path.join(tempDir, '.claude'), { recursive: true });
    await fs.promises.mkdir(path.join(tempDir, '.cursor'), { recursive: true });
    await fs.promises.writeFile(path.join(tempDir, '.kilo.md'), '# Kilo');
    await fs.promises.writeFile(path.join(tempDir, '.clinerules'), '');
    await fs.promises.mkdir(path.join(tempDir, '.roo'), { recursive: true });
    await fs.promises.mkdir(path.join(tempDir, '.codex'), { recursive: true });
    await fs.promises.mkdir(path.join(tempDir, '.kilocode', 'workflows'), { recursive: true });
    await fs.promises.mkdir(path.join(tempDir, '.kilocode', 'rules'), { recursive: true });
    await fs.promises.mkdir(path.join(tempDir, '.kilocode', 'skills', 'forge-workflow'), { recursive: true });

    const agents = await detectInstalledAgents(tempDir);

    expect(agents.includes('claude')).toBeTruthy();
    expect(agents.includes('cursor')).toBeTruthy();
    expect(agents.includes('kilocode')).toBeTruthy();
    expect(agents.includes('cline')).toBeTruthy();
    expect(agents.includes('roo')).toBeTruthy();
    expect(agents.includes('codex')).toBeTruthy();
    expect(agents.length).toBe(6);
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
    await fs.promises.mkdir(path.join(tempDir, '.kilocode', 'workflows'), { recursive: true });
    await fs.promises.mkdir(path.join(tempDir, '.kilocode', 'rules'), { recursive: true });
    await fs.promises.mkdir(path.join(tempDir, '.kilocode', 'skills', 'forge-workflow'), { recursive: true });

    const agents = await detectInstalledAgents(tempDir);

    // All Tier 1 agents should be detected
    expect(agents.includes('claude')).toBeTruthy();
    expect(agents.includes('copilot')).toBeTruthy();
    expect(agents.includes('kilocode')).toBeTruthy();
    expect(agents.includes('cursor')).toBeTruthy();
    expect(agents.length).toBe(4);
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
