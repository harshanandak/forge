#!/usr/bin/env node

const { spawnSync: defaultSpawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { performance } = require('node:perf_hooks');

const { buildProfile, parseJUnitFiles } = require('./test-profile');

const rootDir = path.join(__dirname, '..');
const DEFAULT_OUTPUT = path.join(rootDir, 'test-results', 'benchmark-results.json');
const DEFAULT_PROFILE_DIR = path.join(rootDir, 'test-results', 'benchmark-profiles');
const DEFAULT_SAMPLES = 3;
const DEFAULT_JUNIT_PATH = path.join(rootDir, 'test-results', 'test-results.xml');

const BENCHMARK_GROUPS = [
  {
    id: 'full-suite',
    label: 'Whole suite',
    command: ['bun', 'test'],
  },
  {
    id: 'pre-push-runner',
    label: 'Pre-push runner slice',
    command: ['bun', 'test', 'test/scripts/test-runner.test.js'],
  },
  {
    id: 'validation-core',
    label: 'Validation core slice',
    command: [
      'bun',
      'test',
      'test/scripts/test-profile.test.js',
      'test/scripts/test-ci-shard.test.js',
      'test/scripts/test-runner.test.js',
    ],
  },
  {
    id: 'hotspot-shell',
    label: 'Hotspot shell slice',
    command: [
      'bun',
      'test',
      'test/scripts/smart-status.conflicts.files.test.js',
      'test/scripts/smart-status.conflicts.merge-tree.test.js',
      'test/scripts/dep-guard.check-ripple.basic.test.js',
    ],
  },
  {
    id: 'validate',
    label: 'Validate command',
    command: ['bash', 'scripts/validate.sh'],
  },
];

function parseArgs(argv) {
  const args = {
    groups: [],
    json: false,
    output: DEFAULT_OUTPUT,
    profileDir: DEFAULT_PROFILE_DIR,
    samples: DEFAULT_SAMPLES,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const current = argv[index];
    const next = argv[index + 1];

    if (current === '--json') args.json = true;
    if (current === '--output') args.output = next;
    if (current === '--profile-dir') args.profileDir = next;
    if (current === '--samples') args.samples = Number.parseInt(next, 10) || DEFAULT_SAMPLES;
    if (current === '--group') args.groups.push(next);
  }

  return args;
}

function resolveGroups(groupIds = []) {
  if (groupIds.length === 0) {
    return BENCHMARK_GROUPS.map((group) => ({ ...group, command: [...group.command] }));
  }

  const byId = new Map(BENCHMARK_GROUPS.map((group) => [group.id, group]));
  const resolved = [];
  for (const id of groupIds) {
    const match = byId.get(id);
    if (!match) {
      throw new Error(`Unknown benchmark group: ${id}`);
    }
    resolved.push({ ...match, command: [...match.command] });
  }
  return resolved;
}

function roundMs(value) {
  return Math.round(value);
}

function calculateMedian(values) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return roundMs((sorted[middle - 1] + sorted[middle]) / 2);
  }
  return sorted[middle];
}

function summarizeSamples(samplesMs) {
  if (samplesMs.length === 0) {
    return {
      maxMs: 0,
      meanMs: 0,
      medianMs: 0,
      minMs: 0,
      samplesMs: [],
    };
  }
  const total = samplesMs.reduce((sum, value) => sum + value, 0);
  return {
    maxMs: Math.max(...samplesMs),
    meanMs: roundMs(total / samplesMs.length),
    medianMs: calculateMedian(samplesMs),
    minMs: Math.min(...samplesMs),
    samplesMs,
  };
}

function buildJUnitCommand(command, junitPath) {
  const [binary, subcommand, ...rest] = command;
  if (binary === 'bun' && subcommand === 'test') {
    return [
      binary,
      subcommand,
      ...rest,
      '--reporter=junit',
      '--reporter-outfile',
      junitPath,
    ];
  }
  return [...command];
}

function runCommand(command, options = {}, spawnSync = defaultSpawnSync) {
  const [binary, ...args] = command;
  const result = spawnSync(binary, args, {
    cwd: rootDir,
    encoding: 'utf8',
    stdio: 'pipe',
    ...options,
  });

  if (result.error) {
    throw result.error;
  }

  if ((result.status ?? 1) !== 0) {
    throw new Error(result.stderr || `Command failed: ${command.join(' ')}`);
  }

  return result;
}

function materializeJUnitFile(expectedPath) {
  if (fs.existsSync(expectedPath)) {
    return expectedPath;
  }

  if (fs.existsSync(DEFAULT_JUNIT_PATH)) {
    fs.mkdirSync(path.dirname(expectedPath), { recursive: true });
    fs.copyFileSync(DEFAULT_JUNIT_PATH, expectedPath);
    return expectedPath;
  }

  throw new Error(`Benchmark run did not produce JUnit output at ${expectedPath}`);
}

function buildGroupProfile(group, xmlFiles) {
  const metrics = parseJUnitFiles(xmlFiles);
  return buildProfile({
    integrationSkipped: true,
    label: `benchmark-${group.id}`,
  }, metrics);
}

function runBenchmarkGroup(group, options = {}) {
  const profileDir = path.resolve(rootDir, options.profileDir || DEFAULT_PROFILE_DIR);
  const samples = options.samples || DEFAULT_SAMPLES;
  const spawnSync = options.spawnSync || defaultSpawnSync;

  fs.mkdirSync(profileDir, { recursive: true });

  const xmlFiles = [];
  const samplesMs = [];

  for (let sampleIndex = 0; sampleIndex < samples; sampleIndex += 1) {
    const junitPath = path.join(profileDir, `${group.id}.sample-${sampleIndex + 1}.xml`);
    fs.rmSync(junitPath, { force: true });
    fs.rmSync(DEFAULT_JUNIT_PATH, { force: true });
    const command = buildJUnitCommand(group.command, junitPath);
    const start = performance.now();
    runCommand(command, {}, spawnSync);
    samplesMs.push(roundMs(performance.now() - start));
    xmlFiles.push(materializeJUnitFile(junitPath));
  }

  const summary = summarizeSamples(samplesMs);
  const profile = buildGroupProfile(group, xmlFiles);
  const profilePath = path.join(profileDir, `${group.id}.profile.json`);
  fs.writeFileSync(profilePath, JSON.stringify(profile, null, 2));

  return {
    command: group.command.join(' '),
    groupId: group.id,
    groupLabel: group.label,
    profilePath: path.relative(rootDir, profilePath).replace(/\\/g, '/'),
    samples,
    ...summary,
  };
}

function buildBenchmarkResults(groups, results, timestamp = new Date().toISOString()) {
  const totalMedianMs = results.reduce((sum, result) => sum + result.medianMs, 0);
  const slowestGroup = [...results]
    .sort((left, right) => right.medianMs - left.medianMs || left.groupId.localeCompare(right.groupId))[0] || null;

  return {
    groups: results,
    requestedGroups: groups.map((group) => group.id),
    samples: results[0]?.samples || DEFAULT_SAMPLES,
    slowestGroup: slowestGroup
      ? { groupId: slowestGroup.groupId, groupLabel: slowestGroup.groupLabel, medianMs: slowestGroup.medianMs }
      : null,
    timestamp,
    totalMedianMs,
  };
}

function formatResultLine(result) {
  return `  ${result.groupLabel}: median ${result.medianMs}ms (min ${result.minMs}ms, max ${result.maxMs}ms)`;
}

function main(argv = process.argv.slice(2), deps = {}) {
  const args = parseArgs(argv);
  const groups = resolveGroups(args.groups);
  const results = groups.map((group) => runBenchmarkGroup(group, {
    profileDir: args.profileDir,
    samples: args.samples,
    spawnSync: deps.spawnSync,
  }));

  const payload = buildBenchmarkResults(groups, results);
  const outputPath = path.resolve(rootDir, args.output || DEFAULT_OUTPUT);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, JSON.stringify(payload, null, 2));

  if (args.json) {
    process.stdout.write(JSON.stringify(payload));
    return payload;
  }

  console.log('\n  Forge Test Benchmark Baselines');
  console.log('  =============================\n');
  for (const result of results) {
    console.log(formatResultLine(result));
  }
  console.log(`\n  Total median: ${payload.totalMedianMs}ms`);
  console.log(`  Results saved to: ${path.relative(rootDir, outputPath).replace(/\\/g, '/')}\n`);
  return payload;
}

if (require.main === module) {
  main();
}

module.exports = {
  BENCHMARK_GROUPS,
  DEFAULT_OUTPUT,
  DEFAULT_PROFILE_DIR,
  DEFAULT_SAMPLES,
  buildBenchmarkResults,
  buildGroupProfile,
  buildJUnitCommand,
  calculateMedian,
  formatResultLine,
  main,
  parseArgs,
  resolveGroups,
  roundMs,
  materializeJUnitFile,
  runBenchmarkGroup,
  runCommand,
  summarizeSamples,
};
