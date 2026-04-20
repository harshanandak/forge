'use strict';

const { EventEmitter } = require('node:events');
const { describe, expect, test } = require('bun:test');

const {
  buildShardSpecs,
  getDefaultShardCount,
  parseArgs,
  runFullSuiteInParallel,
} = require('../../scripts/test-full-suite');

describe('scripts/test-full-suite.js', () => {
  test('parseArgs reads shard count and label prefix', () => {
    expect(parseArgs(['--shards', '3', '--label-prefix', 'bench'])).toEqual({
      labelPrefix: 'bench',
      shards: 3,
    });
  });

  test('getDefaultShardCount clamps to a conservative local parallelism limit', () => {
    expect(getDefaultShardCount(1)).toBe(1);
    expect(getDefaultShardCount(2)).toBe(2);
    expect(getDefaultShardCount(8)).toBe(4);
  });

  test('buildShardSpecs partitions all discovered files across shards', () => {
    const specs = buildShardSpecs([
      'packages/skills/test/a.test.js',
      'test/a.test.js',
      'test/b.test.js',
      'test/c.test.js',
    ], 2, new Map([
      ['test/a.test.js', 6000],
      ['test/b.test.js', 4000],
      ['test/c.test.js', 1000],
      ['packages/skills/test/a.test.js', 500],
    ]));

    expect(specs).toHaveLength(2);
    expect(specs.flatMap((spec) => spec.files).sort()).toEqual([
      'packages/skills/test/a.test.js',
      'test/a.test.js',
      'test/b.test.js',
      'test/c.test.js',
    ]);
  });

  test('runFullSuiteInParallel spawns one process per shard and succeeds when all shards pass', async () => {
    const calls = [];
    const spawn = (_command, args) => {
      calls.push(args);
      const child = new EventEmitter();
      process.nextTick(() => child.emit('close', 0));
      return child;
    };

    const status = await runFullSuiteInParallel({
      labelPrefix: 'local-full',
      shards: 2,
    }, {
      allTests: ['test/a.test.js', 'packages/skills/test/a.test.js'],
      durationMap: new Map([
        ['test/a.test.js', 2000],
        ['packages/skills/test/a.test.js', 1000],
      ]),
      spawn,
    });

    expect(status).toBe(0);
    expect(calls).toHaveLength(2);
    expect(calls[0]).toContain('--reporter=junit');
  });

  test('runFullSuiteInParallel returns non-zero when any shard fails', async () => {
    let index = 0;
    const spawn = () => {
      const child = new EventEmitter();
      const code = index === 0 ? 0 : 1;
      index += 1;
      process.nextTick(() => child.emit('close', code));
      return child;
    };

    const status = await runFullSuiteInParallel({
      labelPrefix: 'local-full',
      shards: 2,
    }, {
      allTests: ['test/a.test.js', 'test/b.test.js'],
      durationMap: new Map([
        ['test/a.test.js', 2000],
        ['test/b.test.js', 1000],
      ]),
      spawn,
    });

    expect(status).toBe(1);
  });
});
