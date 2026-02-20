const fs = require('node:fs');
const path = require('node:path');
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { performance } = require('node:perf_hooks');

describe('Performance Benchmarks', () => {
  const rootDir = path.join(__dirname, '..');
  const packageJsonPath = path.join(rootDir, 'package.json');
  const benchmarkScriptPath = path.join(rootDir, 'scripts', 'benchmark.js');
  const gitignorePath = path.join(rootDir, '.gitignore');

  test('test:benchmark script exists in package.json', () => {
    const pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'));
    assert.ok(pkg.scripts['test:benchmark'], 'test:benchmark script should exist');
  });

  test('scripts/benchmark.js exists and is valid JS', () => {
    assert.ok(
      fs.existsSync(benchmarkScriptPath),
      'scripts/benchmark.js should exist'
    );
    // Verify it can be required without throwing
    assert.doesNotThrow(() => {
      require(benchmarkScriptPath);
    }, 'benchmark.js should be valid JavaScript');
  });

  test('benchmark script outputs JSON with required fields', () => {
    const output = execFileSync('node', [benchmarkScriptPath, '--json'], {
      cwd: rootDir,
      encoding: 'utf-8',
      timeout: 30000
    });
    const results = JSON.parse(output);
    assert.ok(Array.isArray(results), 'output should be an array of benchmarks');
    assert.ok(results.length > 0, 'should have at least one benchmark result');
    for (const result of results) {
      assert.ok(result.name, 'each result should have a name');
      assert.ok(typeof result.mean === 'number', 'each result should have a numeric mean');
      assert.ok(result.unit, 'each result should have a unit');
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
    assert.ok(elapsed < 5000, `CLI startup took ${elapsed.toFixed(0)}ms, should be <5000ms`);
  });

  test('autoDetect() completes in <2000ms', () => {
    const { autoDetect } = require(path.join(rootDir, 'lib', 'project-discovery.js'));
    const start = performance.now();
    autoDetect(rootDir);
    const elapsed = performance.now() - start;
    assert.ok(elapsed < 2000, `autoDetect took ${elapsed.toFixed(0)}ms, should be <2000ms`);
  });

  test('benchmark-results.json is in .gitignore', () => {
    const gitignore = fs.readFileSync(gitignorePath, 'utf-8');
    assert.ok(
      gitignore.includes('benchmark-results.json'),
      'benchmark-results.json should be in .gitignore'
    );
  });
});
