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
const { createProcessTree, signalExitCode } = require('./process-tree');
const { stripGitHookEnv } = require('./test');

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

function assertExactShardAssignment(allTests, shardSpecs) {
  const expectedFiles = new Set(allTests);
  const assignedFiles = new Set();

  for (const shard of shardSpecs) {
    for (const file of shard.files) {
      if (!expectedFiles.has(file)) {
        throw new Error(`Test file ${file} is not part of the full suite`);
      }
      if (assignedFiles.has(file)) {
        throw new Error(`Test file ${file} belongs to more than exactly one shard`);
      }
      assignedFiles.add(file);
    }
  }

  for (const file of expectedFiles) {
    if (!assignedFiles.has(file)) {
      throw new Error(`Test file ${file} was omitted from the shard assignment`);
    }
  }
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
  assertExactShardAssignment(allTests, specs);
  return specs;
}

function buildShardTestArgs({ junitPath, files, root = rootDir }) {
  return [
    'test',
    '--timeout',
    '30000',
    '--reporter=junit',
    '--reporter-outfile',
    junitPath,
    ...files.map((file) => path.resolve(root, file)),
  ];
}

function aggregateShardReceipts(receipts, expectedCount) {
  const totals = {
    assertions: 0,
    errors: 0,
    failed: 0,
    passed: 0,
    skipped: 0,
    tests: 0,
  };
  const seen = new Set();
  let incomplete = receipts.length !== expectedCount;
  let failedProcess = false;

  for (const receipt of receipts) {
    if (receipt === null || typeof receipt !== 'object'
      || !Number.isInteger(receipt.index)
      || receipt.index < 0
      || receipt.index >= expectedCount
      || seen.has(receipt.index)) {
      incomplete = true;
      continue;
    }
    seen.add(receipt.index);
    if (!Number.isInteger(receipt.code)) {
      incomplete = true;
    } else {
      failedProcess ||= receipt.code !== 0;
    }

    const root = typeof receipt.output === 'string'
      ? receipt.output.match(/^\s*(?:<\?xml\b[^?]*\?>\s*)?<testsuites\b([^>]*)>[\s\S]*<\/testsuites\s*>\s*$/)
      : null;
    const openingTags = typeof receipt.output === 'string'
      ? receipt.output.match(/<testsuites\b/g) || []
      : [];
    const closingTags = typeof receipt.output === 'string'
      ? receipt.output.match(/<\/testsuites\s*>/g) || []
      : [];
    if (!root || openingTags.length !== 1 || closingTags.length !== 1) {
      incomplete = true;
      continue;
    }

    const readAttribute = (name) => root[1].match(new RegExp(`\\b${name}="(\\d+)"`));
    const values = ['tests', 'assertions', 'failures', 'skipped'].map(readAttribute);
    const errorsOccurrences = root[1].match(/\berrors\s*=/g) || [];
    const errorsAttribute = readAttribute('errors');
    if (values.some((value) => !value)
      || errorsOccurrences.length > 1
      || (errorsOccurrences.length === 1 && !errorsAttribute)) {
      incomplete = true;
      continue;
    }
    const tests = Number.parseInt(values[0][1], 10);
    const assertions = Number.parseInt(values[1][1], 10);
    const failed = Number.parseInt(values[2][1], 10);
    const errors = Number.parseInt(errorsAttribute?.[1] || '0', 10);
    const skipped = Number.parseInt(values[3][1], 10);
    const passed = tests - failed - errors - skipped;
    if (tests === 0 || passed < 0) {
      incomplete = true;
      continue;
    }

    totals.tests += tests;
    totals.assertions += assertions;
    totals.passed += passed;
    totals.failed += failed;
    totals.errors += errors;
    totals.skipped += skipped;
  }

  incomplete ||= seen.size !== expectedCount;
  const status = incomplete
    ? 'INCOMPLETE'
    : (failedProcess || totals.failed > 0 || totals.errors > 0 ? 'FAIL' : 'PASS');
  return { ...totals, exitCode: status === 'PASS' ? 0 : 1, status };
}

function spawnShard(shard, options = {}) {
  const spawn = options.spawn || defaultSpawn;
  const env = options.env || process.env;
  const bunCommand = options.bunCommand || env.BUN_EXE || process.env.BUN_EXE || 'bun';
  const labelPrefix = options.labelPrefix || 'local-full';
  const targetReportDir = options.reportDirectory || reportDir;
  const platform = options.platform || process.platform;
  const processTree = options.processTree || createProcessTree({ env, platform });
  const resolvedReportDir = path.resolve(targetReportDir);
  const junitPath = path.resolve(resolvedReportDir, `${labelPrefix}-shard-${shard.index}.xml`);
  if (path.dirname(junitPath) !== resolvedReportDir) {
    return Promise.reject(new Error('label prefix must produce a receipt directly inside test-results'));
  }
  fs.mkdirSync(resolvedReportDir, { recursive: true });

  return new Promise((resolve, reject) => {
    const reservation = processTree.reserveChild({
      command: bunCommand,
      kind: 'test-shard',
      label: `${labelPrefix}-shard-${shard.index}`,
    });
    if (!reservation) {
      reject(new Error('test shard ownership manifest is unavailable'));
      return;
    }

    let child;
    let settled = false;
    const finish = (code, output) => {
      if (settled) return;
      settled = true;
      processTree.unregisterChild(reservation);
      resolve({ code, index: shard.index, output });
    };
    try {
      fs.rmSync(junitPath, { force: true });
      child = spawn(bunCommand, buildShardTestArgs({
        junitPath,
        files: shard.files,
      }), {
        cwd: rootDir,
        env,
        shell: false,
        stdio: 'inherit',
        detached: platform !== 'win32',
        windowsHide: true,
      });
      child.on('error', (error) => {
        if (settled) return;
        settled = true;
        processTree.unregisterChild(reservation);
        reject(error);
      });
      if (!processTree.registerChild(reservation, child)) {
        settled = true;
        if (typeof processTree.abortChild === 'function') {
          processTree.abortChild(reservation, child);
        } else {
          try {
            child.kill?.('SIGKILL');
          } finally {
            processTree.cleanup?.('SIGKILL');
            processTree.unregisterChild(reservation);
          }
        }
        reject(new Error('test shard process could not be registered'));
        return;
      }
    } catch (error) {
      if (!settled) processTree.unregisterChild(reservation);
      reject(error);
      return;
    }

    child.on('close', (code) => {
      let output = null;
      try {
        output = fs.readFileSync(junitPath, 'utf8');
      } catch {}
      finish(code ?? 1, output);
    });
  });
}

async function runFullSuiteInParallel(args = {}, deps = {}) {
  const env = deps.env || process.env;
  const platform = deps.platform || process.platform;
  const processTree = deps.processTree || createProcessTree({ env, platform });
  let signal = null;
  let completed = false;
  const removeSignalHandlers = processTree.installSignalHandlers((received) => {
    signal = received;
  });

  try {
    const allTests = deps.allTests || listAllFullSuiteTests();
    const shardTotal = Number.isInteger(args.shards) && args.shards > 0
      ? args.shards
      : getDefaultShardCount(deps.cpuCount);
    const profile = deps.profile || readNewestProfile(reportDir);
    const durationMap = deps.durationMap || createDurationMap(profile);
    const shardSpecs = buildShardSpecs(allTests, shardTotal, durationMap);

    if (shardSpecs.length === 0) {
      const exitCode = signal ? signalExitCode(signal) : 1;
      console.log('Full suite aggregate: status=INCOMPLETE tests=0 assertions=0 passed=0 failed=0 errors=0 skipped=0');
      console.log('Full suite exit: ' + exitCode);
      completed = true;
      return exitCode;
    }

    fs.mkdirSync(reportDir, { recursive: true });
    const runReportDir = fs.mkdtempSync(path.join(reportDir, 'full-suite-'));

    console.log(`Running local full suite in ${shardSpecs.length} shard(s)`);
    const childEnv = stripGitHookEnv(
      typeof processTree.envFor === 'function' ? processTree.envFor(env) : env,
    );
    let results;
    try {
      results = await Promise.all(shardSpecs.map((shard) => spawnShard(shard, {
        bunCommand: deps.bunCommand,
        env: childEnv,
        labelPrefix: args.labelPrefix,
        reportDirectory: runReportDir,
        spawn: deps.spawn,
        platform,
        processTree,
      })));
    } catch (error) {
      console.error('Full suite shard execution failed:', error);
      const exitCode = signal ? signalExitCode(signal) : 1;
      console.log('Full suite aggregate: status=INCOMPLETE tests=0 assertions=0 passed=0 failed=0 errors=0 skipped=0');
      console.log('Full suite exit: ' + exitCode);
      return exitCode;
    }

    const aggregate = aggregateShardReceipts(results, shardSpecs.length);
    const exitCode = signal ? signalExitCode(signal) : aggregate.exitCode;
    if (signal) aggregate.status = 'INCOMPLETE';
    console.log(`Full suite aggregate: status=${aggregate.status} tests=${aggregate.tests} assertions=${aggregate.assertions} passed=${aggregate.passed} failed=${aggregate.failed} errors=${aggregate.errors} skipped=${aggregate.skipped}`);
    console.log(`Full suite exit: ${exitCode}`);
    completed = true;
    return exitCode;
  } finally {
    removeSignalHandlers();
    processTree.cleanup(signal || !completed ? 'SIGKILL' : 'SIGTERM');
  }
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
  aggregateShardReceipts,
  assertExactShardAssignment,
  buildShardTestArgs,
  buildShardSpecs,
  getDefaultShardCount,
  listAllFullSuiteTests,
  main,
  parseArgs,
  runFullSuiteInParallel,
  spawnShard,
  walkAllTests,
};
