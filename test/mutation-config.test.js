const fs = require('node:fs');
const path = require('node:path');
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

describe('Mutation Testing Configuration', () => {
  const rootDir = path.join(__dirname, '..');
  const configPath = path.join(rootDir, 'stryker.config.json');
  const packageJsonPath = path.join(rootDir, 'package.json');
  const gitignorePath = path.join(rootDir, '.gitignore');

  test('stryker.config.json exists', () => {
    assert.ok(fs.existsSync(configPath), 'stryker.config.json should exist in project root');
  });

  test('stryker.config.json is valid JSON', () => {
    const content = fs.readFileSync(configPath, 'utf-8');
    assert.doesNotThrow(() => JSON.parse(content), 'stryker.config.json should be valid JSON');
  });

  test('mutate patterns include lib/**/*.js', () => {
    const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    assert.ok(Array.isArray(config.mutate), 'mutate should be an array');
    assert.ok(config.mutate.includes('lib/**/*.js'), 'mutate should include lib/**/*.js');
  });

  test('mutate patterns do NOT include bin/forge.js', () => {
    const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    const includesBin = config.mutate.some(pattern =>
      pattern === 'bin/forge.js' || pattern === 'bin/**/*.js'
    );
    assert.ok(!includesBin, 'mutate should NOT include bin/forge.js (too large, limited tests)');
  });

  test('thresholds are configured correctly', () => {
    const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    assert.ok(config.thresholds, 'thresholds should be defined');
    assert.strictEqual(config.thresholds.high, 80, 'high threshold should be 80');
    assert.strictEqual(config.thresholds.low, 60, 'low threshold should be 60');
    assert.strictEqual(config.thresholds.break, 50, 'break threshold should be 50');
  });

  test('incremental mode is enabled', () => {
    const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    assert.strictEqual(config.incremental, true, 'incremental should be true for CI performance');
  });

  test('reporters include html and json', () => {
    const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    assert.ok(Array.isArray(config.reporters), 'reporters should be an array');
    assert.ok(config.reporters.includes('html'), 'reporters should include html');
    assert.ok(config.reporters.includes('json'), 'reporters should include json');
  });

  test('test:mutation script exists in package.json', () => {
    const pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'));
    assert.ok(pkg.scripts['test:mutation'], 'test:mutation script should exist');
    assert.ok(
      pkg.scripts['test:mutation'].includes('stryker'),
      'test:mutation should reference stryker'
    );
  });

  test('.stryker-tmp is in .gitignore', () => {
    const gitignore = fs.readFileSync(gitignorePath, 'utf-8');
    assert.ok(
      gitignore.includes('.stryker-tmp'),
      '.stryker-tmp should be in .gitignore'
    );
  });

  test('stryker-report/ is in .gitignore', () => {
    const gitignore = fs.readFileSync(gitignorePath, 'utf-8');
    assert.ok(
      gitignore.includes('stryker-report'),
      'stryker-report should be in .gitignore'
    );
  });
});
