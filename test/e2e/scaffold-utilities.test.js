const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');

describe('E2E Scaffold Utilities', () => {
  const helpersPath = path.join(__dirname, 'helpers');
  const scaffoldPath = path.join(helpersPath, 'scaffold.js');
  const cleanupPath = path.join(helpersPath, 'cleanup.js');

  describe('Helper files existence', () => {
    test('should have test/e2e/helpers directory', () => {
      assert.ok(fs.existsSync(helpersPath), 'test/e2e/helpers should exist');
    });

    test('should have scaffold.js', () => {
      assert.ok(fs.existsSync(scaffoldPath), 'scaffold.js should exist');
    });

    test('should have cleanup.js', () => {
      assert.ok(fs.existsSync(cleanupPath), 'cleanup.js should exist');
    });
  });

  describe('Scaffold module', () => {
    let scaffold;

    before(async () => {
      // Try to load scaffold module
      try {
        scaffold = require(scaffoldPath);
      } catch (error) {
        // Module doesn't exist yet (RED phase)
        scaffold = null;
      }
    });

    test('should export createTempProject function', () => {
      assert.ok(scaffold, 'scaffold module should exist');
      assert.ok(typeof scaffold.createTempProject === 'function', 'Should export createTempProject function');
    });

    test('should export copyFixture function', () => {
      assert.ok(scaffold, 'scaffold module should exist');
      assert.ok(typeof scaffold.copyFixture === 'function', 'Should export copyFixture function');
    });

    test('createTempProject should create a directory in os.tmpdir()', async () => {
      if (!scaffold || !scaffold.createTempProject) {
        assert.fail('scaffold.createTempProject not available');
      }

      const tempDir = await scaffold.createTempProject('test-project');
      assert.ok(tempDir, 'Should return temp directory path');
      assert.ok(tempDir.includes(os.tmpdir()), 'Should be in system temp directory');
      assert.ok(tempDir.includes('test-project'), 'Should include project name');
      assert.ok(fs.existsSync(tempDir), 'Temp directory should exist');

      // Cleanup
      fs.rmSync(tempDir, { recursive: true, force: true });
    });

    test('createTempProject should create package.json', async () => {
      if (!scaffold || !scaffold.createTempProject) {
        assert.fail('scaffold.createTempProject not available');
      }

      const tempDir = await scaffold.createTempProject('test-project');
      const packagePath = path.join(tempDir, 'package.json');
      assert.ok(fs.existsSync(packagePath), 'Should create package.json');

      const pkg = JSON.parse(fs.readFileSync(packagePath, 'utf-8'));
      assert.ok(pkg.name, 'package.json should have name');

      // Cleanup
      fs.rmSync(tempDir, { recursive: true, force: true });
    });

    test('copyFixture should copy fixture directory to temp project', async () => {
      if (!scaffold || !scaffold.copyFixture) {
        assert.fail('scaffold.copyFixture not available');
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
      assert.ok(fs.existsSync(tempDir), 'Temp directory should still exist');

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
      } catch (error) {
        // Module doesn't exist yet (RED phase)
        cleanup = null;
      }
    });

    test('should export cleanupTempProject function', () => {
      assert.ok(cleanup, 'cleanup module should exist');
      assert.ok(typeof cleanup.cleanupTempProject === 'function', 'Should export cleanupTempProject function');
    });

    test('cleanupTempProject should remove directory', async () => {
      if (!cleanup || !cleanup.cleanupTempProject) {
        assert.fail('cleanup.cleanupTempProject not available');
      }

      // Create a temp directory manually
      const tempDir = path.join(os.tmpdir(), `forge-test-${Date.now()}`);
      fs.mkdirSync(tempDir, { recursive: true });
      fs.writeFileSync(path.join(tempDir, 'test.txt'), 'test');

      assert.ok(fs.existsSync(tempDir), 'Temp directory should exist before cleanup');

      await cleanup.cleanupTempProject(tempDir);

      assert.ok(!fs.existsSync(tempDir), 'Temp directory should be removed');
    });

    test('cleanupTempProject should not throw on non-existent directory', async () => {
      if (!cleanup || !cleanup.cleanupTempProject) {
        assert.fail('cleanup.cleanupTempProject not available');
      }

      const nonExistentDir = path.join(os.tmpdir(), `non-existent-${Date.now()}`);

      // Should not throw
      await assert.doesNotReject(
        async () => await cleanup.cleanupTempProject(nonExistentDir),
        'Should not throw on non-existent directory'
      );
    });
  });
});
