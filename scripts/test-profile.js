#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');

const PATH_BUCKET_ORDER = ['fixtures', 'testEnv', 'e2e', 'scripts', 'commands', 'lib', 'other'];
const PATH_BUCKETS = {
  commands: { durationMs: 0, files: 0, testCases: 0 },
  e2e: { durationMs: 0, files: 0, testCases: 0 },
  fixtures: { durationMs: 0, files: 0, testCases: 0 },
  lib: { durationMs: 0, files: 0, testCases: 0 },
  other: { durationMs: 0, files: 0, testCases: 0 },
  scripts: { durationMs: 0, files: 0, testCases: 0 },
  testEnv: { durationMs: 0, files: 0, testCases: 0 },
};
const FIXTURE_HINTS = ['fixture', 'fixtures', 'sandbox', 'workspace', 'repo setup'];
const SHELL_HINTS = ['bash', 'shell', '.sh', 'exec', 'spawn', 'cli', 'command', 'git', 'jq', 'bun ', 'node ', 'powershell'];

function parseArgs(argv) {
  const args = {
    inputDir: 'test-results',
    integrationSkipped: true,
    label: 'local',
    output: null,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const current = argv[index];
    const next = argv[index + 1];
    if (current === '--input-dir') args.inputDir = next;
    if (current === '--label') args.label = next;
    if (current === '--output') args.output = next;
    if (current === '--integration-skipped') args.integrationSkipped = next === 'true';
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

function parseAttributes(source) {
  const attributes = {};
  for (const match of source.matchAll(/([a-zA-Z_:][\w:.-]*)="([^"]*)"/g)) {
    attributes[match[1]] = match[2];
  }
  return attributes;
}

function normalizePathForProfile(value) {
  if (!value) return '';
  return value.replace(/\\/g, '/').replace(/\/+/g, '/').replace(/^\.\//, '');
}

function clonePathBuckets() {
  return Object.fromEntries(
    Object.entries(PATH_BUCKETS).map(([key, value]) => [key, { ...value }]),
  );
}

function createSignalMetrics() {
  return {
    durationMs: 0,
    matchedFiles: 0,
    matchedTestCases: 0,
    topFiles: [],
  };
}

function matchesFixturePath(normalizedFile) {
  return normalizedFile.includes('/fixture/')
    || normalizedFile.includes('/fixtures/')
    || normalizedFile.includes('test-env/fixtures/')
    || normalizedFile.includes('test/e2e/fixtures/')
    || normalizedFile.includes('packages/skills/test/fixtures/')
    || normalizedFile.startsWith('fixtures/')
    || normalizedFile.endsWith('/fixtures')
    || normalizedFile.endsWith('/fixture');
}

function selectPrimaryBucket(normalizedFile) {
  const matches = new Set();
  if (matchesFixturePath(normalizedFile)) matches.add('fixtures');
  if (normalizedFile.includes('test-env/')) matches.add('testEnv');
  if (normalizedFile.includes('test/e2e/')) matches.add('e2e');
  if (normalizedFile.includes('test/scripts/') || normalizedFile.includes('scripts/')) matches.add('scripts');
  if (normalizedFile.includes('test/commands/') || normalizedFile.includes('lib/commands/')) matches.add('commands');
  if (normalizedFile.includes('lib/')) matches.add('lib');

  for (const bucket of PATH_BUCKET_ORDER) {
    if (matches.has(bucket)) {
      return bucket;
    }
  }
  return 'other';
}

function classifyTestcase({ classname = '', durationMs = 0, file = '', name = '' }) {
  const normalizedFile = normalizePathForProfile(file);
  const normalizedClassname = normalizePathForProfile(classname);
  const normalizedName = name || '';
  const searchable = `${normalizedFile} ${normalizedClassname} ${normalizedName}`.toLowerCase();
  const fixtureHeavy = matchesFixturePath(normalizedFile)
    || normalizedFile.includes('test-env/')
    || normalizedFile.includes('test/e2e/')
    || FIXTURE_HINTS.some((hint) => searchable.includes(hint));
  const shellHeavy = SHELL_HINTS.some((hint) => searchable.includes(hint));

  return {
    durationMs,
    file: normalizedFile,
    fixtureHeavy,
    primaryBucket: selectPrimaryBucket(normalizedFile),
    shellHeavy,
  };
}

function accumulateFileMetrics(store, file, durationMs) {
  store.set(file, (store.get(file) || 0) + durationMs);
}

function finalizeTopFiles(fileDurations) {
  return Array.from(fileDurations.entries())
    .map(([file, durationMs]) => ({ durationMs, file }))
    .sort((left, right) => right.durationMs - left.durationMs || left.file.localeCompare(right.file))
    .slice(0, 10);
}

function finalizePathBuckets(pathBuckets, bucketFiles) {
  for (const bucket of Object.keys(pathBuckets)) {
    pathBuckets[bucket].files = bucketFiles[bucket].size;
  }
  return pathBuckets;
}

function finalizeSignalMetrics(metrics, fileDurations) {
  return {
    durationMs: metrics.durationMs,
    matchedFiles: metrics.fileSet.size,
    matchedTestCases: metrics.matchedTestCases,
    topFiles: finalizeTopFiles(fileDurations),
  };
}

function parseJUnitFiles(files) {
  const fileDurations = new Map();
  const timedOutFiles = new Set();
  const pathBuckets = clonePathBuckets();
  const bucketFiles = Object.fromEntries(Object.keys(pathBuckets).map((key) => [key, new Set()]));
  const shellHeavyFileDurations = new Map();
  const shellHeavyMetrics = { durationMs: 0, fileSet: new Set(), matchedTestCases: 0 };
  const fixtureHeavyFileDurations = new Map();
  const fixtureHeavyMetrics = { durationMs: 0, fileSet: new Set(), matchedTestCases: 0 };
  let suiteDurationMs = 0;

  for (const file of files) {
    const content = fs.readFileSync(file, 'utf8');
    for (const suiteMatch of content.matchAll(/<testsuite\b([^>]*)>/g)) {
      const attrs = parseAttributes(suiteMatch[1]);
      suiteDurationMs += Math.round(Number.parseFloat(attrs.time || '0') * 1000);
    }

    for (const caseMatch of content.matchAll(/<testcase\b([^>]*)>([\s\S]*?)<\/testcase>|<testcase\b([^>]*)\/>/g)) {
      const attrs = parseAttributes(caseMatch[1] || caseMatch[3] || '');
      const body = caseMatch[2] || '';
      const durationMs = Math.round(Number.parseFloat(attrs.time || '0') * 1000);
      const fallbackFile = path.basename(file);
      const testcase = classifyTestcase({
        classname: attrs.classname || '',
        durationMs,
        file: attrs.file || attrs.classname || attrs.name || fallbackFile,
        name: attrs.name || '',
      });

      const testcaseFile = testcase.file || normalizePathForProfile(fallbackFile);
      accumulateFileMetrics(fileDurations, testcaseFile, durationMs);
      if (/timeout/i.test(body)) {
        timedOutFiles.add(testcaseFile);
      }

      const bucket = testcase.primaryBucket;
      pathBuckets[bucket].durationMs += durationMs;
      pathBuckets[bucket].testCases += 1;
      bucketFiles[bucket].add(testcaseFile);

      if (testcase.shellHeavy) {
        shellHeavyMetrics.durationMs += durationMs;
        shellHeavyMetrics.matchedTestCases += 1;
        shellHeavyMetrics.fileSet.add(testcaseFile);
        accumulateFileMetrics(shellHeavyFileDurations, testcaseFile, durationMs);
      }

      if (testcase.fixtureHeavy) {
        fixtureHeavyMetrics.durationMs += durationMs;
        fixtureHeavyMetrics.matchedTestCases += 1;
        fixtureHeavyMetrics.fileSet.add(testcaseFile);
        accumulateFileMetrics(fixtureHeavyFileDurations, testcaseFile, durationMs);
      }
    }
  }

  return {
    fixtureHeavy: finalizeSignalMetrics(fixtureHeavyMetrics, fixtureHeavyFileDurations),
    pathBuckets: finalizePathBuckets(pathBuckets, bucketFiles),
    shellHeavy: finalizeSignalMetrics(shellHeavyMetrics, shellHeavyFileDurations),
    slowestFiles: finalizeTopFiles(fileDurations),
    suiteDurationMs,
    timedOutFiles: Array.from(timedOutFiles).sort((left, right) => left.localeCompare(right)),
  };
}

function buildProfile(args, metrics, timestamp = new Date().toISOString()) {
  return {
    fixtureHeavy: metrics.fixtureHeavy || createSignalMetrics(),
    integrationSkipped: args.integrationSkipped !== false,
    label: args.label,
    pathBuckets: metrics.pathBuckets || clonePathBuckets(),
    shellHeavy: metrics.shellHeavy || createSignalMetrics(),
    slowestFiles: metrics.slowestFiles || [],
    suiteDurationMs: metrics.suiteDurationMs || 0,
    timedOutFiles: metrics.timedOutFiles || [],
    timestamp,
  };
}

function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const inputDir = path.resolve(process.cwd(), args.inputDir);
  const files = walk(inputDir, '.xml');
  const metrics = parseJUnitFiles(files);
  const profile = buildProfile(args, metrics);

  if (args.output) {
    const outputPath = path.resolve(process.cwd(), args.output);
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, JSON.stringify(profile, null, 2));
  }

  process.stdout.write(JSON.stringify(profile));
  return profile;
}

if (require.main === module) {
  main();
}

module.exports = {
  accumulateFileMetrics,
  buildProfile,
  classifyTestcase,
  main,
  normalizePathForProfile,
  parseArgs,
  parseAttributes,
  parseJUnitFiles,
  selectPrimaryBucket,
  walk,
};
