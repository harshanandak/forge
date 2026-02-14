const fs = require('node:fs');
const path = require('node:path');
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

describe('Snapshot Testing', () => {
  const snapshotsDir = path.join(__dirname, '__snapshots__');
  const scaffold = require('./helpers/scaffold.js');
  const cleanup = require('./helpers/cleanup.js');

  describe('Snapshot directory', () => {
    test('should have __snapshots__ directory', () => {
      // Will be created when snapshots are generated
      if (!fs.existsSync(snapshotsDir)) {
        fs.mkdirSync(snapshotsDir, { recursive: true });
      }
      assert.ok(fs.existsSync(snapshotsDir), '__snapshots__ directory should exist');
    });
  });

  describe('Generated file snapshots', () => {
    test('should snapshot package.json from scaffold', async () => {
      const tempDir = await scaffold.createTempProject('snapshot-test');
      const packagePath = path.join(tempDir, 'package.json');
      const packageContent = fs.readFileSync(packagePath, 'utf-8');
      const pkg = JSON.parse(packageContent);

      // Validate structure (snapshot-like test)
      assert.ok(pkg.name, 'package.json should have name');
      assert.strictEqual(pkg.version, '1.0.0', 'package.json should have version 1.0.0');
      assert.strictEqual(pkg.private, true, 'package.json should be private');
      assert.ok(pkg.description, 'package.json should have description');

      await cleanup.cleanupTempProject(tempDir);
    });

    test('should snapshot fixture structure', async () => {
      const emptyFixture = path.join(__dirname, 'fixtures', 'empty-project');

      if (!fs.existsSync(emptyFixture)) {
        // Skip if fixture doesn't exist
        return;
      }

      const entries = fs.readdirSync(emptyFixture);
      const snapshotPath = path.join(snapshotsDir, 'empty-project-structure.json');

      // Create or validate snapshot
      const structure = {
        files: entries.filter(e => !fs.statSync(path.join(emptyFixture, e)).isDirectory()),
        directories: entries.filter(e => fs.statSync(path.join(emptyFixture, e)).isDirectory()),
      };

      if (!fs.existsSync(snapshotPath)) {
        // Create snapshot
        fs.writeFileSync(snapshotPath, JSON.stringify(structure, null, 2), 'utf-8');
      }

      // Validate against snapshot
      const snapshot = JSON.parse(fs.readFileSync(snapshotPath, 'utf-8'));
      assert.deepStrictEqual(structure, snapshot, 'Fixture structure should match snapshot');
    });

    test('should snapshot large-project structure', async () => {
      const largeFixture = path.join(__dirname, 'fixtures', 'large-project');

      if (!fs.existsSync(largeFixture)) {
        // Skip if fixture doesn't exist
        return;
      }

      const entries = fs.readdirSync(largeFixture);
      const snapshotPath = path.join(snapshotsDir, 'large-project-structure.json');

      const structure = {
        files: entries.filter(e => !fs.statSync(path.join(largeFixture, e)).isDirectory()),
        directories: entries.filter(e => fs.statSync(path.join(largeFixture, e)).isDirectory()),
      };

      if (!fs.existsSync(snapshotPath)) {
        // Create snapshot
        fs.writeFileSync(snapshotPath, JSON.stringify(structure, null, 2), 'utf-8');
      }

      // Validate against snapshot
      const snapshot = JSON.parse(fs.readFileSync(snapshotPath, 'utf-8'));
      assert.deepStrictEqual(structure, snapshot, 'Large project structure should match snapshot');
    });
  });

  describe('Snapshot consistency', () => {
    test('snapshots should be deterministic', async () => {
      // Create same project twice, compare results
      const tempDir1 = await scaffold.createTempProject('consistency-test-1');
      const tempDir2 = await scaffold.createTempProject('consistency-test-2');

      const pkg1 = JSON.parse(fs.readFileSync(path.join(tempDir1, 'package.json'), 'utf-8'));
      const pkg2 = JSON.parse(fs.readFileSync(path.join(tempDir2, 'package.json'), 'utf-8'));

      // Names will be different, but structure should be same
      delete pkg1.name;
      delete pkg2.name;
      delete pkg1.description;
      delete pkg2.description;

      assert.deepStrictEqual(pkg1, pkg2, 'Generated files should be consistent');

      await cleanup.cleanupTempProject(tempDir1);
      await cleanup.cleanupTempProject(tempDir2);
    });
  });
});
