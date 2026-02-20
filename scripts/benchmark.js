#!/usr/bin/env node

/**
 * Performance benchmark script for Forge CLI.
 * Measures CLI startup time, autoDetect, and detectFramework performance.
 *
 * Usage:
 *   node scripts/benchmark.js           # Human-readable output
 *   node scripts/benchmark.js --json    # JSON output (for CI/tests)
 */

const { execFileSync } = require('node:child_process');
const { performance } = require('node:perf_hooks');
const path = require('node:path');
const fs = require('node:fs');

const rootDir = path.join(__dirname, '..');
const ITERATIONS = 3;

function benchmarkCLIStartup() {
  const times = [];
  for (let i = 0; i < ITERATIONS; i++) {
    const start = performance.now();
    execFileSync('node', [path.join(rootDir, 'bin', 'forge.js'), '--help'], {
      cwd: rootDir,
      encoding: 'utf-8',
      timeout: 10000,
      stdio: 'pipe'
    });
    times.push(performance.now() - start);
  }
  const mean = times.reduce((a, b) => a + b, 0) / times.length;
  return { name: 'CLI startup (--help)', mean: Math.round(mean), unit: 'ms', samples: ITERATIONS };
}

function benchmarkAutoDetect() {
  const { autoDetect } = require(path.join(rootDir, 'lib', 'project-discovery.js'));
  const times = [];
  for (let i = 0; i < ITERATIONS; i++) {
    const start = performance.now();
    autoDetect(rootDir);
    times.push(performance.now() - start);
  }
  const mean = times.reduce((a, b) => a + b, 0) / times.length;
  return { name: 'autoDetect()', mean: Math.round(mean), unit: 'ms', samples: ITERATIONS };
}

function benchmarkDetectFramework() {
  const { detectFramework } = require(path.join(rootDir, 'lib', 'project-discovery.js'));
  const times = [];
  for (let i = 0; i < ITERATIONS; i++) {
    const start = performance.now();
    detectFramework(rootDir);
    times.push(performance.now() - start);
  }
  const mean = times.reduce((a, b) => a + b, 0) / times.length;
  return { name: 'detectFramework()', mean: Math.round(mean), unit: 'ms', samples: ITERATIONS };
}

const results = [
  benchmarkCLIStartup(),
  benchmarkAutoDetect(),
  benchmarkDetectFramework()
];

const jsonMode = process.argv.includes('--json');

if (jsonMode) {
  process.stdout.write(JSON.stringify(results));
} else {
  console.log('\n  Forge Performance Benchmarks');
  console.log('  ===========================\n');
  for (const r of results) {
    const status = r.mean < 1000 ? 'PASS' : r.mean < 3000 ? 'WARN' : 'SLOW';
    console.log(`  ${status}  ${r.name}: ${r.mean}${r.unit} (${r.samples} samples)`);
  }
  console.log('');

  // Write results file
  const outputPath = path.join(rootDir, 'benchmark-results.json');
  fs.writeFileSync(outputPath, JSON.stringify(results, null, 2));
  console.log(`  Results saved to: benchmark-results.json\n`);
}

module.exports = results;
