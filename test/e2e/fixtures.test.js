const fs = require('node:fs');
const path = require('node:path');
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

describe('E2E Test Fixtures', () => {
  const fixturesDir = path.join(__dirname, 'fixtures');

  describe('Fixtures directory', () => {
    test('should exist', () => {
      assert.ok(fs.existsSync(fixturesDir), 'test/e2e/fixtures should exist');
    });
  });

  describe('empty-project fixture', () => {
    const emptyFixturePath = path.join(fixturesDir, 'empty-project');

    test('should exist', () => {
      assert.ok(fs.existsSync(emptyFixturePath), 'empty-project fixture should exist');
    });

    test('should have package.json', () => {
      const packagePath = path.join(emptyFixturePath, 'package.json');
      assert.ok(fs.existsSync(packagePath), 'empty-project should have package.json');

      const pkg = JSON.parse(fs.readFileSync(packagePath, 'utf-8'));
      assert.ok(pkg.name, 'package.json should have name');
    });

    test('should have minimal structure (no existing Forge files)', () => {
      // Empty project should NOT have AGENTS.md or CLAUDE.md
      const agentsPath = path.join(emptyFixturePath, 'AGENTS.md');
      const claudePath = path.join(emptyFixturePath, 'CLAUDE.md');

      assert.ok(!fs.existsSync(agentsPath), 'empty-project should not have AGENTS.md');
      assert.ok(!fs.existsSync(claudePath), 'empty-project should not have CLAUDE.md');
    });
  });

  describe('existing-project fixture', () => {
    const existingFixturePath = path.join(fixturesDir, 'existing-project');

    test('should exist', () => {
      assert.ok(fs.existsSync(existingFixturePath), 'existing-project fixture should exist');
    });

    test('should have package.json', () => {
      const packagePath = path.join(existingFixturePath, 'package.json');
      assert.ok(fs.existsSync(packagePath), 'existing-project should have package.json');
    });

    test('should have existing AGENTS.md', () => {
      const agentsPath = path.join(existingFixturePath, 'AGENTS.md');
      assert.ok(fs.existsSync(agentsPath), 'existing-project should have AGENTS.md');

      const content = fs.readFileSync(agentsPath, 'utf-8');
      assert.ok(content.length > 0, 'AGENTS.md should have content');
    });

    test('should have some source files', () => {
      const srcPath = path.join(existingFixturePath, 'src');

      if (fs.existsSync(srcPath)) {
        // If src directory exists, should have at least one file
        const hasFiles = fs.readdirSync(srcPath).length > 0;
        assert.ok(hasFiles, 'existing-project src/ should have files');
      }
      // OK if no src directory (might have files in root)
    });
  });

  describe('large-project fixture', () => {
    const largeFixturePath = path.join(fixturesDir, 'large-project');

    test('should exist', () => {
      assert.ok(fs.existsSync(largeFixturePath), 'large-project fixture should exist');
    });

    test('should have package.json', () => {
      const packagePath = path.join(largeFixturePath, 'package.json');
      assert.ok(fs.existsSync(packagePath), 'large-project should have package.json');
    });

    test('should have multiple directories', () => {
      const entries = fs.readdirSync(largeFixturePath, { withFileTypes: true });
      const directories = entries.filter(e => e.isDirectory());

      assert.ok(directories.length >= 3, 'large-project should have at least 3 directories');
    });

    test('should have multiple source files', () => {
      const srcPath = path.join(largeFixturePath, 'src');

      if (fs.existsSync(srcPath)) {
        const files = fs.readdirSync(srcPath, { withFileTypes: true });
        const jsFiles = files.filter(f => f.name.endsWith('.js') || f.name.endsWith('.ts'));

        assert.ok(jsFiles.length >= 5, 'large-project should have at least 5 source files');
      } else {
        // If no src directory, count files in root
        const entries = fs.readdirSync(largeFixturePath);
        assert.ok(entries.length >= 10, 'large-project should have at least 10 files/directories');
      }
    });
  });

  describe('Fixture loading with scaffold', () => {
    const scaffold = require('./helpers/scaffold.js');
    const cleanup = require('./helpers/cleanup.js');

    test('should successfully copy empty-project fixture', async () => {
      const emptyFixture = path.join(fixturesDir, 'empty-project');

      // Skip if fixture doesn't exist yet
      if (!fs.existsSync(emptyFixture)) {
        return;
      }

      const tempDir = await scaffold.createTempProject('test-empty');
      await scaffold.copyFixture('empty-project', tempDir);

      // Verify package.json was copied
      const packagePath = path.join(tempDir, 'package.json');
      assert.ok(fs.existsSync(packagePath), 'Copied fixture should have package.json');

      await cleanup.cleanupTempProject(tempDir);
    });

    test('should successfully copy existing-project fixture', async () => {
      const existingFixture = path.join(fixturesDir, 'existing-project');

      // Skip if fixture doesn't exist yet
      if (!fs.existsSync(existingFixture)) {
        return;
      }

      const tempDir = await scaffold.createTempProject('test-existing');
      await scaffold.copyFixture('existing-project', tempDir);

      // Verify AGENTS.md was copied
      const agentsPath = path.join(tempDir, 'AGENTS.md');
      assert.ok(fs.existsSync(agentsPath), 'Copied fixture should have AGENTS.md');

      await cleanup.cleanupTempProject(tempDir);
    });

    test('should successfully copy large-project fixture', async () => {
      const largeFixture = path.join(fixturesDir, 'large-project');

      // Skip if fixture doesn't exist yet
      if (!fs.existsSync(largeFixture)) {
        return;
      }

      const tempDir = await scaffold.createTempProject('test-large');
      await scaffold.copyFixture('large-project', tempDir);

      // Verify multiple files were copied
      const entries = fs.readdirSync(tempDir);
      assert.ok(entries.length >= 3, 'Copied large-project should have multiple files');

      await cleanup.cleanupTempProject(tempDir);
    });
  });
});
