'use strict';

const fs = require('node:fs');
const { EventEmitter } = require('node:events');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { describe, expect, spyOn, test } = require('bun:test');

const {
  aggregateShardReceipts,
  assertExactShardAssignment,
  buildShardTestArgs,
  buildShardSpecs,
  getDefaultShardCount,
  listAllFullSuiteTests,
  parseArgs,
  runFullSuiteInParallel,
  spawnShard,
} = require('../../scripts/test-full-suite');
const passingShardReceipt = '<testsuites tests="1" assertions="1" failures="0" skipped="0"></testsuites>';
const unitLabelPrefix = 'unit-full-suite';

function fakeShardChild(code, pid, args = []) {
  const child = new EventEmitter();
  child.pid = pid;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  const junitPath = args[args.indexOf('--reporter-outfile') + 1];
  if (junitPath) fs.writeFileSync(junitPath, passingShardReceipt);
  process.nextTick(() => {
    child.stdout.emit('data', '999 pass\nRan 999 tests across 99 files.\n');
    child.emit('close', code);
  });
  return child;
}


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
    expect(new Set(assignedFiles).size).toBe(4);
    expect(assignedFiles.sort()).toEqual([
      'packages/skills/test/a.test.js',
      'test/a.test.js',
      'test/b.test.js',
      'test/c.test.js',
    ]);
  });

  test('passes absolute shard files to Bun children', async () => {
    const calls = [];
    const processTree = {
      reserveChild: () => ({ id: 'absolute-paths' }),
      registerChild: (_reservation, child) => child,
      unregisterChild: () => {},
    };
    const spawn = (_command, args) => {
      calls.push(args);
      return fakeShardChild(0, undefined, args);
    };

    await spawnShard({ index: 0, files: ['test/example.test.js'] }, {
      labelPrefix: 'absolute-paths',
      processTree,
      spawn,
    });

    expect(path.isAbsolute(calls[0].at(-1))).toBe(true);
  });

  test('nested worktree copies cannot add tests to a shard', () => {
    const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-full-suite-isolation-'));
    try {
      const relativeFile = 'test/isolation-probe.test.js';
      const activeFile = path.join(fixtureRoot, relativeFile);
      const nestedFile = path.join(fixtureRoot, '.worktrees', 'stale', relativeFile);
      fs.mkdirSync(path.dirname(activeFile), { recursive: true });
      fs.mkdirSync(path.dirname(nestedFile), { recursive: true });
      fs.writeFileSync(activeFile, [
        "const { test } = require('bun:test');",
        "test('active checkout', () => {});",
      ].join('\n'));
      fs.writeFileSync(nestedFile, [
        "const { test } = require('bun:test');",
        "test('nested stale checkout', () => { throw new Error('nested copy executed'); });",
      ].join('\n'));

      const junitPath = path.join(fixtureRoot, 'test-results', 'isolation.xml');
      fs.mkdirSync(path.dirname(junitPath), { recursive: true });
      const args = buildShardTestArgs({
        junitPath,
        files: [relativeFile],
        root: fixtureRoot,
      });
      const result = spawnSync(process.env.BUN_EXE || 'bun', args, {
        cwd: fixtureRoot,
        encoding: 'utf8',
        timeout: 30000,
        windowsHide: true,
      });
      const output = `${result.stdout || ''}\n${result.stderr || ''}`;

      expect(result.status).toBe(0);
      expect(output).toContain('active checkout');
      expect(output).not.toContain('nested stale checkout');
    } finally {
      fs.rmSync(fixtureRoot, { recursive: true, force: true });
    }
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
      return fakeShardChild(0, pid++, args);
    };

    const status = await runFullSuiteInParallel({
      labelPrefix: unitLabelPrefix,
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
    expect(calls[0][calls[0].indexOf('--reporter-outfile') + 1]).toContain('unit-full-suite-shard-0.xml');
    expect(calls[0]).toContain('--timeout');
    expect(calls[0]).toContain('30000');
  });

  test('concurrent full-suite invocations use disjoint receipt directories', async () => {
    const receiptPaths = [];
    let pid = 9020;
    const createProcessTree = () => ({
      reserveChild: () => ({ id: 'concurrent-' + pid }),
      registerChild: () => true,
      unregisterChild: () => {},
      installSignalHandlers: () => () => {},
      cleanup: () => {},
    });
    const spawn = (_command, args) => {
      receiptPaths.push(args[args.indexOf('--reporter-outfile') + 1]);
      return fakeShardChild(0, pid++, args);
    };

    try {
      const statuses = await Promise.all([
        runFullSuiteInParallel({ labelPrefix: unitLabelPrefix, shards: 1 }, {
          allTests: ['test/a.test.js'],
          durationMap: new Map(),
          processTree: createProcessTree(),
          spawn,
        }),
        runFullSuiteInParallel({ labelPrefix: unitLabelPrefix, shards: 1 }, {
          allTests: ['test/a.test.js'],
          durationMap: new Map(),
          processTree: createProcessTree(),
          spawn,
        }),
      ]);

      expect(statuses).toEqual([0, 0]);
      expect(path.dirname(receiptPaths[0])).not.toBe(path.dirname(receiptPaths[1]));
    } finally {
      for (const directory of new Set(receiptPaths.map((receiptPath) => path.dirname(receiptPath)))) {
        if (path.basename(directory).startsWith('full-suite-')) {
          fs.rmSync(directory, { force: true, recursive: true });
        }
      }
    }
  });
  test('strips Git hook environment variables before spawning shards', async () => {
    let spawnedEnv;
    const processTree = {
      reserveChild: () => ({ id: 'git-env' }),
      registerChild: () => true,
      unregisterChild: () => {},
      installSignalHandlers: () => () => {},
      cleanup: () => {},
    };
    const spawn = (_command, args, options) => {
      spawnedEnv = options.env;
      return fakeShardChild(0, 9050, args);
    };

    const status = await runFullSuiteInParallel({ labelPrefix: unitLabelPrefix, shards: 1 }, {
      allTests: ['test/a.test.js'],
      durationMap: new Map([['test/a.test.js', 1000]]),
      env: {
        KEEP_ME: 'yes',
        GIT_DIR: '.git',
        GIT_WORK_TREE: 'C:/stale-worktree',
        GIT_INDEX_FILE: 'C:/stale-index',
      },
      processTree,
      spawn,
    });

    expect(status).toBe(0);
    expect(spawnedEnv).toEqual({ KEEP_ME: 'yes' });
  });

  test('spawnShard confines receipt deletion and output to the report directory', async () => {
    let deleteCalls = 0;
    let spawnCalls = 0;
    const remove = spyOn(fs, 'rmSync').mockImplementation(() => {
      deleteCalls += 1;
    });
    const processTree = {
      reserveChild: () => ({ id: 'receipt-path' }),
      registerChild: () => true,
      unregisterChild: () => {},
    };
    const spawn = (_command, args) => {
      spawnCalls += 1;
      const junitPath = args[args.indexOf('--reporter-outfile') + 1];
      if (junitPath.includes('outside')) {
        const child = new EventEmitter();
        child.pid = 9060;
        process.nextTick(() => child.emit('error', new Error('unsafe spawn')));
        return child;
      }
      return fakeShardChild(0, 9061, args);
    };

    try {
      const traversal = ['..', '..', 'outside'].join(path.sep);
      await expect(spawnShard({ files: ['test/a.test.js'], index: 0 }, {
        labelPrefix: traversal,
        processTree,
        spawn,
      })).rejects.toThrow(/label prefix/i);
      expect(deleteCalls).toBe(0);
      expect(spawnCalls).toBe(0);

      await expect(spawnShard({ files: ['test/a.test.js'], index: 0 }, {
        labelPrefix: unitLabelPrefix,
        processTree,
        spawn,
      })).resolves.toEqual({ code: 0, index: 0, output: passingShardReceipt });
      expect(deleteCalls).toBe(1);
      expect(spawnCalls).toBe(1);
    } finally {
      remove.mockRestore();
    }
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
      return fakeShardChild(0, pid++, args);
    };

    const status = await runFullSuiteInParallel({ labelPrefix: unitLabelPrefix, shards: 2 }, {
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

    expect(await runFullSuiteInParallel({ labelPrefix: unitLabelPrefix, shards: 1 }, {
      allTests: ['test/a.test.js'],
      durationMap: new Map([['test/a.test.js', 1000]]),
      processTree,
      platform: 'linux',
      spawn,
    })).toBe(1);

    expect(killed).toEqual(['SIGKILL']);
  });

  test('runFullSuiteInParallel returns non-zero when any shard fails', async () => {
    let index = 0;
    let pid = 9200;
    const spawn = (_command, args) => {
      const child = fakeShardChild(index === 0 ? 0 : 1, pid++, args);
      index += 1;
      return child;
    };

    const status = await runFullSuiteInParallel({
      labelPrefix: unitLabelPrefix,
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

  test('runFullSuiteInParallel reports a child process error as incomplete', async () => {
    const spawn = () => {
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.pid = 9400;
      child.stderr = new EventEmitter();
      process.nextTick(() => child.emit('error', new Error('spawn failed')));
      return child;
    };

    const status = await runFullSuiteInParallel({ labelPrefix: unitLabelPrefix, shards: 1 }, {
      allTests: ['test/a.test.js'],
      durationMap: new Map([['test/a.test.js', 1000]]),
      spawn,
    });

    expect(status).toBe(1);
  });

  test('runFullSuiteInParallel preserves a captured signal when a shard errors and a sibling hangs', async () => {
    const cleanupSignals = [];
    const logs = [];
    let childIndex = 0;
    let timeout;
    const processTree = {
      reserveChild: () => ({ id: 'fatal-' + childIndex }),
      registerChild: () => true,
      unregisterChild: () => {},
      installSignalHandlers: (handler) => {
        handler('SIGTERM');
        return () => {};
      },
      cleanup: (signal) => cleanupSignals.push(signal),
    };
    const log = spyOn(console, 'log').mockImplementation((message) => logs.push(message));

    try {
      const status = await Promise.race([
        runFullSuiteInParallel({ labelPrefix: unitLabelPrefix, shards: 2 }, {
          allTests: ['test/a.test.js', 'test/b.test.js'],
          durationMap: new Map(),
          processTree,
          spawn: () => {
            const child = new EventEmitter();
            child.pid = 9450 + childIndex;
            if (childIndex === 0) {
              process.nextTick(() => {
                const error = new Error('spawn EACCES');
                error.code = 'EACCES';
                child.emit('error', error);
              });
            }
            childIndex += 1;
            return child;
          },
        }),
        new Promise((_, reject) => {
          timeout = setTimeout(() => reject(new Error('full-suite error cleanup timed out')), 1000);
        }),
      ]);

      expect(status).toBe(143);
      expect(logs).toContain('Full suite aggregate: status=INCOMPLETE tests=0 assertions=0 passed=0 failed=0 errors=0 skipped=0');
      expect(logs).toContain('Full suite exit: 143');
      expect(cleanupSignals).toEqual(['SIGKILL']);
    } finally {
      clearTimeout(timeout);
      log.mockRestore();
    }
  });
  test('runFullSuiteInParallel never reports PASS after a signal', async () => {
    let signalHandler;
    const processTree = {
      reserveChild: () => ({ id: 'signal' }),
      registerChild: () => true,
      unregisterChild: () => {},
      installSignalHandlers: (handler) => {
        signalHandler = handler;
        return () => {};
      },
      cleanup: () => {},
    };
    const logs = [];
    const log = spyOn(console, 'log').mockImplementation((message) => logs.push(message));
    try {
      const status = await runFullSuiteInParallel({ labelPrefix: unitLabelPrefix, shards: 1 }, {
        allTests: ['test/a.test.js'],
        durationMap: new Map([['test/a.test.js', 1000]]),
        processTree,
        spawn: (_command, args) => {
          const child = fakeShardChild(0, 9500, args);
          process.nextTick(() => signalHandler('SIGTERM'));
          return child;
        },
      });
      expect(status).toBe(143);
    } finally {
      log.mockRestore();
    }
    expect(logs.some((line) => line.includes('status=INCOMPLETE'))).toBe(true);
  });
  test('runFullSuiteInParallel fails closed when no tests are discovered', async () => {
    const logs = [];
    const log = spyOn(console, 'log').mockImplementation((message) => logs.push(message));
    try {
      expect(await runFullSuiteInParallel({ labelPrefix: unitLabelPrefix }, {
        allTests: [],
        durationMap: new Map(),
      })).toBe(1);
    } finally {
      log.mockRestore();
    }

    expect(logs).toContain('Full suite aggregate: status=INCOMPLETE tests=0 assertions=0 passed=0 failed=0 errors=0 skipped=0');
    expect(logs).toContain('Full suite exit: 1');
  });

  test('zero discovery preserves captured signal exits while remaining incomplete', async () => {
    for (const [signal, expectedExit] of [['SIGINT', 130], ['SIGTERM', 143]]) {
      const logs = [];
      const log = spyOn(console, 'log').mockImplementation((message) => logs.push(message));
      const processTree = {
        installSignalHandlers: (handler) => {
          handler(signal);
          return () => {};
        },
        cleanup: () => {},
      };
      try {
        expect(await runFullSuiteInParallel({}, {
          allTests: [],
          durationMap: new Map(),
          processTree,
        })).toBe(expectedExit);
      } finally {
        log.mockRestore();
      }
      expect(logs).toContain('Full suite aggregate: status=INCOMPLETE tests=0 assertions=0 passed=0 failed=0 errors=0 skipped=0');
      expect(logs).toContain('Full suite exit: ' + expectedExit);
    }
  });
  test('aggregates complete shard receipts and fails closed when one is malformed', () => {
    for (const receipt of [null, undefined]) {
      const aggregate = aggregateShardReceipts([receipt], 1);
      expect(aggregate.status).toBe('INCOMPLETE');
      expect(aggregate.exitCode).toBe(1);
    }
    expect(aggregateShardReceipts([
      { code: 0, index: 0, output: '<testsuites tests="12" assertions="15" failures="0" skipped="2"></testsuites>' },
      { code: 1, index: 1, output: '<testsuites tests="9" assertions="12" failures="1" errors="1" skipped="0"></testsuites>' },
    ], 2)).toEqual({
      assertions: 27,
      errors: 1,
      exitCode: 1,
      failed: 1,
      passed: 17,
      skipped: 2,
      status: 'FAIL',
      tests: 21,
    });

    expect(aggregateShardReceipts([
      { code: 0, index: 0, output: '<testsuites tests="10" assertions="10" failures="0" skipped="0"></testsuites>' },
      { code: 1, index: 1, output: null },
    ], 2)).toEqual({
      errors: 0,
      assertions: 10,
      exitCode: 1,
      failed: 0,
      passed: 10,
      skipped: 0,
      status: 'INCOMPLETE',
      tests: 10,
    });

    expect(aggregateShardReceipts([
      { code: 0, index: 0, output: passingShardReceipt },
    ], 2).status).toBe('INCOMPLETE');

    expect(aggregateShardReceipts([
      { index: 0, output: passingShardReceipt },
    ], 1).status).toBe('INCOMPLETE');

    expect(aggregateShardReceipts([
      { code: 0, index: 0, output: '<testsuites tests="0" assertions="0" failures="0" skipped="0">' },
    ], 1).status).toBe('INCOMPLETE');

    expect(aggregateShardReceipts([
      { code: 0, index: 0, output: '<testsuites tests="1" assertions="1" failures="0" skipped="0">' },
    ], 1).status).toBe('INCOMPLETE');
    expect(aggregateShardReceipts([
      { code: 0, index: 0, output: 'junk<testsuites tests="1" assertions="1" failures="0" skipped="0"></testsuites>' },
    ], 1).status).toBe('INCOMPLETE');

    expect(aggregateShardReceipts([
      { code: 0, index: 0, output: passingShardReceipt + passingShardReceipt },
    ], 1).status).toBe('INCOMPLETE');

    expect(aggregateShardReceipts([
      { code: 0, index: 0, output: '<testsuites tests="1" assertions="1" failures="0" errors="nope" skipped="0"></testsuites>' },
    ], 1).status).toBe('INCOMPLETE');

    expect(aggregateShardReceipts([
      { code: 0, index: 0, output: '<testsuites tests="1" assertions="1" failures="0" errors="0" errors="0" skipped="0"></testsuites>' },
    ], 1).status).toBe('INCOMPLETE');

    expect(aggregateShardReceipts([
      { code: 0, index: 0, output: ' ' + String.fromCharCode(10) + '<?xml version="1.0" encoding="UTF-8"?>' + String.fromCharCode(10) + passingShardReceipt + String.fromCharCode(10) },
    ], 1).status).toBe('PASS');
  });
});
