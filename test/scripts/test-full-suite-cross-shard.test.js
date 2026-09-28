'use strict';

const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { describe, expect, test } = require('bun:test');

const {
  listAllFullSuiteTests,
  main,
  parseArgs,
  resolveRunFiles,
  runFullSuiteInParallel,
} = require('../../scripts/test-full-suite');
const { partitionFiles } = require('../../scripts/lib/ci-shard-partition');

const TIMEOUT_MS = 10000;
const SUBPROCESS_TIMEOUT_MS = 30000;
const repoRoot = path.join(__dirname, '..', '..');
const scriptPath = path.join(repoRoot, 'scripts', 'test-full-suite.js');

const INVENTORY = [
  'test/a.test.js',
  'test/b.test.js',
  'test/c.test.js',
  'test/e2e/flow.test.js',
  'test/package-distribution.test.js',
];
const WEIGHTS = {
  'test/a.test.js': { linux: 400, macos: 400, windows: 400 },
  'test/b.test.js': { linux: 300, macos: 300, windows: 300 },
  'test/c.test.js': { linux: 200, macos: 200, windows: 200 },
  'test/e2e/flow.test.js': { linux: 900, macos: 900, windows: 900 },
  'test/package-distribution.test.js': { linux: 800, macos: 800, windows: 800 },
};

function fakeProcessTree() {
  return {
    cleanup: () => {},
    installSignalHandlers: () => () => {},
    registerChild: () => true,
    reserveChild: () => ({ id: 'test-child' }),
    unregisterChild: () => {},
  };
}

function captureRun() {
  const spawnedFiles = [];
  const profiles = [];
  return {
    deps: {
      allTests: INVENTORY,
      classify: () => 'unit',
      durationMap: new Map(),
      platform: 'linux',
      prepareFixtures: () => {},
      processTree: fakeProcessTree(),
      spawn: (_command, args) => {
        spawnedFiles.push(...args.filter((arg) => arg.endsWith('.test.js'))
          .map((arg) => path.relative(repoRoot, arg).replace(/\\/g, '/')));
        const child = new EventEmitter();
        child.pid = 9100 + spawnedFiles.length;
        child.stdout = new EventEmitter();
        child.stderr = new EventEmitter();
        const junitPath = args[args.indexOf('--reporter-outfile') + 1];
        fs.writeFileSync(junitPath, '<testsuites tests="1" assertions="1" failures="0" skipped="0"></testsuites>');
        process.nextTick(() => child.emit('close', 0));
        return child;
      },
      weights: WEIGHTS,
      writeDurationProfile: (options) => {
        profiles.push(options.allTests);
        return true;
      },
    },
    profiles,
    spawnedFiles,
  };
}

async function quietly(fn) {
  const originalLog = console.log;
  const lines = [];
  console.log = (...parts) => lines.push(parts.join(' '));
  try {
    return { lines, result: await fn() };
  } finally {
    console.log = originalLog;
  }
}

describe('cross-runner shard flags', () => {
  test('no flags parse to no cross-runner shard and the all suite', () => {
    const args = parseArgs([]);
    expect(args).toEqual({
      labelPrefix: 'local-full',
      shardIndex: null,
      shardTotal: null,
      shards: null,
      suite: 'all',
      timeoutMs: 30000,
      verifyPartition: false,
    });
  }, TIMEOUT_MS);

  test('--shards stays the per-runner worker budget alongside the cross-runner flags', () => {
    const args = parseArgs(['--shards', '3', '--shard-index', '1', '--shard-total', '2', '--suite', 'core']);
    expect(args.shards).toBe(3);
    expect(args.shardIndex).toBe(1);
    expect(args.shardTotal).toBe(2);
    expect(args.suite).toBe('core');
  }, TIMEOUT_MS);

  test.each([
    [['--shard-index', '0'], /must be given together/],
    [['--shard-total', '2'], /must be given together/],
    [['--shard-index', '2', '--shard-total', '2'], /must be less than --shard-total/],
    [['--shard-index', '0', '--shard-total', '0'], /--shard-total must be an integer >= 1/],
    [['--suite', 'slow'], /--suite must be one of all, core, expensive/],
    [['--verify-partition', '--shard-index', '0', '--shard-total', '2'], /--verify-partition takes --shard-total only/],
  ])('rejects %j', (argv, message) => {
    expect(() => parseArgs(argv)).toThrow(message);
  }, TIMEOUT_MS);

  test('no flags keep the exact discovered file list', () => {
    const discovered = listAllFullSuiteTests();
    const selected = resolveRunFiles(discovered, parseArgs([]), { platform: 'win32' });
    expect(selected).toBe(discovered);
  }, TIMEOUT_MS);

  test('a no-flag run spawns every discovered file exactly once', async () => {
    const run = captureRun();
    const { result } = await quietly(() => runFullSuiteInParallel({ shards: 1 }, run.deps));
    expect(result).toBe(0);
    expect([...run.spawnedFiles].sort()).toEqual([...INVENTORY].sort());
    expect(run.profiles).toEqual([INVENTORY]);
  }, TIMEOUT_MS);

  test('a sharded run executes only its suite partition on this OS', async () => {
    const core = INVENTORY.filter((file) => !file.includes('e2e') && !file.includes('package-distribution'));
    const expected = partitionFiles({ files: core, os: 'linux', shardTotal: 2, weights: WEIGHTS });
    const seen = [];
    for (const index of [0, 1]) {
      const run = captureRun();
      const { lines, result } = await quietly(() => runFullSuiteInParallel({
        shardIndex: index,
        shardTotal: 2,
        shards: 1,
        suite: 'core',
      }, run.deps));
      expect(result).toBe(0);
      expect([...run.spawnedFiles].sort()).toEqual([...expected[index].files].sort());
      expect(run.profiles[0]).toEqual(expected[index].files);
      expect(lines.some((line) => line.startsWith(`Cross-runner shard: suite=core os=linux index=${index} total=2`))).toBe(true);
      seen.push(...run.spawnedFiles);
    }
    expect(seen.sort()).toEqual(core.sort());
  }, TIMEOUT_MS);
});

describe('--verify-partition', () => {
  test('exits 0 and prints a per-OS summary when the partition is exact', async () => {
    const { lines, result } = await quietly(() => main(['--verify-partition', '--shard-total', '2'], {
      allTests: INVENTORY,
      weights: WEIGHTS,
    }));
    expect(result).toBe(0);
    for (const osName of ['linux', 'macos', 'windows']) {
      expect(lines.some((line) => line.startsWith(`Partition ${osName}: suite=all shards=2 files=5`) && line.includes('status=OK'))).toBe(true);
    }
    expect(lines.at(-1)).toBe('Partition verification: PASS');
  }, TIMEOUT_MS);

  test('exits 1 and names the violation when a shard duplicates a file', async () => {
    const duplicating = (options) => {
      const shards = partitionFiles(options);
      if (shards[0].files.length > 0 && shards.length > 1) shards[1].files.push(shards[0].files[0]);
      return shards;
    };
    const { lines, result } = await quietly(() => main(['--verify-partition', '--shard-total', '2'], {
      allTests: INVENTORY,
      partitionFiles: duplicating,
      weights: WEIGHTS,
    }));
    expect(result).toBe(1);
    expect(lines.some((line) => line.includes('status=FAIL') && line.includes('duplicates='))).toBe(true);
    expect(lines.at(-1)).toBe('Partition verification: FAIL');
  }, TIMEOUT_MS);

  test('exits 1 when a shard drops a file', async () => {
    const dropping = (options) => {
      const shards = partitionFiles(options);
      shards[0].files.pop();
      return shards;
    };
    const { result } = await quietly(() => main(['--verify-partition'], {
      allTests: INVENTORY,
      partitionFiles: dropping,
      weights: WEIGHTS,
    }));
    expect(result).toBe(1);
  }, TIMEOUT_MS);

  test('the CLI verifies the real inventory and seeded weights', () => {
    const result = spawnSync(process.execPath, [scriptPath, '--verify-partition', '--shard-total', '8'], {
      cwd: repoRoot,
      encoding: 'utf8',
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Partition verification: PASS');
  }, SUBPROCESS_TIMEOUT_MS);

  test('the CLI exits non-zero with a clear error on bad shard input', () => {
    const result = spawnSync(process.execPath, [scriptPath, '--shard-index', '3', '--shard-total', '2'], {
      cwd: repoRoot,
      encoding: 'utf8',
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('--shard-index 3 must be less than --shard-total 2');
  }, SUBPROCESS_TIMEOUT_MS);
});
