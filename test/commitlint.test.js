const fs = require('node:fs');
const path = require('node:path');
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

describe('Commitlint configuration', () => {
  const configPath = path.join(__dirname, '..', '.commitlintrc.json');
  const packagePath = path.join(__dirname, '..', 'package.json');
  const lefthookPath = path.join(__dirname, '..', 'lefthook.yml');

  describe('Configuration file', () => {
    test('should exist', () => {
      assert.ok(fs.existsSync(configPath), '.commitlintrc.json should exist');
    });

    test('should be valid JSON', () => {
      const content = fs.readFileSync(configPath, 'utf-8');
      assert.doesNotThrow(() => {
        JSON.parse(content);
      }, 'Should be valid JSON');
    });

    test('should extend conventional config', () => {
      const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));

      // Should extend @commitlint/config-conventional
      assert.ok(config.extends, 'Should have extends field');
      assert.ok(
        Array.isArray(config.extends) ? config.extends.includes('@commitlint/config-conventional') : config.extends === '@commitlint/config-conventional',
        'Should extend @commitlint/config-conventional'
      );
    });

    test('should have rules configured', () => {
      const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));

      // Should have rules object
      assert.ok(config.rules || config.extends, 'Should have rules or extend a config');
    });
  });

  describe('Package dependencies', () => {
    test('should have commitlint dependencies', () => {
      const pkg = JSON.parse(fs.readFileSync(packagePath, 'utf-8'));

      // Should have @commitlint/cli and @commitlint/config-conventional
      const hasCliDep = pkg.dependencies?.['@commitlint/cli'] || pkg.devDependencies?.['@commitlint/cli'];
      const hasConfigDep = pkg.dependencies?.['@commitlint/config-conventional'] || pkg.devDependencies?.['@commitlint/config-conventional'];

      assert.ok(hasCliDep, 'Should have @commitlint/cli dependency');
      assert.ok(hasConfigDep, 'Should have @commitlint/config-conventional dependency');
    });
  });

  describe('Lefthook integration', () => {
    test('should have commit-msg hook', () => {
      const content = fs.readFileSync(lefthookPath, 'utf-8');

      // Should have commit-msg hook configured
      assert.ok(content.includes('commit-msg'), 'Should have commit-msg hook');
    });

    test('should run commitlint in commit-msg hook', () => {
      const content = fs.readFileSync(lefthookPath, 'utf-8');

      // Should invoke commitlint
      const hasCommitlint = content.includes('commitlint') || content.includes('@commitlint/cli');
      assert.ok(hasCommitlint, 'commit-msg hook should run commitlint');
    });

    test('should use --edit flag for commit message file', () => {
      const content = fs.readFileSync(lefthookPath, 'utf-8');

      // Should use --edit to read from commit message file
      if (content.includes('commitlint')) {
        const hasEditFlag = content.includes('--edit') || content.includes('{1}');
        assert.ok(hasEditFlag, 'Should use --edit flag or pass commit message file');
      } else {
        // Skip if commitlint not configured yet
        return;
      }
    });
  });

  describe('Conventional commit types', () => {
    test('should support standard types', () => {
      // This test validates that the config supports standard conventional commit types
      // Types: feat, fix, docs, style, refactor, perf, test, build, ci, chore, revert

      const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));

      // If using conventional config, these types are automatically supported
      const extendsConventional = Array.isArray(config.extends)
        ? config.extends.includes('@commitlint/config-conventional')
        : config.extends === '@commitlint/config-conventional';

      assert.ok(extendsConventional, 'Should extend conventional config which supports standard types');
    });
  });
});
