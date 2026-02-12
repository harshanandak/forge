const fs = require('node:fs');
const path = require('node:path');
const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
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

      assert.ok(exists, 'docs/ARCHITECTURE.md should be created');

      const content = await fs.promises.readFile(architecturePath, 'utf-8');

      // Should be markdown
      assert.ok(content.startsWith('#'), 'Should start with markdown heading');
    });

    test('should explain Commands vs Skills vs MCP', async () => {
      await generateArchitectureDoc(tempDir);

      const architecturePath = path.join(tempDir, 'docs', 'ARCHITECTURE.md');
      const content = await fs.promises.readFile(architecturePath, 'utf-8');

      // Should explain three mechanisms
      assert.ok(content.includes('Commands') || content.includes('commands'), 'Should mention Commands');
      assert.ok(content.includes('Skills') || content.includes('skills'), 'Should mention Skills');
      assert.ok(content.includes('MCP'), 'Should mention MCP');

      // Should explain AGENTS.md
      assert.ok(content.includes('AGENTS.md'), 'Should mention AGENTS.md');

      // Should explain how mechanisms work
      assert.ok(content.includes('how') || content.includes('How'), 'Should explain how things work');
    });

    test('should include examples of each mechanism', async () => {
      await generateArchitectureDoc(tempDir);

      const architecturePath = path.join(tempDir, 'docs', 'ARCHITECTURE.md');
      const content = await fs.promises.readFile(architecturePath, 'utf-8');

      // Should have examples
      assert.ok(content.includes('/status') || content.includes('/research'), 'Should include command examples');
      assert.ok(content.includes('parallel-ai') || content.includes('sonarcloud'), 'Should include skill examples');
      assert.ok(content.includes('context7'), 'Should include MCP server examples');
    });

    test('should explain universal vs agent-specific', async () => {
      await generateArchitectureDoc(tempDir);

      const architecturePath = path.join(tempDir, 'docs', 'ARCHITECTURE.md');
      const content = await fs.promises.readFile(architecturePath, 'utf-8');

      // Should explain universality
      assert.ok(content.includes('universal') || content.includes('Universal'), 'Should mention universal approach');
      assert.ok(content.includes('agent') && content.includes('specific'), 'Should mention agent-specific');
    });

    test('should not overwrite existing ARCHITECTURE.md by default', async () => {
      const docsDir = path.join(tempDir, 'docs');
      await fs.promises.mkdir(docsDir, { recursive: true });

      const architecturePath = path.join(docsDir, 'ARCHITECTURE.md');
      const existingContent = '# Custom Architecture\\n\\nDo not overwrite!';
      await fs.promises.writeFile(architecturePath, existingContent);

      await generateArchitectureDoc(tempDir, { overwrite: false });

      const content = await fs.promises.readFile(architecturePath, 'utf-8');
      assert.strictEqual(content, existingContent, 'Should not overwrite when overwrite=false');
    });
  });

  describe('CONFIGURATION.md generation', () => {
    test('should create docs/CONFIGURATION.md file', async () => {
      await generateConfigurationDoc(tempDir);

      const configPath = path.join(tempDir, 'docs', 'CONFIGURATION.md');
      const exists = await fs.promises.access(configPath).then(() => true).catch(() => false);

      assert.ok(exists, 'docs/CONFIGURATION.md should be created');

      const content = await fs.promises.readFile(configPath, 'utf-8');
      assert.ok(content.startsWith('#'), 'Should start with markdown heading');
    });

    test('should explain solo vs team configuration', async () => {
      await generateConfigurationDoc(tempDir);

      const configPath = path.join(tempDir, 'docs', 'CONFIGURATION.md');
      const content = await fs.promises.readFile(configPath, 'utf-8');

      // Should mention both profiles
      assert.ok(content.includes('solo') || content.includes('Solo'), 'Should mention solo profile');
      assert.ok(content.includes('team') || content.includes('Team'), 'Should mention team profile');

      // Should explain differences
      assert.ok(content.includes('branch protection') || content.includes('Branch protection'),
        'Should mention branch protection');
      assert.ok(content.includes('reviewer'), 'Should mention reviewers');
    });

    test('should include .forgerc.json example', async () => {
      await generateConfigurationDoc(tempDir);

      const configPath = path.join(tempDir, 'docs', 'CONFIGURATION.md');
      const content = await fs.promises.readFile(configPath, 'utf-8');

      // Should have config file reference
      assert.ok(content.includes('.forgerc'), 'Should mention .forgerc configuration');
      assert.ok(content.includes('profile'), 'Should show profile configuration');
    });

    test('should explain configuration options', async () => {
      await generateConfigurationDoc(tempDir);

      const configPath = path.join(tempDir, 'docs', 'CONFIGURATION.md');
      const content = await fs.promises.readFile(configPath, 'utf-8');

      // Should explain key options
      assert.ok(content.includes('auto_merge') || content.includes('auto-merge'), 'Should mention auto-merge');
      assert.ok(content.includes('commit_signing') || content.includes('commit signing'),
        'Should mention commit signing');
    });

    test('should not overwrite existing CONFIGURATION.md by default', async () => {
      const docsDir = path.join(tempDir, 'docs');
      await fs.promises.mkdir(docsDir, { recursive: true });

      const configPath = path.join(docsDir, 'CONFIGURATION.md');
      const existingContent = '# Custom Config\\n\\nDo not overwrite!';
      await fs.promises.writeFile(configPath, existingContent);

      await generateConfigurationDoc(tempDir, { overwrite: false });

      const content = await fs.promises.readFile(configPath, 'utf-8');
      assert.strictEqual(content, existingContent, 'Should not overwrite when overwrite=false');
    });
  });

  describe('MCP_SETUP.md generation', () => {
    test('should create docs/MCP_SETUP.md file', async () => {
      await generateMcpSetupDoc(tempDir);

      const mcpPath = path.join(tempDir, 'docs', 'MCP_SETUP.md');
      const exists = await fs.promises.access(mcpPath).then(() => true).catch(() => false);

      assert.ok(exists, 'docs/MCP_SETUP.md should be created');

      const content = await fs.promises.readFile(mcpPath, 'utf-8');
      assert.ok(content.startsWith('#'), 'Should start with markdown heading');
    });

    test('should explain MCP server setup', async () => {
      await generateMcpSetupDoc(tempDir);

      const mcpPath = path.join(tempDir, 'docs', 'MCP_SETUP.md');
      const content = await fs.promises.readFile(mcpPath, 'utf-8');

      // Should explain MCP
      assert.ok(content.includes('MCP') || content.includes('Model Context Protocol'),
        'Should explain MCP');
      assert.ok(content.includes('server'), 'Should mention servers');

      // Should explain setup
      assert.ok(content.includes('setup') || content.includes('Setup'), 'Should explain setup process');
    });

    test('should include agent-specific setup instructions', async () => {
      await generateMcpSetupDoc(tempDir);

      const mcpPath = path.join(tempDir, 'docs', 'MCP_SETUP.md');
      const content = await fs.promises.readFile(mcpPath, 'utf-8');

      // Should mention Tier 1 agents
      assert.ok(content.includes('Claude') || content.includes('claude'), 'Should mention Claude Code');
      assert.ok(content.includes('Copilot') || content.includes('copilot'), 'Should mention GitHub Copilot');
      assert.ok(content.includes('Cursor') || content.includes('cursor'), 'Should mention Cursor');
    });

    test('should include MCP server examples', async () => {
      await generateMcpSetupDoc(tempDir);

      const mcpPath = path.join(tempDir, 'docs', 'MCP_SETUP.md');
      const content = await fs.promises.readFile(mcpPath, 'utf-8');

      // Should have server examples
      assert.ok(content.includes('parallel-ai'), 'Should mention parallel-ai server');
      assert.ok(content.includes('context7'), 'Should mention context7 server');
    });

    test('should include configuration examples', async () => {
      await generateMcpSetupDoc(tempDir);

      const mcpPath = path.join(tempDir, 'docs', 'MCP_SETUP.md');
      const content = await fs.promises.readFile(mcpPath, 'utf-8');

      // Should have config examples
      assert.ok(content.includes('.mcp.json') || content.includes('mcp.json'), 'Should mention MCP config files');
      assert.ok(content.includes('mcpServers'), 'Should show config structure');
    });

    test('should not overwrite existing MCP_SETUP.md by default', async () => {
      const docsDir = path.join(tempDir, 'docs');
      await fs.promises.mkdir(docsDir, { recursive: true });

      const mcpPath = path.join(docsDir, 'MCP_SETUP.md');
      const existingContent = '# Custom MCP Setup\\n\\nDo not overwrite!';
      await fs.promises.writeFile(mcpPath, existingContent);

      await generateMcpSetupDoc(tempDir, { overwrite: false });

      const content = await fs.promises.readFile(mcpPath, 'utf-8');
      assert.strictEqual(content, existingContent, 'Should not overwrite when overwrite=false');
    });
  });

  describe('Directory creation', () => {
    test('should create docs/ directory if it does not exist', async () => {
      // Ensure docs/ doesn't exist
      const docsDir = path.join(tempDir, 'docs');
      const docsDirExists = fs.existsSync(docsDir);
      assert.ok(!docsDirExists, 'docs/ should not exist initially');

      // Generate any doc
      await generateArchitectureDoc(tempDir);

      // Check docs/ was created
      assert.ok(fs.existsSync(docsDir), 'docs/ directory should be created');
    });
  });
});
