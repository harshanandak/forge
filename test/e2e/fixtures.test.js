const fs = require('node:fs');
const path = require('node:path');
const { describe, test, expect } = require('bun:test');

describe('E2E Test Fixtures', () => {
  const fixturesDir = path.join(__dirname, 'fixtures');

  describe('Fixtures directory', () => {
    test('should exist', () => {
      expect(fs.existsSync(fixturesDir)).toBeTruthy();
    });
  });

  describe('empty-project fixture', () => {
    const emptyFixturePath = path.join(fixturesDir, 'empty-project');

    test('should exist', () => {
      expect(fs.existsSync(emptyFixturePath)).toBeTruthy();
    });

    test('should have package.json', () => {
      const packagePath = path.join(emptyFixturePath, 'package.json');
      expect(fs.existsSync(packagePath)).toBeTruthy();

      const pkg = JSON.parse(fs.readFileSync(packagePath, 'utf-8'));
      expect(pkg.name).toBeTruthy();
    });

    test('should have minimal structure (no existing Forge files)', () => {
      // Empty project should NOT have AGENTS.md or CLAUDE.md
      const agentsPath = path.join(emptyFixturePath, 'AGENTS.md');
      const claudePath = path.join(emptyFixturePath, 'CLAUDE.md');

      expect(!fs.existsSync(agentsPath)).toBeTruthy();
      expect(!fs.existsSync(claudePath)).toBeTruthy();
    });
  });

  describe('existing-project fixture', () => {
    const existingFixturePath = path.join(fixturesDir, 'existing-project');

    test('should exist', () => {
      expect(fs.existsSync(existingFixturePath)).toBeTruthy();
    });

    test('should have package.json', () => {
      const packagePath = path.join(existingFixturePath, 'package.json');
      expect(fs.existsSync(packagePath)).toBeTruthy();
    });

    test('should have existing AGENTS.md', () => {
      const agentsPath = path.join(existingFixturePath, 'AGENTS.md');
      expect(fs.existsSync(agentsPath)).toBeTruthy();

      const content = fs.readFileSync(agentsPath, 'utf-8');
      expect(content.length > 0).toBeTruthy();
    });

    test('should have some source files', () => {
      const srcPath = path.join(existingFixturePath, 'src');

      if (fs.existsSync(srcPath)) {
        // If src directory exists, should have at least one file
        const hasFiles = fs.readdirSync(srcPath).length > 0;
        expect(hasFiles).toBeTruthy();
      }
      // OK if no src directory (might have files in root)
    });
  });

  describe('large-project fixture', () => {
    const largeFixturePath = path.join(fixturesDir, 'large-project');

    test('should exist', () => {
      expect(fs.existsSync(largeFixturePath)).toBeTruthy();
    });

    test('should have package.json', () => {
      const packagePath = path.join(largeFixturePath, 'package.json');
      expect(fs.existsSync(packagePath)).toBeTruthy();
    });

    test('should have multiple directories', () => {
      const entries = fs.readdirSync(largeFixturePath, { withFileTypes: true });
      const directories = entries.filter(e => e.isDirectory());

      expect(directories.length >= 3).toBeTruthy();
    });

    test('should have multiple source files', () => {
      const srcPath = path.join(largeFixturePath, 'src');

      if (fs.existsSync(srcPath)) {
        const files = fs.readdirSync(srcPath, { withFileTypes: true });
        const jsFiles = files.filter(f => f.name.endsWith('.js') || f.name.endsWith('.ts'));

        expect(jsFiles.length >= 5).toBeTruthy();
      } else {
        // If no src directory, count files in root
        const entries = fs.readdirSync(largeFixturePath);
        expect(entries.length >= 10).toBeTruthy();
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
      expect(fs.existsSync(packagePath)).toBeTruthy();

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
      expect(fs.existsSync(agentsPath)).toBeTruthy();

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
      expect(entries.length >= 3).toBeTruthy();

      await cleanup.cleanupTempProject(tempDir);
    });
  });
});
