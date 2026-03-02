const fs = require('node:fs');
const path = require('node:path');
const { describe, test, expect } = require('bun:test');

describe('Mutation Testing Configuration', () => {
  const rootDir = path.join(__dirname, '..');
  const configPath = path.join(rootDir, 'stryker.config.json');
  const packageJsonPath = path.join(rootDir, 'package.json');
  const gitignorePath = path.join(rootDir, '.gitignore');

  test('stryker.config.json exists', () => {
    expect(fs.existsSync(configPath)).toBeTruthy();
  });

  test('stryker.config.json is valid JSON', () => {
    const content = fs.readFileSync(configPath, 'utf-8');
    expect(() => JSON.parse(content)).not.toThrow();
  });

  test('mutate patterns include lib/**/*.js', () => {
    const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    expect(Array.isArray(config.mutate)).toBeTruthy();
    expect(config.mutate.includes('lib/**/*.js')).toBeTruthy();
  });

  test('mutate patterns do NOT include bin/forge.js', () => {
    const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    const includesBin = config.mutate.some(pattern =>
      pattern === 'bin/forge.js' || pattern === 'bin/**/*.js'
    );
    expect(!includesBin).toBeTruthy();
  });

  test('thresholds are configured correctly', () => {
    const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    expect(config.thresholds).toBeTruthy();
    expect(config.thresholds.high).toBe(80);
    expect(config.thresholds.low).toBe(60);
    expect(config.thresholds.break).toBe(50);
  });

  test('incremental mode is enabled', () => {
    const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    expect(config.incremental).toBe(true);
  });

  test('reporters include html and json', () => {
    const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    expect(Array.isArray(config.reporters)).toBeTruthy();
    expect(config.reporters.includes('html')).toBeTruthy();
    expect(config.reporters.includes('json')).toBeTruthy();
  });

  test('test:mutation script exists in package.json', () => {
    const pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'));
    expect(pkg.scripts['test:mutation']).toBeTruthy();
    expect(pkg.scripts['test:mutation'].includes('stryker')).toBeTruthy();
  });

  test('.stryker-tmp is in .gitignore', () => {
    const gitignore = fs.readFileSync(gitignorePath, 'utf-8');
    expect(gitignore.includes('.stryker-tmp')).toBeTruthy();
  });

  test('stryker-report/ is in .gitignore', () => {
    const gitignore = fs.readFileSync(gitignorePath, 'utf-8');
    expect(gitignore.includes('stryker-report')).toBeTruthy();
  });
});
