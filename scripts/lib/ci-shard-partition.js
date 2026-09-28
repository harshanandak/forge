'use strict';

// Cross-runner test partition: suite selection plus deterministic greedy
// longest-processing-time (LPT) assignment over a committed per-OS weight
// table. Pure — no filesystem or process access — so the full-suite CLI and
// the CI gate evaluator share one definition of "which runner owns a file".

// Policy tables. Change these, not the logic below.
const SUITES = Object.freeze(['all', 'core', 'expensive']);
const PARTITION_OSES = Object.freeze(['linux', 'macos', 'windows']);
// Files without a recorded timing still get assigned; timing data is never an allowlist.
const DEFAULT_WEIGHT_MS = 1000;
// `dir/**` matches everything under dir; any other entry is an exact path.
const EXPENSIVE_SUITE_PATTERNS = Object.freeze([
  'test/e2e/**',
  'test/integration/standalone-package-smoke.test.js',
  'test/integration/github-account-context.test.js',
  'test/integration/package-distribution.test.js',
  'test/package-distribution.test.js',
]);
const PLATFORM_TO_PARTITION_OS = Object.freeze({
  darwin: 'macos',
  linux: 'linux',
  win32: 'windows',
});

function normalizePath(file) {
  return (file || '').replace(/\\/g, '/').replace(/\/+/g, '/').replace(/^\.\//, '');
}

// Locale-independent UTF-16 code-unit order.
function comparePaths(left, right) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function isAbsent(value) {
  return value === null || value === undefined;
}

function parseIntegerAtLeast(value, minimum) {
  const text = String(value);
  if (!/^-?\d+$/.test(text)) return null;
  const parsed = Number(text);
  return Number.isSafeInteger(parsed) && parsed >= minimum ? parsed : null;
}

// Both flags or neither; zero-based index; 0 <= index < total; total >= 1.
function parseCrossRunnerShard({ shardIndex, shardTotal }) {
  if (isAbsent(shardIndex) && isAbsent(shardTotal)) return null;
  if (isAbsent(shardTotal) && !isAbsent(shardIndex)) {
    throw new Error('--shard-index and --shard-total must be given together');
  }
  const total = parseIntegerAtLeast(shardTotal, 1);
  if (total === null) throw new Error(`--shard-total must be an integer >= 1 (got ${JSON.stringify(shardTotal)})`);
  if (isAbsent(shardIndex)) throw new Error('--shard-index and --shard-total must be given together');
  const index = parseIntegerAtLeast(shardIndex, 0);
  if (index === null) throw new Error(`--shard-index must be an integer >= 0 (got ${JSON.stringify(shardIndex)})`);
  if (index >= total) throw new Error(`--shard-index ${index} must be less than --shard-total ${total}`);
  return { index, total };
}

function assertSuite(suite) {
  if (!SUITES.includes(suite)) {
    throw new Error(`--suite must be one of ${SUITES.join(', ')} (got ${JSON.stringify(suite)})`);
  }
  return suite;
}

function matchesPattern(file, pattern) {
  if (pattern.endsWith('/**')) return file.startsWith(pattern.slice(0, -2));
  return file === pattern;
}

function isExpensiveTest(file, patterns = EXPENSIVE_SUITE_PATTERNS) {
  const normalized = normalizePath(file);
  return patterns.some((pattern) => matchesPattern(normalized, pattern));
}

// Preserves input order and identity: `all` returns the same array.
function selectSuite(files, suite) {
  assertSuite(suite);
  if (suite === 'all') return files;
  const wantExpensive = suite === 'expensive';
  return files.filter((file) => isExpensiveTest(file) === wantExpensive);
}

function resolvePartitionOs(platform) {
  const partitionOs = PLATFORM_TO_PARTITION_OS[platform] || platform;
  if (!PARTITION_OSES.includes(partitionOs)) {
    throw new Error(`os must be one of ${PARTITION_OSES.join(', ')} (got ${JSON.stringify(platform)})`);
  }
  return partitionOs;
}

// Greedy LPT core. Heaviest first (ties by `comparePathFn`); each file goes to
// the least-loaded shard, then the one with fewer files, then the lowest index.
function assignLongestProcessingTime(entries, shardTotal, comparePathFn = comparePaths) {
  const shards = Array.from({ length: shardTotal }, (_, index) => ({ files: [], index, totalMs: 0 }));
  const ordered = [...entries].sort((left, right) => right.weightMs - left.weightMs
    || comparePathFn(left.key, right.key));
  for (const entry of ordered) {
    let target = shards[0];
    for (const shard of shards) {
      if (shard.totalMs < target.totalMs
        || (shard.totalMs === target.totalMs && shard.files.length < target.files.length)) {
        target = shard;
      }
    }
    target.files.push(entry);
    target.totalMs += entry.weightMs;
  }
  return shards.map((shard) => ({
    files: shard.files.sort((left, right) => comparePathFn(left.key, right.key)).map((entry) => entry.file),
    index: shard.index,
    totalMs: shard.totalMs,
  }));
}

function lookupWeightMs(weights, file, partitionOs) {
  const value = weights?.[normalizePath(file)]?.[partitionOs];
  return Number.isFinite(value) && value >= 0 ? value : DEFAULT_WEIGHT_MS;
}

// weights: `{ "<normalized path>": { linux, macos, windows } }` (the `files` map of test-weights.json).
function partitionFiles({ files, weights, os: platform, shardTotal }) {
  const partitionOs = resolvePartitionOs(platform);
  if (!Number.isSafeInteger(shardTotal) || shardTotal < 1) {
    throw new Error(`shardTotal must be an integer >= 1 (got ${JSON.stringify(shardTotal)})`);
  }
  const entries = files.map((file) => ({
    file,
    key: normalizePath(file),
    weightMs: lookupWeightMs(weights, file, partitionOs),
  }));
  return assignLongestProcessingTime(entries, shardTotal);
}

// Exact-union proof: every inventory file lands in exactly one shard.
function verifyPartition(inventory, shards) {
  const expected = new Set();
  const duplicates = new Set();
  for (const file of inventory) {
    if (expected.has(file)) duplicates.add(file);
    expected.add(file);
  }
  const assigned = new Set();
  const foreign = new Set();
  for (const shard of shards) {
    for (const file of shard.files) {
      if (!expected.has(file)) foreign.add(file);
      else if (assigned.has(file)) duplicates.add(file);
      assigned.add(file);
    }
  }
  const missing = [...expected].filter((file) => !assigned.has(file));
  const sorted = (values) => [...values].sort(comparePaths);
  const result = {
    duplicates: sorted(duplicates),
    foreign: sorted(foreign),
    missing: sorted(missing),
  };
  return { ...result, ok: result.duplicates.length + result.foreign.length + result.missing.length === 0 };
}

function describePartitionViolation(result) {
  return ['duplicates', 'missing', 'foreign']
    .filter((kind) => result[kind].length > 0)
    .map((kind) => `${kind}=${result[kind].join(',')}`)
    .join(' ');
}

// Throwing form of the proof, used by in-runner lane scheduling.
function assertExactShardAssignment(allTests, shardSpecs) {
  const result = verifyPartition(allTests, shardSpecs);
  if (result.foreign.length > 0) {
    throw new Error(`Test file ${result.foreign[0]} is not part of the full suite`);
  }
  if (result.duplicates.length > 0) {
    throw new Error(`Test file ${result.duplicates[0]} belongs to more than exactly one shard`);
  }
  if (result.missing.length > 0) {
    throw new Error(`Test file ${result.missing[0]} was omitted from the shard assignment`);
  }
}

module.exports = {
  DEFAULT_WEIGHT_MS,
  EXPENSIVE_SUITE_PATTERNS,
  PARTITION_OSES,
  SUITES,
  assertExactShardAssignment,
  assertSuite,
  assignLongestProcessingTime,
  comparePaths,
  describePartitionViolation,
  isExpensiveTest,
  normalizePath,
  parseCrossRunnerShard,
  partitionFiles,
  resolvePartitionOs,
  selectSuite,
  verifyPartition,
};
