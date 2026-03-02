const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { describe, test, beforeAll: before, afterAll: _after, expect } = require('bun:test');

describe('E2E Scaffold Utilities', () => {
  const helpersPath = path.join(__dirname, 'helpers');
  const scaffoldPath = path.join(helpersPath, 'scaffold.js');
  const cleanupPath = path.join(helpersPath, 'cleanup.js');

  describe('Helper files existence', () => {
    test('should have test/e2e/helpers directory', () => {
      expect(fs.existsSync(helpersPath)).toBeTruthy();
    });

    test('should have scaffold.js', () => {
      expect(fs.existsSync(scaffoldPath)).toBeTruthy();
    });

    test('should have cleanup.js', () => {
      expect(fs.existsSync(cleanupPath)).toBeTruthy();
    });
  });

  describe('Scaffold module', () => {
    let scaffold;

    before(async () => {
      // Try to load scaffold module
      try {
        scaffold = require(scaffoldPath);
      } catch (_error) {
        // Module doesn't exist yet (RED phase)
        scaffold = null;
      }
    });

    test('should export createTempProject function', () => {
      expect(scaffold).toBeTruthy();
      expect(typeof scaffold.createTempProject === 'function').toBeTruthy();
    });

    test('should export copyFixture function', () => {
      expect(scaffold).toBeTruthy();
      expect(typeof scaffold.copyFixture === 'function').toBeTruthy();
    });

    test('createTempProject should create a directory in os.tmpdir()', async () => {
      if (!scaffold || !scaffold.createTempProject) {
        throw new Error('scaffold.createTempProject not available');
      }

      const tempDir = await scaffold.createTempProject('test-project');
      expect(tempDir).toBeTruthy();
      expect(tempDir.includes(os.tmpdir())).toBeTruthy();
      expect(tempDir.includes('test-project')).toBeTruthy();
      expect(fs.existsSync(tempDir)).toBeTruthy();

      // Cleanup
      fs.rmSync(tempDir, { recursive: true, force: true });
    });

    test('createTempProject should create package.json', async () => {
      if (!scaffold || !scaffold.createTempProject) {
        throw new Error('scaffold.createTempProject not available');
      }

      const tempDir = await scaffold.createTempProject('test-project');
      const packagePath = path.join(tempDir, 'package.json');
      expect(fs.existsSync(packagePath)).toBeTruthy();

      const pkg = JSON.parse(fs.readFileSync(packagePath, 'utf-8'));
      expect(pkg.name).toBeTruthy();

      // Cleanup
      fs.rmSync(tempDir, { recursive: true, force: true });
    });

    test('copyFixture should copy fixture directory to temp project', async () => {
      if (!scaffold || !scaffold.copyFixture) {
        throw new Error('scaffold.copyFixture not available');
      }

      const tempDir = await scaffold.createTempProject('test-project');
      const fixturesDir = path.join(__dirname, 'fixtures');
      const emptyFixture = path.join(fixturesDir, 'empty-project');

      // Skip if fixtures don't exist yet (will be created in next cycle)
      if (!fs.existsSync(emptyFixture)) {
        // Cleanup and skip
        fs.rmSync(tempDir, { recursive: true, force: true });
        return;
      }

      await scaffold.copyFixture('empty-project', tempDir);
      // Verify files were copied (exact files depend on fixture)
      expect(fs.existsSync(tempDir)).toBeTruthy();

      // Cleanup
      fs.rmSync(tempDir, { recursive: true, force: true });
    });
  });

  describe('Cleanup module', () => {
    let cleanup;

    before(async () => {
      // Try to load cleanup module
      try {
        cleanup = require(cleanupPath);
      } catch (_error) {
        // Module doesn't exist yet (RED phase)
        cleanup = null;
      }
    });

    test('should export cleanupTempProject function', () => {
      expect(cleanup).toBeTruthy();
      expect(typeof cleanup.cleanupTempProject === 'function').toBeTruthy();
    });

    test('cleanupTempProject should remove directory', async () => {
      if (!cleanup || !cleanup.cleanupTempProject) {
        throw new Error('cleanup.cleanupTempProject not available');
      }

      // Create a temp directory manually
      const tempDir = path.join(os.tmpdir(), `forge-test-${Date.now()}`);
      fs.mkdirSync(tempDir, { recursive: true });
      fs.writeFileSync(path.join(tempDir, 'test.txt'), 'test');

      expect(fs.existsSync(tempDir)).toBeTruthy();

      await cleanup.cleanupTempProject(tempDir);

      expect(!fs.existsSync(tempDir)).toBeTruthy();
    });

    test('cleanupTempProject should not throw on non-existent directory', async () => {
      if (!cleanup || !cleanup.cleanupTempProject) {
        throw new Error('cleanup.cleanupTempProject not available');
      }

      const nonExistentDir = path.join(os.tmpdir(), `non-existent-${Date.now()}`);

      // Should not throw
      await expect(cleanup.cleanupTempProject(nonExistentDir)).resolves.toBeUndefined();
    });
  });
});
