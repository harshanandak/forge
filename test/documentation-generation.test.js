const fs = require('node:fs');
const path = require('node:path');
const { describe, test, beforeEach, afterEach, expect } = require('bun:test');
const os = require('node:os');

// Module under test
const { generateArchitectureDoc, generateConfigurationDoc, generateMcpSetupDoc } = require('../lib/agents-config');

describe('Documentation file generation', () => {
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

  describe('ARCHITECTURE.md generation', () => {
    test('should create docs/ARCHITECTURE.md file', async () => {
      await generateArchitectureDoc(tempDir);

      const architecturePath = path.join(tempDir, 'docs', 'ARCHITECTURE.md');
      const exists = await fs.promises.access(architecturePath).then(() => true).catch(() => false);

      expect(exists).toBeTruthy();

      const content = await fs.promises.readFile(architecturePath, 'utf-8');

      // Should be markdown
      expect(content.startsWith('#')).toBeTruthy();
    });

    test('should explain Commands vs Skills vs MCP', async () => {
      await generateArchitectureDoc(tempDir);

      const architecturePath = path.join(tempDir, 'docs', 'ARCHITECTURE.md');
      const content = await fs.promises.readFile(architecturePath, 'utf-8');

      // Should explain three mechanisms
      expect(content.includes('Commands') || content.includes('commands')).toBeTruthy();
      expect(content.includes('Skills') || content.includes('skills')).toBeTruthy();
      expect(content.includes('MCP')).toBeTruthy();

      // Should explain AGENTS.md
      expect(content.includes('AGENTS.md')).toBeTruthy();

      // Should explain how mechanisms work
      expect(content.includes('how') || content.includes('How')).toBeTruthy();
    });

    test('should include examples of each mechanism', async () => {
      await generateArchitectureDoc(tempDir);

      const architecturePath = path.join(tempDir, 'docs', 'ARCHITECTURE.md');
      const content = await fs.promises.readFile(architecturePath, 'utf-8');

      // Should have examples
      expect(content.includes('/status') || content.includes('/research')).toBeTruthy();
      expect(content.includes('parallel-ai') || content.includes('sonarcloud')).toBeTruthy();
      expect(content.includes('context7')).toBeTruthy();
    });

    test('should explain universal vs agent-specific', async () => {
      await generateArchitectureDoc(tempDir);

      const architecturePath = path.join(tempDir, 'docs', 'ARCHITECTURE.md');
      const content = await fs.promises.readFile(architecturePath, 'utf-8');

      // Should explain universality
      expect(content.includes('universal') || content.includes('Universal')).toBeTruthy();
      expect(content.includes('agent') && content.includes('specific')).toBeTruthy();
    });

    test('should not overwrite existing ARCHITECTURE.md by default', async () => {
      const docsDir = path.join(tempDir, 'docs');
      await fs.promises.mkdir(docsDir, { recursive: true });

      const architecturePath = path.join(docsDir, 'ARCHITECTURE.md');
      const existingContent = '# Custom Architecture\\n\\nDo not overwrite!';
      await fs.promises.writeFile(architecturePath, existingContent);

      await generateArchitectureDoc(tempDir, { overwrite: false });

      const content = await fs.promises.readFile(architecturePath, 'utf-8');
      expect(content).toBe(existingContent);
    });
  });

  describe('CONFIGURATION.md generation', () => {
    test('should create docs/CONFIGURATION.md file', async () => {
      await generateConfigurationDoc(tempDir);

      const configPath = path.join(tempDir, 'docs', 'CONFIGURATION.md');
      const exists = await fs.promises.access(configPath).then(() => true).catch(() => false);

      expect(exists).toBeTruthy();

      const content = await fs.promises.readFile(configPath, 'utf-8');
      expect(content.startsWith('#')).toBeTruthy();
    });

    test('should explain solo vs team configuration', async () => {
      await generateConfigurationDoc(tempDir);

      const configPath = path.join(tempDir, 'docs', 'CONFIGURATION.md');
      const content = await fs.promises.readFile(configPath, 'utf-8');

      // Should mention both profiles
      expect(content.includes('solo') || content.includes('Solo')).toBeTruthy();
      expect(content.includes('team') || content.includes('Team')).toBeTruthy();

      // Should explain differences
      expect(content.includes('branch protection') || content.includes('Branch protection')).toBeTruthy();
      expect(content.includes('reviewer')).toBeTruthy();
    });

    test('should include .forgerc.json example', async () => {
      await generateConfigurationDoc(tempDir);

      const configPath = path.join(tempDir, 'docs', 'CONFIGURATION.md');
      const content = await fs.promises.readFile(configPath, 'utf-8');

      // Should have config file reference
      expect(content.includes('.forgerc')).toBeTruthy();
      expect(content.includes('profile')).toBeTruthy();
    });

    test('should explain configuration options', async () => {
      await generateConfigurationDoc(tempDir);

      const configPath = path.join(tempDir, 'docs', 'CONFIGURATION.md');
      const content = await fs.promises.readFile(configPath, 'utf-8');

      // Should explain key options
      expect(content.includes('auto_merge') || content.includes('auto-merge')).toBeTruthy();
      expect(content.includes('commit_signing') || content.includes('commit signing')).toBeTruthy();
    });

    test('should not overwrite existing CONFIGURATION.md by default', async () => {
      const docsDir = path.join(tempDir, 'docs');
      await fs.promises.mkdir(docsDir, { recursive: true });

      const configPath = path.join(docsDir, 'CONFIGURATION.md');
      const existingContent = '# Custom Config\\n\\nDo not overwrite!';
      await fs.promises.writeFile(configPath, existingContent);

      await generateConfigurationDoc(tempDir, { overwrite: false });

      const content = await fs.promises.readFile(configPath, 'utf-8');
      expect(content).toBe(existingContent);
    });
  });

  describe('MCP_SETUP.md generation', () => {
    test('should create docs/MCP_SETUP.md file', async () => {
      await generateMcpSetupDoc(tempDir);

      const mcpPath = path.join(tempDir, 'docs', 'MCP_SETUP.md');
      const exists = await fs.promises.access(mcpPath).then(() => true).catch(() => false);

      expect(exists).toBeTruthy();

      const content = await fs.promises.readFile(mcpPath, 'utf-8');
      expect(content.startsWith('#')).toBeTruthy();
    });

    test('should explain MCP server setup', async () => {
      await generateMcpSetupDoc(tempDir);

      const mcpPath = path.join(tempDir, 'docs', 'MCP_SETUP.md');
      const content = await fs.promises.readFile(mcpPath, 'utf-8');

      // Should explain MCP
      expect(content.includes('MCP') || content.includes('Model Context Protocol')).toBeTruthy();
      expect(content.includes('server')).toBeTruthy();

      // Should explain setup
      expect(content.includes('setup') || content.includes('Setup')).toBeTruthy();
    });

    test('should include agent-specific setup instructions', async () => {
      await generateMcpSetupDoc(tempDir);

      const mcpPath = path.join(tempDir, 'docs', 'MCP_SETUP.md');
      const content = await fs.promises.readFile(mcpPath, 'utf-8');

      // Should mention Tier 1 agents
      expect(content.includes('Claude') || content.includes('claude')).toBeTruthy();
      expect(content.includes('Copilot') || content.includes('copilot')).toBeTruthy();
      expect(content.includes('Cursor') || content.includes('cursor')).toBeTruthy();
    });

    test('should include MCP server examples', async () => {
      await generateMcpSetupDoc(tempDir);

      const mcpPath = path.join(tempDir, 'docs', 'MCP_SETUP.md');
      const content = await fs.promises.readFile(mcpPath, 'utf-8');

      // Should have server examples
      expect(content.includes('parallel-ai')).toBeTruthy();
      expect(content.includes('context7')).toBeTruthy();
    });

    test('should include configuration examples', async () => {
      await generateMcpSetupDoc(tempDir);

      const mcpPath = path.join(tempDir, 'docs', 'MCP_SETUP.md');
      const content = await fs.promises.readFile(mcpPath, 'utf-8');

      // Should have config examples
      expect(content.includes('.mcp.json') || content.includes('mcp.json')).toBeTruthy();
      expect(content.includes('mcpServers')).toBeTruthy();
    });

    test('should not overwrite existing MCP_SETUP.md by default', async () => {
      const docsDir = path.join(tempDir, 'docs');
      await fs.promises.mkdir(docsDir, { recursive: true });

      const mcpPath = path.join(docsDir, 'MCP_SETUP.md');
      const existingContent = '# Custom MCP Setup\\n\\nDo not overwrite!';
      await fs.promises.writeFile(mcpPath, existingContent);

      await generateMcpSetupDoc(tempDir, { overwrite: false });

      const content = await fs.promises.readFile(mcpPath, 'utf-8');
      expect(content).toBe(existingContent);
    });
  });

  describe('Directory creation', () => {
    test('should create docs/ directory if it does not exist', async () => {
      // Ensure docs/ doesn't exist
      const docsDir = path.join(tempDir, 'docs');
      const docsDirExists = fs.existsSync(docsDir);
      expect(!docsDirExists).toBeTruthy();

      // Generate any doc
      await generateArchitectureDoc(tempDir);

      // Check docs/ was created
      expect(fs.existsSync(docsDir)).toBeTruthy();
    });
  });
});
