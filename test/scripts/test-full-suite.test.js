'use strict';

const { EventEmitter } = require('node:events');
const { describe, expect, test } = require('bun:test');

const {
  assertExactShardAssignment,
  buildShardSpecs,
  getDefaultShardCount,
  listAllFullSuiteTests,
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

    const assignedFiles = specs.flatMap((spec) => spec.files);

    expect(specs).toHaveLength(2);
    expect(assignedFiles).toHaveLength(4);
    expect(new Set(assignedFiles)).toHaveLength(4);
    expect(assignedFiles.sort()).toEqual([
      'packages/skills/test/a.test.js',
      'test/a.test.js',
      'test/b.test.js',
      'test/c.test.js',
    ]);
  });

  test('rejects duplicate test files instead of accepting overlapping shard evidence', () => {
    expect(() => buildShardSpecs([
      'test/a.test.js',
      'test/b.test.js',
      'test/overlap.test.js',
      'test/overlap.test.js',
      'test/c.test.js',
      'test/d.test.js',
    ], 4)).toThrow(/exactly one shard/);
  });

  test('rejects an omitted full-suite test file', () => {
    expect(() => assertExactShardAssignment([
      'test/a.test.js',
      'test/b.test.js',
    ], [{ files: ['test/a.test.js'] }])).toThrow(/omitted/);
  });

  test('listAllFullSuiteTests includes repo-level script tests', () => {
    expect(listAllFullSuiteTests()).toContain('scripts/release-asset.test.js');
  });

  test('runFullSuiteInParallel spawns one process per shard and succeeds when all shards pass', async () => {
    const calls = [];
    let pid = 9000;
    const spawn = (_command, args) => {
      calls.push(args);
      const child = new EventEmitter();
      child.pid = pid++;
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
    expect(calls[0]).toContain('--timeout');
    expect(calls[0]).toContain('30000');
  });

  test('registers each shard and starts it in an owned process group while preserving stdio', async () => {
    const events = [];
    const processTree = {
      reserveChild: (metadata) => {
        events.push(['reserve', metadata.label]);
        return { id: metadata.label };
      },
      registerChild: (reservation, child) => events.push(['register', reservation.id, child.pid]),
      unregisterChild: (reservation) => events.push(['unregister', reservation.id]),
      installSignalHandlers: () => () => {},
      cleanup: () => {},
    };
    let pid = 9100;
    const calls = [];
    const spawn = (_command, args, options) => {
      calls.push({ args, options });
      const child = new EventEmitter();
      child.pid = pid++;
      process.nextTick(() => child.emit('close', 0));
      return child;
    };

    const status = await runFullSuiteInParallel({ labelPrefix: 'local-full', shards: 2 }, {
      allTests: ['test/a.test.js', 'test/b.test.js'],
      durationMap: new Map([
        ['test/a.test.js', 2000],
        ['test/b.test.js', 1000],
      ]),
      processTree,
      platform: 'linux',
      spawn,
    });

    expect(status).toBe(0);
    expect(events[0][0]).toBe('reserve');
    expect(events.filter((event) => event[0] === 'register')).toHaveLength(2);
    expect(calls.every(({ options }) => options.detached === true)).toBe(true);
    expect(calls.every(({ options }) => options.windowsHide === true)).toBe(true);
    expect(calls.every(({ options }) => options.stdio === 'inherit')).toBe(true);
  });

  test('kills a child immediately when process registration fails after spawn', async () => {
    const killed = [];
    const processTree = {
      reserveChild: () => ({ id: 'failed-registration' }),
      registerChild: () => null,
      abortChild: (_reservation, child) => child.kill('SIGKILL'),
      unregisterChild: () => {},
      installSignalHandlers: () => () => {},
      cleanup: () => {},
    };
    const spawn = () => {
      const child = new EventEmitter();
      child.pid = 9300;
      child.kill = (signal) => killed.push(signal);
      process.nextTick(() => child.emit('error', new Error('spawn failed')));
      return child;
    };

    await expect(runFullSuiteInParallel({ labelPrefix: 'local-full', shards: 1 }, {
      allTests: ['test/a.test.js'],
      durationMap: new Map([['test/a.test.js', 1000]]),
      processTree,
      platform: 'linux',
      spawn,
    })).rejects.toThrow(/registered/);

    expect(killed).toEqual(['SIGKILL']);
  });

  test('runFullSuiteInParallel returns non-zero when any shard fails', async () => {
    let index = 0;
    let pid = 9200;
    const spawn = () => {
      const child = new EventEmitter();
      child.pid = pid++;
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
