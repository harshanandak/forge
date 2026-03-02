const fs = require('node:fs');
const path = require('node:path');
const { describe, test, expect } = require('bun:test');
const { execFileSync } = require('node:child_process');
const { performance } = require('node:perf_hooks');

describe('Performance Benchmarks', () => {
  const rootDir = path.join(__dirname, '..');
  const packageJsonPath = path.join(rootDir, 'package.json');
  const benchmarkScriptPath = path.join(rootDir, 'scripts', 'benchmark.js');
  const gitignorePath = path.join(rootDir, '.gitignore');

  test('test:benchmark script exists in package.json', () => {
    const pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'));
    expect(pkg.scripts['test:benchmark']).toBeTruthy();
  });

  test('scripts/benchmark.js exists and is valid JS', () => {
    expect(fs.existsSync(benchmarkScriptPath)).toBeTruthy();
    // Verify it can be required without throwing
    expect(() => {
      require(benchmarkScriptPath);
    }).not.toThrow();
  });

  test('benchmark script outputs JSON with required fields', () => {
    const output = execFileSync('node', [benchmarkScriptPath, '--json'], {
      cwd: rootDir,
      encoding: 'utf-8',
      timeout: 30000
    });
    const results = JSON.parse(output);
    expect(Array.isArray(results)).toBeTruthy();
    expect(results.length > 0).toBeTruthy();
    for (const result of results) {
      expect(result.name).toBeTruthy();
      expect(typeof result.mean === 'number').toBeTruthy();
      expect(result.unit).toBeTruthy();
    }
  });

  test('CLI startup completes in <5000ms', () => {
    const start = performance.now();
    execFileSync('node', [path.join(rootDir, 'bin', 'forge.js'), '--help'], {
      cwd: rootDir,
      encoding: 'utf-8',
      timeout: 5000
    });
    const elapsed = performance.now() - start;
    expect(elapsed < 5000).toBeTruthy();
  });

  test('autoDetect() completes in <2000ms', () => {
    const { autoDetect } = require(path.join(rootDir, 'lib', 'project-discovery.js'));
    const start = performance.now();
    autoDetect(rootDir);
    const elapsed = performance.now() - start;
    expect(elapsed < 2000).toBeTruthy();
  });

  test('benchmark-results.json is in .gitignore', () => {
    const gitignore = fs.readFileSync(gitignorePath, 'utf-8');
    expect(gitignore.includes('benchmark-results.json')).toBeTruthy();
  });
});
