#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const rootDir = path.join(__dirname, '..');
const testDir = path.join(rootDir, 'test');
const reportDir = path.join(rootDir, 'test-results');
const PROFILE_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;

const DEFAULT_SMOKE_FILES = [
  'test/cli-flags.test.js',
  'test/commands/test.test.js',
  'test/ci-workflow.test.js',
  'test/detect-agent.test.js',
  'test/scripts/test-runner.test.js',
  'test/workflow-profiles.test.js',
];

function parseArgs(argv) {
  const args = { label: 'unit', mode: 'shard' };

  for (let index = 0; index < argv.length; index += 1) {
    const current = argv[index];
    const next = argv[index + 1];

    if (current === '--mode') args.mode = next;
    if (current === '--label') args.label = next;
    if (current === '--shard-index') args.shardIndex = Number.parseInt(next, 10);
    if (current === '--shard-total') args.shardTotal = Number.parseInt(next, 10);
  }

  return args;
}

function walkTests(dir) {
  const results = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const absolute = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (absolute === path.join(testDir, 'e2e')) continue;
      results.push(...walkTests(absolute));
      continue;
    }

    if (!entry.name.endsWith('.test.js') && !entry.name.endsWith('.spec.js')) continue;
    results.push(path.relative(rootDir, absolute).replace(/\\/g, '/'));
  }
  return results;
}

function ensureFilesExist(files) {
  return files.filter((file) => fs.existsSync(path.join(rootDir, file)));
}

function normalizePath(file) {
  return (file || '').replace(/\\/g, '/').replace(/\/+/g, '/').replace(/^\.\//, '');
}

function selectModuloShard(files, shardIndex, shardTotal) {
  if (!Number.isInteger(shardIndex) || !Number.isInteger(shardTotal) || shardTotal < 1) {
    throw new Error(`Invalid shard args: index=${shardIndex} total=${shardTotal}`);
  }
  return files.filter((_, index) => index % shardTotal === shardIndex);
}

function listProfileFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((entry) => entry.endsWith('.profile.json'))
    .map((entry) => path.join(dir, entry));
}

function readNewestProfile(dir, { now = Date.now(), maxAgeMs = PROFILE_MAX_AGE_MS } = {}) {
  const candidates = [];
  for (const file of listProfileFiles(dir)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      const timestamp = Date.parse(parsed.timestamp || '');
      if (!Number.isFinite(timestamp)) continue;
      if ((now - timestamp) > maxAgeMs) continue;
      candidates.push({ file, profile: parsed, timestamp });
    } catch (_error) {
      // Ignore invalid profile files and fall back to deterministic sharding.
    }
  }

  candidates.sort((left, right) => right.timestamp - left.timestamp || left.file.localeCompare(right.file));
  return candidates[0]?.profile || null;
}

function createDurationMap(profile) {
  const durationMap = new Map();
  for (const entry of profile?.slowestFiles || []) {
    if (!entry || typeof entry.file !== 'string') continue;
    durationMap.set(normalizePath(entry.file), Number(entry.durationMs) || 0);
  }
  return durationMap;
}

function selectRuntimeBalancedShard(files, shardIndex, shardTotal, durationMap) {
  if (!Number.isInteger(shardIndex) || !Number.isInteger(shardTotal) || shardTotal < 1) {
    throw new Error(`Invalid shard args: index=${shardIndex} total=${shardTotal}`);
  }

  const shards = Array.from({ length: shardTotal }, (_, index) => ({
    files: [],
    index,
    totalDurationMs: 0,
  }));
  const weightedFiles = files
    .map((file) => ({
      durationMs: durationMap.get(normalizePath(file)) || 0,
      file,
    }))
    .sort((left, right) => right.durationMs - left.durationMs || left.file.localeCompare(right.file));

  for (const entry of weightedFiles) {
    const targetShard = shards
      .slice()
      .sort((left, right) => left.totalDurationMs - right.totalDurationMs
        || left.files.length - right.files.length
        || left.index - right.index)[0];
    targetShard.files.push(entry.file);
    targetShard.totalDurationMs += entry.durationMs;
  }

  return shards[shardIndex].files.sort((left, right) => left.localeCompare(right));
}

function selectShard(files, shardIndex, shardTotal, durationMap = new Map()) {
  if (durationMap.size === 0) {
    return selectModuloShard(files, shardIndex, shardTotal);
  }
  return selectRuntimeBalancedShard(files, shardIndex, shardTotal, durationMap);
}

function getShardPlan(args, { allUnitTests, durationMap }) {
  if (args.mode === 'smoke') {
    return {
      files: ensureFilesExist(DEFAULT_SMOKE_FILES),
      source: 'smoke',
    };
  }

  const effectiveDurationMap = durationMap || createDurationMap(readNewestProfile(reportDir));
  return {
    files: selectShard(allUnitTests, args.shardIndex, args.shardTotal, effectiveDurationMap),
    source: effectiveDurationMap && effectiveDurationMap.size > 0 ? 'runtime-balanced' : 'modulo',
  };
}

function runTests(label, files) {
  fs.mkdirSync(reportDir, { recursive: true });
  const junitPath = path.join(reportDir, `${label}.xml`);
  const result = spawnSync('bun', [
    'test',
    '--reporter=junit',
    '--reporter-outfile',
    junitPath,
    ...files,
  ], {
    cwd: rootDir,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });

  if (result.error) {
    throw result.error;
  }

  return result.status ?? 1;
}

function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const allUnitTests = walkTests(testDir).sort((left, right) => left.localeCompare(right));
  const plan = getShardPlan(args, { allUnitTests });
  const files = plan.files;

  if (files.length === 0) {
    console.log(`No test files selected for ${args.label}`);
    return 0;
  }

  console.log(`Selected ${files.length} test file(s) for ${args.label} via ${plan.source}`);
  for (const file of files) {
    console.log(` - ${file}`);
  }

  return runTests(args.label, files);
}

if (require.main === module) {
  process.exit(main());
}

module.exports = {
  DEFAULT_SMOKE_FILES,
  PROFILE_MAX_AGE_MS,
  createDurationMap,
  ensureFilesExist,
  getShardPlan,
  listProfileFiles,
  main,
  normalizePath,
  parseArgs,
  readNewestProfile,
  runTests,
  selectModuloShard,
  selectRuntimeBalancedShard,
  selectShard,
  walkTests,
};
