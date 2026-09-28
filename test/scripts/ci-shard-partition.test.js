'use strict';

const { describe, expect, test } = require('bun:test');

const {
  DEFAULT_WEIGHT_MS,
  EXPENSIVE_SUITE_PATTERNS,
  comparePaths,
  parseCrossRunnerShard,
  partitionFiles,
  selectSuite,
  verifyPartition,
} = require('../../scripts/lib/ci-shard-partition');

const TIMEOUT_MS = 5000;

describe('parseCrossRunnerShard', () => {
  test('omitting both flags means no cross-runner shard', () => {
    expect(parseCrossRunnerShard({ shardIndex: null, shardTotal: null })).toBeNull();
  }, TIMEOUT_MS);

  test('accepts a zero-based index below the total', () => {
    expect(parseCrossRunnerShard({ shardIndex: '0', shardTotal: '1' })).toEqual({ index: 0, total: 1 });
    expect(parseCrossRunnerShard({ shardIndex: '7', shardTotal: '8' })).toEqual({ index: 7, total: 8 });
  }, TIMEOUT_MS);

  test.each([
    [{ shardIndex: '0', shardTotal: null }, /--shard-index and --shard-total must be given together/],
    [{ shardIndex: null, shardTotal: '2' }, /--shard-index and --shard-total must be given together/],
    [{ shardIndex: '0', shardTotal: '0' }, /--shard-total must be an integer >= 1/],
    [{ shardIndex: '0', shardTotal: '-1' }, /--shard-total must be an integer >= 1/],
    [{ shardIndex: '0', shardTotal: '1.5' }, /--shard-total must be an integer >= 1/],
    [{ shardIndex: '0', shardTotal: 'two' }, /--shard-total must be an integer >= 1/],
    [{ shardIndex: '-1', shardTotal: '2' }, /--shard-index must be an integer >= 0/],
    [{ shardIndex: 'x', shardTotal: '2' }, /--shard-index must be an integer >= 0/],
    [{ shardIndex: '2', shardTotal: '2' }, /--shard-index 2 must be less than --shard-total 2/],
    [{ shardIndex: undefined, shardTotal: '' }, /--shard-total must be an integer >= 1/],
  ])('rejects %j', (input, message) => {
    expect(() => parseCrossRunnerShard(input)).toThrow(message);
  }, TIMEOUT_MS);
});

describe('selectSuite', () => {
  const inventory = [
    'scripts/release-asset.test.js',
    'test/e2e/kernel-default-cli.test.js',
    'test/e2e/nested/deep.test.js',
    'test/e2e.test.js',
    'test/integration/github-account-context.test.js',
    'test/integration/package-distribution.test.js',
    'test/integration/standalone-package-smoke.test.js',
    'test/integration/other.test.js',
    'test/package-distribution.test.js',
    'test/protected-state-surfaces.test.js',
  ];
  const expensive = [
    'test/e2e/kernel-default-cli.test.js',
    'test/e2e/nested/deep.test.js',
    'test/integration/github-account-context.test.js',
    'test/integration/package-distribution.test.js',
    'test/integration/standalone-package-smoke.test.js',
    'test/package-distribution.test.js',
  ];

  test('the expensive group is exactly the design globs', () => {
    expect(EXPENSIVE_SUITE_PATTERNS).toEqual([
      'test/e2e/**',
      'test/integration/standalone-package-smoke.test.js',
      'test/integration/github-account-context.test.js',
      'test/integration/package-distribution.test.js',
      'test/package-distribution.test.js',
    ]);
    expect(selectSuite(inventory, 'expensive')).toEqual(expensive);
  }, TIMEOUT_MS);

  test('core is everything else and the two suites partition the inventory', () => {
    const core = selectSuite(inventory, 'core');
    expect(core).toEqual(inventory.filter((file) => !expensive.includes(file)));
    expect(core).toContain('test/e2e.test.js');
    expect([...core, ...selectSuite(inventory, 'expensive')].sort(comparePaths))
      .toEqual([...inventory].sort(comparePaths));
  }, TIMEOUT_MS);

  test('all returns the inventory unchanged and backslash paths still match', () => {
    expect(selectSuite(inventory, 'all')).toEqual(inventory);
    expect(selectSuite(['test\\e2e\\a.test.js'], 'expensive')).toEqual(['test\\e2e\\a.test.js']);
  }, TIMEOUT_MS);

  test('rejects an unknown suite', () => {
    expect(() => selectSuite(inventory, 'slow')).toThrow(/--suite must be one of all, core, expensive/);
  }, TIMEOUT_MS);
});

describe('partitionFiles', () => {
  test('greedy LPT balances a known fixture', () => {
    const weights = {
      'a.test.js': { linux: 8 },
      'b.test.js': { linux: 7 },
      'c.test.js': { linux: 6 },
      'd.test.js': { linux: 5 },
      'e.test.js': { linux: 4 },
    };
    const shards = partitionFiles({
      files: Object.keys(weights),
      os: 'linux',
      shardTotal: 2,
      weights,
    });
    // LPT: a(8)->0, b(7)->1, c(6)->1 (13), d(5)->0 (13), e(4)->0 (17).
    expect(shards).toEqual([
      { files: ['a.test.js', 'd.test.js', 'e.test.js'], index: 0, totalMs: 17 },
      { files: ['b.test.js', 'c.test.js'], index: 1, totalMs: 13 },
    ]);
  }, TIMEOUT_MS);

  test('uses the requested OS column', () => {
    const weights = {
      'a.test.js': { linux: 1, windows: 100 },
      'b.test.js': { linux: 50, windows: 1 },
    };
    const [shard] = partitionFiles({ files: ['a.test.js', 'b.test.js'], os: 'windows', shardTotal: 1, weights });
    expect(shard.totalMs).toBe(101);
  }, TIMEOUT_MS);

  test('is deterministic, including ties, independent of input order', () => {
    const files = ['z.test.js', 'B.test.js', 'a.test.js', 'é.test.js', 'm.test.js', 'A.test.js'];
    const weights = Object.fromEntries(files.map((file) => [file, { linux: 10 }]));
    const first = partitionFiles({ files, os: 'linux', shardTotal: 3, weights });
    const second = partitionFiles({ files: [...files].reverse(), os: 'linux', shardTotal: 3, weights });
    expect(second).toEqual(first);
    // Code-unit order, not locale order: 'A' < 'B' < 'a' < 'm' < 'z' < 'é'.
    expect(first.map((shard) => shard.files)).toEqual([
      ['A.test.js', 'm.test.js'],
      ['B.test.js', 'z.test.js'],
      ['a.test.js', 'é.test.js'],
    ]);
  }, TIMEOUT_MS);

  test('unknown files get the default weight and are still assigned', () => {
    expect(DEFAULT_WEIGHT_MS).toBe(1000);
    const shards = partitionFiles({
      files: ['known.test.js', 'new.test.js', 'partial.test.js'],
      os: 'macos',
      shardTotal: 2,
      weights: { 'known.test.js': { macos: 1500 }, 'partial.test.js': { linux: 3 } },
    });
    expect(shards).toEqual([
      { files: ['known.test.js'], index: 0, totalMs: 1500 },
      { files: ['new.test.js', 'partial.test.js'], index: 1, totalMs: 2000 },
    ]);
  }, TIMEOUT_MS);

  test('keys weights on the normalized path', () => {
    const [shard] = partitionFiles({
      files: ['test\\x.test.js'],
      os: 'linux',
      shardTotal: 1,
      weights: { 'test/x.test.js': { linux: 42 } },
    });
    expect(shard).toEqual({ files: ['test\\x.test.js'], index: 0, totalMs: 42 });
  }, TIMEOUT_MS);

  test('more shards than files leaves empty shards, never drops a file', () => {
    const shards = partitionFiles({ files: ['a.test.js'], os: 'linux', shardTotal: 3, weights: {} });
    expect(shards.map((shard) => shard.files)).toEqual([['a.test.js'], [], []]);
  }, TIMEOUT_MS);

  test('maps node platform names and rejects an unknown OS or a bad shard total', () => {
    expect(partitionFiles({ files: ['a.test.js'], os: 'darwin', shardTotal: 1, weights: { 'a.test.js': { macos: 7 } } })[0].totalMs)
      .toBe(7);
    expect(() => partitionFiles({ files: [], os: 'freebsd', shardTotal: 1, weights: {} }))
      .toThrow(/os must be one of linux, macos, windows/);
    expect(() => partitionFiles({ files: [], os: 'linux', shardTotal: 0, weights: {} }))
      .toThrow(/shardTotal must be an integer >= 1/);
  }, TIMEOUT_MS);
});

describe('verifyPartition', () => {
  const inventory = ['a.test.js', 'b.test.js', 'c.test.js'];

  test('passes when the shards cover the inventory exactly', () => {
    expect(verifyPartition(inventory, [{ files: ['a.test.js', 'c.test.js'] }, { files: ['b.test.js'] }]))
      .toEqual({ duplicates: [], foreign: [], missing: [], ok: true });
  }, TIMEOUT_MS);

  test('reports an injected duplicate', () => {
    const result = verifyPartition(inventory, [{ files: ['a.test.js', 'b.test.js'] }, { files: ['b.test.js', 'c.test.js'] }]);
    expect(result).toEqual({ duplicates: ['b.test.js'], foreign: [], missing: [], ok: false });
  }, TIMEOUT_MS);

  test('reports an injected missing file', () => {
    const result = verifyPartition(inventory, [{ files: ['a.test.js'] }, { files: ['c.test.js'] }]);
    expect(result).toEqual({ duplicates: [], foreign: [], missing: ['b.test.js'], ok: false });
  }, TIMEOUT_MS);

  test('reports an injected foreign file', () => {
    const result = verifyPartition(inventory, [{ files: ['a.test.js', 'b.test.js', 'c.test.js', 'x.test.js'] }]);
    expect(result).toEqual({ duplicates: [], foreign: ['x.test.js'], missing: [], ok: false });
  }, TIMEOUT_MS);

  test('a duplicate in the inventory itself is a violation', () => {
    expect(verifyPartition(['a.test.js', 'a.test.js'], [{ files: ['a.test.js'] }]).ok).toBe(false);
  }, TIMEOUT_MS);
});
