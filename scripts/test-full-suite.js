#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn: defaultSpawn } = require('node:child_process');

const {
  createDurationMap,
  getShardPlan,
  getUnitTestRoots,
  readNewestProfile,
  walkTests,
} = require('./test-ci-shard');

const rootDir = path.join(__dirname, '..');
const reportDir = path.join(rootDir, 'test-results');

function parseArgs(argv) {
  const args = {
    labelPrefix: 'local-full',
    shards: null,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const current = argv[index];
    const next = argv[index + 1];

    if (current === '--label-prefix') args.labelPrefix = next;
    if (current === '--shards') args.shards = Number.parseInt(next, 10);
  }

  return args;
}

function getDefaultShardCount(cpuCount = os.cpus().length) {
  if (!Number.isInteger(cpuCount) || cpuCount <= 1) return 1;
  return Math.max(2, Math.min(4, cpuCount - 1));
}

function listAllFullSuiteTests() {
  const roots = [
    ...getUnitTestRoots(),
    path.join(rootDir, 'test-env'),
    path.join(rootDir, 'scripts'),
  ].filter((dir, index, array) => fs.existsSync(dir) && array.indexOf(dir) === index);

  const files = [];
  for (const root of roots) {
    if (root === path.join(rootDir, 'test')) {
      for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
        const absolute = path.join(root, entry.name);
        if (entry.isDirectory()) {
          files.push(...walkAllTests(absolute));
          continue;
        }
        if (entry.name.endsWith('.test.js') || entry.name.endsWith('.spec.js')) {
          files.push(path.relative(rootDir, absolute).replace(/\\/g, '/'));
        }
      }
      continue;
    }
    files.push(...walkTests(root));
  }

  return files.sort((left, right) => left.localeCompare(right));
}

function walkAllTests(dir) {
  const results = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const absolute = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...walkAllTests(absolute));
      continue;
    }
    if (!entry.name.endsWith('.test.js') && !entry.name.endsWith('.spec.js')) continue;
    results.push(path.relative(rootDir, absolute).replace(/\\/g, '/'));
  }
  return results;
}

function buildShardSpecs(allTests, shardTotal, durationMap = new Map()) {
  const specs = [];
  for (let shardIndex = 0; shardIndex < shardTotal; shardIndex += 1) {
    const plan = getShardPlan({
      label: `local-full-${shardIndex}`,
      mode: 'shard',
      shardIndex,
      shardTotal,
    }, {
      allUnitTests: allTests,
      durationMap,
    });
    if (plan.files.length === 0) continue;
    specs.push({
      files: plan.files,
      index: shardIndex,
      source: plan.source,
    });
  }
  return specs;
}

function spawnShard(shard, options = {}) {
  const spawn = options.spawn || defaultSpawn;
  const env = options.env || process.env;
  const labelPrefix = options.labelPrefix || 'local-full';
  fs.mkdirSync(reportDir, { recursive: true });
  const junitPath = path.join(reportDir, `${labelPrefix}-shard-${shard.index}.xml`);

  return new Promise((resolve, reject) => {
    const child = spawn('bun', [
      'test',
      '--reporter=junit',
      '--reporter-outfile',
      junitPath,
      ...shard.files,
    ], {
      cwd: rootDir,
      env,
      shell: false,
      stdio: 'inherit',
    });

    child.on('error', reject);
    child.on('close', (code) => {
      resolve(code ?? 1);
    });
  });
}

async function runFullSuiteInParallel(args = {}, deps = {}) {
  const allTests = deps.allTests || listAllFullSuiteTests();
  const shardTotal = Number.isInteger(args.shards) && args.shards > 0
    ? args.shards
    : getDefaultShardCount(deps.cpuCount);
  const profile = deps.profile || readNewestProfile(reportDir);
  const durationMap = deps.durationMap || createDurationMap(profile);
  const shardSpecs = buildShardSpecs(allTests, shardTotal, durationMap);

  if (shardSpecs.length === 0) {
    console.log('No unit test files discovered for local full-suite run');
    return 0;
  }

  console.log(`Running local full suite in ${shardSpecs.length} shard(s)`);
  const results = await Promise.all(shardSpecs.map((shard) => spawnShard(shard, {
    env: deps.env,
    labelPrefix: args.labelPrefix,
    spawn: deps.spawn,
  })));

  return results.some((code) => code !== 0) ? 1 : 0;
}

async function main(argv = process.argv.slice(2), deps = {}) {
  const args = parseArgs(argv);
  const status = await runFullSuiteInParallel(args, deps);
  return status;
}

if (require.main === module) {
  main().then((status) => {
    process.exit(status);
  }).catch((error) => {
    console.error(`test-full-suite: ${error.message}`);
    process.exit(1);
  });
}

module.exports = {
  buildShardSpecs,
  getDefaultShardCount,
  listAllFullSuiteTests,
  main,
  parseArgs,
  runFullSuiteInParallel,
  spawnShard,
  walkAllTests,
};
