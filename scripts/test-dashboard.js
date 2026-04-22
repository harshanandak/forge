#!/usr/bin/env node

/**
 * Test Quality Dashboard — collects test metrics into a JSON summary.
 *
 * Usage:
 *   node scripts/test-dashboard.js
 *   node scripts/test-dashboard.js --json
 *   node scripts/test-dashboard.js --profiles-dir test-results/profiles
 */

const fs = require('node:fs');
const path = require('node:path');

const rootDir = path.join(__dirname, '..');

function parseArgs(argv) {
  const args = {
    json: argv.includes('--json'),
    profilesDir: path.join(rootDir, 'test-results'),
  };

  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--profiles-dir') {
      args.profilesDir = path.resolve(rootDir, argv[index + 1]);
    }
  }

  return args;
}

function walk(dir, extension) {
  if (!fs.existsSync(dir)) return [];
  const results = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const absolute = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...walk(absolute, extension));
      continue;
    }
    if (absolute.endsWith(extension)) {
      results.push(absolute);
    }
  }
  return results;
}

function getTestCount() {
  const testDirs = [
    path.join(rootDir, 'test'),
    path.join(rootDir, 'test-env'),
    path.join(rootDir, 'packages', 'skills', 'test'),
  ];
  let count = 0;
  for (const dir of testDirs) {
    for (const file of walk(dir, '.js')) {
      if (!file.endsWith('.test.js') && !file.endsWith('.spec.js')) continue;
      const content = fs.readFileSync(file, 'utf-8');
      const testMatches = content.match(/\btest(?:\.skip|\.todo|\.if|\.skipIf)?\s*\(/g) || [];
      const itMatches = content.match(/\bit\s*\(/g) || [];
      const skipMatches = content.match(/\btest\.skip\s*\(/g) || [];
      count += testMatches.length + itMatches.length - skipMatches.length;
    }
  }
  return count;
}

function getCoverageThreshold() {
  const pkg = JSON.parse(fs.readFileSync(path.join(rootDir, 'package.json'), 'utf-8'));
  return pkg.c8 ? pkg.c8.lines : 0;
}

function getSkippedTestCount() {
  const testDirs = [
    path.join(rootDir, 'test'),
    path.join(rootDir, 'test-env'),
    path.join(rootDir, 'packages', 'skills', 'test'),
  ];
  let skipped = 0;
  for (const file of testDirs.flatMap((dir) => walk(dir, '.js'))) {
    if (!file.endsWith('.test.js') && !file.endsWith('.spec.js')) continue;
    const content = fs.readFileSync(file, 'utf8');
    skipped += (content.match(/\btest\.skip\s*\(/g) || []).length;
  }
  return skipped;
}

function getMutationScore() {
  const reportPath = path.join(rootDir, 'stryker-report', 'mutation.json');
  if (!fs.existsSync(reportPath)) return null;
  try {
    const report = JSON.parse(fs.readFileSync(reportPath, 'utf-8'));
    const files = Object.values(report.files || {});
    let killed = 0;
    let total = 0;
    for (const file of files) {
      for (const mutant of (file.mutants || [])) {
        total += 1;
        if (mutant.status === 'Killed') killed += 1;
      }
    }
    return total > 0 ? Math.round((killed / total) * 100) : null;
  } catch (_error) {
    return null;
  }
}

function getProfileMetrics(profilesDir) {
  const files = walk(profilesDir, '.json').filter((file) => file.endsWith('.profile.json'));
  if (files.length === 0) {
    return {
      suiteDurationMs: 0,
      slowestFiles: [],
      timedOutFiles: [],
      integrationSkipped: true,
    };
  }

  const slowest = new Map();
  const timedOut = new Set();
  let suiteDurationMs = 0;
  let integrationSkipped = false;

  for (const file of files) {
    let profile;
    try {
      profile = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (error) {
      console.warn(`Skipping malformed profile ${path.relative(rootDir, file)}: ${error.message}`);
      continue;
    }

    if (!profile || typeof profile !== 'object') {
      console.warn(`Skipping invalid profile ${path.relative(rootDir, file)}: expected object`);
      continue;
    }

    suiteDurationMs += profile.suiteDurationMs || 0;
    integrationSkipped = integrationSkipped || Boolean(profile.integrationSkipped);

    const entries = Array.isArray(profile.allFileDurations) && profile.allFileDurations.length > 0
      ? profile.allFileDurations
      : Array.isArray(profile.slowestFiles) ? profile.slowestFiles : [];
    for (const entry of entries) {
      if (!entry || typeof entry !== 'object' || typeof entry.file !== 'string') {
        continue;
      }
      slowest.set(entry.file, Math.max(slowest.get(entry.file) || 0, entry.durationMs || 0));
    }

    for (const timedOutFile of Array.isArray(profile.timedOutFiles) ? profile.timedOutFiles : []) {
      if (typeof timedOutFile !== 'string' || !timedOutFile) {
        continue;
      }
      timedOut.add(timedOutFile);
    }
  }

  return {
    suiteDurationMs,
    slowestFiles: Array.from(slowest.entries())
      .map(([file, durationMs]) => ({ file, durationMs }))
      .sort((left, right) => right.durationMs - left.durationMs)
      .slice(0, 10),
    timedOutFiles: Array.from(timedOut).sort((left, right) => left.localeCompare(right)),
    integrationSkipped,
  };
}

function getBenchmarkMetrics(profilesDir) {
  const files = walk(profilesDir, '.json').filter((file) => path.basename(file) === 'benchmark-results.json');
  if (files.length === 0) {
    return {
      groupCount: 0,
      groups: [],
      slowestGroup: null,
      totalMedianMs: 0,
    };
  }

  try {
    const benchmark = JSON.parse(fs.readFileSync(files.sort((left, right) => right.localeCompare(left))[0], 'utf8'));
    const groups = Array.isArray(benchmark.groups)
      ? benchmark.groups.map((group) => ({
        groupId: group.groupId,
        groupLabel: group.groupLabel,
        medianMs: group.medianMs || 0,
      }))
      : [];
    return {
      groupCount: groups.length,
      groups,
      slowestGroup: benchmark.slowestGroup || null,
      totalMedianMs: benchmark.totalMedianMs || groups.reduce((sum, group) => sum + group.medianMs, 0),
    };
  } catch (_error) {
    return {
      groupCount: 0,
      groups: [],
      slowestGroup: null,
      totalMedianMs: 0,
    };
  }
}

const args = parseArgs(process.argv.slice(2));
const profileMetrics = getProfileMetrics(args.profilesDir);
const benchmarkMetrics = getBenchmarkMetrics(args.profilesDir);
const dashboard = {
  benchmarks: benchmarkMetrics,
  testCount: getTestCount(),
  coverageThreshold: getCoverageThreshold(),
  eslintWarnings: 0,
  skippedTests: getSkippedTestCount(),
  mutationScore: getMutationScore(),
  suiteDurationMs: profileMetrics.suiteDurationMs,
  slowestFiles: profileMetrics.slowestFiles,
  timedOutFiles: profileMetrics.timedOutFiles,
  integrationSkipped: profileMetrics.integrationSkipped,
  timestamp: new Date().toISOString(),
};

if (args.json) {
  process.stdout.write(JSON.stringify(dashboard));
} else {
  console.log('\n  Test Quality Dashboard');
  console.log('  =====================\n');
  console.log(`  Tests:              ${dashboard.testCount}`);
  console.log(`  Coverage threshold: ${dashboard.coverageThreshold}%`);
  console.log(`  ESLint warnings:    ${dashboard.eslintWarnings}`);
  console.log(`  Skipped tests:      ${dashboard.skippedTests}`);
  console.log(`  Suite duration:     ${dashboard.suiteDurationMs}ms`);
  console.log(`  Timed out files:    ${dashboard.timedOutFiles.length}`);
  console.log(`  Integration skipped:${dashboard.integrationSkipped ? ' yes' : ' no'}`);
  console.log(`  Mutation score:     ${dashboard.mutationScore !== null ? `${dashboard.mutationScore}%` : 'N/A (run test:mutation first)'}`);
  if (dashboard.benchmarks.groupCount > 0) {
    console.log(`  Benchmarks:         ${dashboard.benchmarks.groupCount} groups (${dashboard.benchmarks.totalMedianMs}ms median total)`);
  }
  console.log(`  Generated:          ${dashboard.timestamp}`);
  if (dashboard.slowestFiles.length > 0) {
    console.log('\n  Slowest files:');
    for (const entry of dashboard.slowestFiles) {
      console.log(`   - ${entry.file}: ${entry.durationMs}ms`);
    }
  }
  if (dashboard.benchmarks.groupCount > 0) {
    console.log('\n  Benchmark medians:');
    for (const entry of dashboard.benchmarks.groups) {
      console.log(`   - ${entry.groupLabel}: ${entry.medianMs}ms`);
    }
  }
  console.log('');

  const outputPath = path.join(rootDir, 'test-dashboard.json');
  fs.writeFileSync(outputPath, JSON.stringify(dashboard, null, 2));
  console.log('  Results saved to: test-dashboard.json\n');
}

module.exports = dashboard;
