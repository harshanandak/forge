const fs = require('fs');
const path = require('path');
const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

// Module under test
const {
  autoDetect,
  detectFramework,
  detectLanguage,
  inferStage,
  saveContext,
  loadContext
} = require('../lib/project-discovery');

describe('project-discovery', () => {
  const fixturesDir = path.join(__dirname, 'fixtures', 'project-discovery');

  describe('detectFramework', () => {
    test('should detect Next.js from package.json', async () => {
      const projectPath = path.join(fixturesDir, 'new-project');
      const framework = await detectFramework(projectPath);

      assert.strictEqual(framework, 'Next.js');
    });

    test('should detect Next.js from active project', async () => {
      const projectPath = path.join(fixturesDir, 'active-project');
      const framework = await detectFramework(projectPath);

      assert.strictEqual(framework, 'Next.js');
    });

    test('should return null for unknown framework', async () => {
      const projectPath = path.join(__dirname, 'fixtures');
      const framework = await detectFramework(projectPath);

      assert.ok(framework === null || framework === 'Unknown');
    });
  });

  describe('detectLanguage', () => {
    test('should detect TypeScript from dependencies', async () => {
      const projectPath = path.join(fixturesDir, 'new-project');
      const language = await detectLanguage(projectPath);

      assert.strictEqual(language, 'typescript');
    });

    test('should handle projects without package.json', async () => {
      const projectPath = path.join(__dirname, 'fixtures', 'context-merge');
      const language = await detectLanguage(projectPath);

      // Should default to something reasonable or null
      assert.ok(language !== undefined);
    });
  });

  describe('inferStage', () => {
    test('should infer "new" stage for projects with < 50 commits', async () => {
      // Mock project stats
      const stats = {
        commits: 25,
        hasCICD: false,
        coverage: 20
      };

      const stage = inferStage(stats);

      assert.strictEqual(stage, 'new');
    });

    test('should infer "active" stage for mid-development projects', async () => {
      const stats = {
        commits: 150,
        hasCICD: true,
        coverage: 65
      };

      const stage = inferStage(stats);

      assert.strictEqual(stage, 'active');
    });

    test('should infer "stable" stage for mature projects', async () => {
      const stats = {
        commits: 800,
        hasCICD: true,
        hasReleases: true,
        coverage: 90
      };

      const stage = inferStage(stats);

      assert.strictEqual(stage, 'stable');
    });

    test('should handle edge case: no commits', async () => {
      const stats = {
        commits: 0,
        hasCICD: false,
        coverage: 0
      };

      const stage = inferStage(stats);

      assert.strictEqual(stage, 'new');
    });

    test('should handle edge case: very high commits but low coverage', async () => {
      const stats = {
        commits: 1000,
        hasCICD: true,
        coverage: 10
      };

      const stage = inferStage(stats);

      // Should be active, not stable (low coverage)
      assert.strictEqual(stage, 'active');
    });
  });

  describe('autoDetect', () => {
    test('should auto-detect all project info for new project', async () => {
      const projectPath = path.join(fixturesDir, 'new-project');
      const context = await autoDetect(projectPath);

      assert.ok(context);
      assert.ok(context.hasOwnProperty('framework'));
      assert.ok(context.hasOwnProperty('language'));
      assert.ok(context.hasOwnProperty('stage'));
      assert.ok(context.hasOwnProperty('confidence'));

      assert.strictEqual(context.framework, 'Next.js');
      assert.strictEqual(context.language, 'typescript');
    });

    test('should calculate confidence score', async () => {
      const projectPath = path.join(fixturesDir, 'active-project');
      const context = await autoDetect(projectPath);

      assert.ok(context.confidence >= 0 && context.confidence <= 1);
    });

    test('should detect CI/CD presence', async () => {
      const projectPath = path.join(fixturesDir, 'active-project');
      const context = await autoDetect(projectPath);

      assert.ok(context.hasOwnProperty('hasCICD'));
    });

    test('should handle project without git', async () => {
      const projectPath = path.join(fixturesDir, 'new-project');
      const context = await autoDetect(projectPath);

      // Should not throw, should return defaults
      assert.ok(context);
      assert.ok(context.stage);
    });
  });

  describe('saveContext and loadContext', () => {
    const testProjectPath = path.join(__dirname, '..', 'scratchpad', 'test-context');

    beforeEach(async () => {
      // Create test directory
      await fs.promises.mkdir(testProjectPath, { recursive: true });
    });

    afterEach(async () => {
      // Cleanup
      try {
        await fs.promises.rm(testProjectPath, { recursive: true, force: true });
      } catch (err) {
        // Ignore cleanup errors
      }
    });

    test('should save context to .forge/context.json', async () => {
      const context = {
        auto_detected: {
          framework: 'Next.js',
          language: 'typescript',
          stage: 'active',
          confidence: 0.85
        },
        user_provided: {
          description: 'Test project',
          current_work: 'Testing'
        }
      };

      await saveContext(context, testProjectPath);

      const contextPath = path.join(testProjectPath, '.forge', 'context.json');
      assert.ok(fs.existsSync(contextPath));

      const saved = JSON.parse(await fs.promises.readFile(contextPath, 'utf8'));
      assert.strictEqual(saved.auto_detected.framework, 'Next.js');
      assert.strictEqual(saved.auto_detected.stage, 'active');
      assert.ok(saved.last_updated);
    });

    test('should load saved context', async () => {
      const original = {
        auto_detected: {
          framework: 'Next.js',
          language: 'typescript',
          stage: 'active',
          confidence: 0.85
        },
        user_provided: {
          description: 'Test project'
        }
      };

      await saveContext(original, testProjectPath);
      const loaded = await loadContext(testProjectPath);

      assert.strictEqual(loaded.auto_detected.framework, 'Next.js');
      assert.strictEqual(loaded.auto_detected.stage, 'active');
      assert.strictEqual(loaded.user_provided.description, 'Test project');
    });

    test('should return null for non-existent context', async () => {
      const nonExistentPath = path.join(testProjectPath, 'nonexistent');
      const loaded = await loadContext(nonExistentPath);

      assert.strictEqual(loaded, null);
    });

    test('should handle malformed context.json gracefully', async () => {
      const contextPath = path.join(testProjectPath, '.forge', 'context.json');
      await fs.promises.mkdir(path.dirname(contextPath), { recursive: true });
      await fs.promises.writeFile(contextPath, 'invalid json{{{');

      const loaded = await loadContext(testProjectPath);

      assert.strictEqual(loaded, null);
    });
  });

  describe('edge cases', () => {
    test('should handle projects with no dependencies', async () => {
      const emptyProjectPath = path.join(__dirname, '..', 'scratchpad', 'empty-project');

      await fs.promises.mkdir(emptyProjectPath, { recursive: true });
      await fs.promises.writeFile(
        path.join(emptyProjectPath, 'package.json'),
        JSON.stringify({ name: 'empty', version: '1.0.0' })
      );

      try {
        const context = await autoDetect(emptyProjectPath);

        assert.ok(context);
        assert.ok(context.stage);
      } finally {
        await fs.promises.rm(emptyProjectPath, { recursive: true, force: true });
      }
    });

    test('should handle missing package.json gracefully', async () => {
      const noPackagePath = path.join(__dirname, 'fixtures', 'context-merge');

      const context = await autoDetect(noPackagePath);

      assert.ok(context);
      // Should have defaults
      assert.ok(context.stage);
    });
  });
});
