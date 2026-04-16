#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const rootDir = path.join(__dirname, '..');
const testDir = path.join(rootDir, 'test');
const reportDir = path.join(rootDir, 'test-results');

const DEFAULT_SMOKE_FILES = [
  'test/cli-flags.test.js',
  'test/commands/test.test.js',
  'test/ci-workflow.test.js',
  'test/detect-agent.test.js',
  'test/scripts/test-runner.test.js',
  'test/workflow-profiles.test.js',
];

function parseArgs(argv) {
  const args = { mode: 'shard', label: 'unit' };

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

function selectShard(files, shardIndex, shardTotal) {
  if (!Number.isInteger(shardIndex) || !Number.isInteger(shardTotal) || shardTotal < 1) {
    throw new Error(`Invalid shard args: index=${shardIndex} total=${shardTotal}`);
  }
  return files.filter((_, index) => index % shardTotal === shardIndex);
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

function main() {
  const args = parseArgs(process.argv.slice(2));
  const allUnitTests = walkTests(testDir).sort((left, right) => left.localeCompare(right));
  const files = args.mode === 'smoke'
    ? ensureFilesExist(DEFAULT_SMOKE_FILES)
    : selectShard(allUnitTests, args.shardIndex, args.shardTotal);

  if (files.length === 0) {
    console.log(`No test files selected for ${args.label}`);
    return 0;
  }

  console.log(`Selected ${files.length} test file(s) for ${args.label}`);
  for (const file of files) {
    console.log(` - ${file}`);
  }

  return runTests(args.label, files);
}

process.exit(main());
