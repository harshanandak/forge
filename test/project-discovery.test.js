const fs = require('node:fs');
const path = require('node:path');
const { describe, test, beforeEach, afterEach, expect } = require('bun:test');

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

      expect(framework).toBe('Next.js');
    });

    test('should detect Next.js from active project', async () => {
      const projectPath = path.join(fixturesDir, 'active-project');
      const framework = await detectFramework(projectPath);

      expect(framework).toBe('Next.js');
    });

    test('should return null for unknown framework', async () => {
      const projectPath = path.join(__dirname, 'fixtures');
      const framework = await detectFramework(projectPath);

      expect(framework === null || framework === 'Unknown').toBeTruthy();
    });
  });

  describe('detectLanguage', () => {
    test('should detect TypeScript from dependencies', async () => {
      const projectPath = path.join(fixturesDir, 'new-project');
      const language = await detectLanguage(projectPath);

      expect(language).toBe('typescript');
    });

    test('should handle projects without package.json', async () => {
      const projectPath = path.join(__dirname, 'fixtures', 'context-merge');
      const language = await detectLanguage(projectPath);

      // Should default to something reasonable or null
      expect(language !== undefined).toBeTruthy();
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

      expect(stage).toBe('new');
    });

    test('should infer "active" stage for mid-development projects', async () => {
      const stats = {
        commits: 150,
        hasCICD: true,
        coverage: 65
      };

      const stage = inferStage(stats);

      expect(stage).toBe('active');
    });

    test('should infer "stable" stage for mature projects', async () => {
      const stats = {
        commits: 800,
        hasCICD: true,
        hasReleases: true,
        coverage: 90
      };

      const stage = inferStage(stats);

      expect(stage).toBe('stable');
    });

    test('should handle edge case: no commits', async () => {
      const stats = {
        commits: 0,
        hasCICD: false,
        coverage: 0
      };

      const stage = inferStage(stats);

      expect(stage).toBe('new');
    });

    test('should handle edge case: very high commits but low coverage', async () => {
      const stats = {
        commits: 1000,
        hasCICD: true,
        coverage: 10
      };

      const stage = inferStage(stats);

      // Should be active, not stable (low coverage)
      expect(stage).toBe('active');
    });
  });

  describe('autoDetect', () => {
    test('should auto-detect all project info for new project', async () => {
      const projectPath = path.join(fixturesDir, 'new-project');
      const context = await autoDetect(projectPath);

      expect(context).toBeTruthy();
      expect(context.hasOwnProperty('framework')).toBeTruthy();
      expect(context.hasOwnProperty('language')).toBeTruthy();
      expect(context.hasOwnProperty('stage')).toBeTruthy();
      expect(context.hasOwnProperty('confidence')).toBeTruthy();

      expect(context.framework).toBe('Next.js');
      expect(context.language).toBe('typescript');
    });

    test('should calculate confidence score', async () => {
      const projectPath = path.join(fixturesDir, 'active-project');
      const context = await autoDetect(projectPath);

      expect(context.confidence >= 0 && context.confidence <= 1).toBeTruthy();
    });

    test('should detect CI/CD presence', async () => {
      const projectPath = path.join(fixturesDir, 'active-project');
      const context = await autoDetect(projectPath);

      expect(context.hasOwnProperty('hasCICD')).toBeTruthy();
    });

    test('should handle project without git', async () => {
      const projectPath = path.join(fixturesDir, 'new-project');
      const context = await autoDetect(projectPath);

      // Should not throw, should return defaults
      expect(context).toBeTruthy();
      expect(context.stage).toBeTruthy();
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
        // Ignore cleanup errors - test directories may not exist
        console.warn('Test cleanup warning:', err.message);
      }
    });

    test('should save context to .forge/context.json', async () => {
      // saveContext now expects flat shape (Greptile feedback + SonarCloud fix)
      const context = {
        framework: 'Next.js',
        language: 'typescript',
        stage: 'active',
        confidence: 0.85
      };

      await saveContext(context, testProjectPath);

      const contextPath = path.join(testProjectPath, '.forge', 'context.json');
      expect(fs.existsSync(contextPath)).toBeTruthy();

      const saved = JSON.parse(await fs.promises.readFile(contextPath, 'utf8'));
      expect(saved.auto_detected.framework).toBe('Next.js');
      expect(saved.auto_detected.stage).toBe('active');
      expect(saved.last_updated).toBeTruthy();
    });

    test('should load saved context', async () => {
      // saveContext now expects flat shape (Greptile feedback + SonarCloud fix)
      const original = {
        framework: 'Next.js',
        language: 'typescript',
        stage: 'active',
        confidence: 0.85
      };

      await saveContext(original, testProjectPath);
      const loaded = await loadContext(testProjectPath);

      expect(loaded.auto_detected.framework).toBe('Next.js');
      expect(loaded.auto_detected.stage).toBe('active');
      // user_provided is now always {} since saveContext only takes flat shape
      expect(loaded.user_provided).toBeTruthy();
    });

    test('should return null for non-existent context', async () => {
      const nonExistentPath = path.join(testProjectPath, 'nonexistent');
      const loaded = await loadContext(nonExistentPath);

      expect(loaded).toBe(null);
    });

    test('should handle malformed context.json gracefully', async () => {
      const contextPath = path.join(testProjectPath, '.forge', 'context.json');
      await fs.promises.mkdir(path.dirname(contextPath), { recursive: true });
      await fs.promises.writeFile(contextPath, 'invalid json{{{');

      const loaded = await loadContext(testProjectPath);

      expect(loaded).toBe(null);
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

        expect(context).toBeTruthy();
        expect(context.stage).toBeTruthy();
      } finally {
        await fs.promises.rm(emptyProjectPath, { recursive: true, force: true });
      }
    });

    test('should handle missing package.json gracefully', async () => {
      const noPackagePath = path.join(__dirname, 'fixtures', 'context-merge');

      const context = await autoDetect(noPackagePath);

      expect(context).toBeTruthy();
      // Should have defaults
      expect(context.stage).toBeTruthy();
    });
  });
});
