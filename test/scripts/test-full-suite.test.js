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
  buildResourceLanePlan,
  buildShardTestArgs,
  buildShardSpecs,
  classifyTestResource,
  extractFailedTestCases,
  getDefaultShardCount,
  listAllFullSuiteTests,
  loadTestResourceMap,
  parseArgs,
  runLaneSchedule,
  runFullSuiteInParallel,
  spawnShard,
  writeDurationProfile,
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

function fakeProcessTree() {
  return {
    reserveChild: () => ({ id: 'test-child' }),
    registerChild: () => true,
    unregisterChild: () => {},
    installSignalHandlers: () => () => {},
    cleanup: () => {},
  };
}

function executionProbe() {
  const active = new Set();
  const maxActiveByLane = new Map();
  const releases = new Map();
  const started = [];
  const waiters = [];

  const notify = () => {
    for (const waiter of waiters.splice(0)) {
      if (started.length >= waiter.count) waiter.resolve();
      else waiters.push(waiter);
    }
  };

  return {
    active,
    maxActiveByLane,
    reject(id, error) {
      const release = releases.get(id);
      if (!release) throw new Error(`Task ${id} has not started`);
      releases.delete(id);
      release.reject(error);
    },
    release(id) {
      const release = releases.get(id);
      if (!release) throw new Error(`Task ${id} has not started`);
      releases.delete(id);
      release.resolve();
    },
    started,
    waitForStarted(count) {
      if (started.length >= count) return Promise.resolve();
      return new Promise((resolve) => waiters.push({ count, resolve }));
    },
    async execute(task, lane) {
      started.push(task.id);
      active.add(task.id);
      const laneActive = [...active].filter((id) => id.startsWith(lane.name[0])).length;
      maxActiveByLane.set(lane.name, Math.max(maxActiveByLane.get(lane.name) || 0, laneActive));
      notify();
      try {
        await new Promise((resolve, reject) => releases.set(task.id, { reject, resolve }));
        return task.id;
      } finally {
        active.delete(task.id);
      }
    },
  };
}


describe('scripts/test-full-suite.js', () => {
  test('parseArgs reads shard count and label prefix', () => {
    expect(parseArgs(['--shards', '3', '--label-prefix', 'bench', '--timeout', '15000'])).toEqual({
      labelPrefix: 'bench',
      shards: 3,
      timeoutMs: 15000,
    });
  });

  test('parseArgs rejects an invalid shard timeout', () => {
    expect(() => parseArgs(['--timeout', '0'])).toThrow('--timeout must be a positive integer');
    expect(() => parseArgs(['--timeout', 'not-a-number'])).toThrow('--timeout must be a positive integer');
  });

  test('buildShardTestArgs preserves an explicit shard timeout', () => {
    const args = buildShardTestArgs({
      files: ['test/example.test.js'],
      junitPath: 'test-results/example.xml',
      timeoutMs: 15000,
    });
    expect(args.slice(0, 3)).toEqual(['test', '--timeout', '15000']);
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

  test('classifies subprocess behavior through the repository smart-status and test-env helpers', () => {
    expect(classifyTestResource('test/scripts/smart-status.basics.test.js')).toBe('subprocess');
    expect(classifyTestResource('test-env/edge-cases/git-states.test.js')).toBe('subprocess');
    expect(classifyTestResource('test-env/edge-cases/permission-errors.test.js')).toBe('subprocess');
  });

  test('serializes process-heavy reliability suites', () => {
    expect(classifyTestResource('test/scripts/commitlint.test.js')).toBe('exclusive');
    expect(classifyTestResource('test/sync-agent-skills-authority.test.js')).toBe('exclusive');
  });

  test('follows two-hop CommonJS and ESM local imports, including cycles and index resolution', () => {
    const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-full-suite-classification-'));
    const write = (name, source) => {
      const target = path.join(fixtureRoot, name);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, source);
      return name;
    };

    try {
      const unit = write('unit.test.js', "import path from 'node:path';\nimport library from 'external-package';\nvoid path; void library;\n");
      const bunSpawn = write('bun-spawn.test.js', "Bun.spawn(['node', '--version']);\n");
      const markedSubprocess = write('marked-subprocess.test.js', "// forge-test-resource: subprocess\nexport const value = 1;\n");
      const commonJs = write('common-js.test.js', "// forge-test-resource: unit\nrequire('./helpers/first');\n");
      write('helpers/first.js', "module.exports = require('../cycle/second');\n");
      write('cycle/second.cjs', "require('../helpers/first');\nrequire('../process');\n");
      write('process.js', "const { spawnSync } = require('node:child_process');\nspawnSync('node', ['--version']);\n");
      const esm = write('esm.test.mjs', "import helper from './esm/helper.mjs';\nvoid helper;\n");
      write('esm/helper.mjs', "const lazy = import('../directory');\nexport default lazy;\n");
      write('directory/index.cjs', "import { execFileSync } from 'node:child_process';\nexport { execFileSync };\n");
      const exclusive = write('exclusive.test.js', "// forge-test-resource: exclusive\nconst { spawnSync } = require('node:child_process');\nspawnSync('npm', ['install']);\n");

      expect(classifyTestResource(unit, { root: fixtureRoot })).toBe('unit');
      expect(classifyTestResource(bunSpawn, { root: fixtureRoot })).toBe('subprocess');
      expect(classifyTestResource(markedSubprocess, { root: fixtureRoot })).toBe('subprocess');
      expect(classifyTestResource(commonJs, { root: fixtureRoot })).toBe('subprocess');
      expect(classifyTestResource(esm, { root: fixtureRoot })).toBe('subprocess');
      expect(classifyTestResource(exclusive, { root: fixtureRoot })).toBe('exclusive');
    } finally {
      fs.rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });

  test('fails safe for missing, out-of-root, and dynamic local imports', () => {
    const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-full-suite-fail-safe-'));
    const write = (name, source) => {
      const target = path.join(fixtureRoot, name);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, source);
      return name;
    };

    try {
      const missing = write('missing.test.js', "require('./does-not-exist');\n");
      const outside = write('outside.test.js', "require('../outside.js');\n");
      const dynamic = write('dynamic.test.js', "const name = 'helper';\nimport(`./${name}.js`);\n");

      expect(classifyTestResource(missing, { root: fixtureRoot })).toBe('subprocess');
      expect(classifyTestResource(outside, { root: fixtureRoot })).toBe('subprocess');
      expect(classifyTestResource(dynamic, { root: fixtureRoot })).toBe('subprocess');
    } finally {
      fs.rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });

  test('reads a shared helper once while preserving exact-once test results', async () => {
    const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-full-suite-memo-'));
    const reads = new Map();
    const write = (name, source) => {
      const target = path.join(fixtureRoot, name);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, source);
    };

    try {
      write('a.test.js', "require('./shared');\n");
      write('b.test.js', "require('./shared');\n");
      write('shared.js', "require('node:child_process');\n");
      const resources = await loadTestResourceMap([
        'a.test.js',
        'b.test.js',
        'a.test.js',
      ], {
        readFile(target) {
          const resolved = path.resolve(target);
          reads.set(resolved, (reads.get(resolved) || 0) + 1);
          return fs.readFileSync(resolved, 'utf8');
        },
        root: fixtureRoot,
      });

      expect(resources).toEqual(new Map([
        ['a.test.js', 'subprocess'],
        ['b.test.js', 'subprocess'],
      ]));
      expect([...reads.values()].every((count) => count === 1)).toBe(true);
      expect(reads).toHaveLength(3);
    } finally {
      fs.rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });

  test('resolves transitive imports through a canonicalized root alias', async () => {
    const fixtureParent = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-full-suite-realpath-'));
    const physicalRoot = path.join(fixtureParent, 'physical');
    const rootAlias = path.join(fixtureParent, 'logical');
    const reads = [];

    try {
      fs.mkdirSync(physicalRoot);
      const canonicalRoot = fs.realpathSync(physicalRoot);
      fs.symlinkSync(physicalRoot, rootAlias, process.platform === 'win32' ? 'junction' : 'dir');
      fs.writeFileSync(path.join(physicalRoot, 'entry.test.js'), "require('./shared');\n");
      fs.writeFileSync(path.join(physicalRoot, 'shared.js'), "require('node:child_process');\n");

      const resources = await loadTestResourceMap(['entry.test.js'], {
        readFile(target) {
          reads.push(fs.realpathSync(target));
          return fs.readFileSync(target, 'utf8');
        },
        root: rootAlias,
      });

      expect(resources.get('entry.test.js')).toBe('subprocess');
      expect(reads).toEqual([
        path.join(canonicalRoot, 'entry.test.js'),
        path.join(canonicalRoot, 'shared.js'),
      ]);
    } finally {
      fs.rmSync(fixtureParent, { recursive: true, force: true });
    }
  });

  test('buildResourceLanePlan keeps a four-worker shared budget with balanced subprocess shards', () => {
    const files = [
      ...Array.from({ length: 7 }, (_, index) => `unit-${index}.test.js`),
      ...Array.from({ length: 8 }, (_, index) => `process-${index}.test.js`),
      'exclusive-0.test.js',
      'exclusive-1.test.js',
    ];
    const classify = (file) => file.startsWith('unit-')
      ? 'unit'
      : (file.startsWith('process-') ? 'subprocess' : 'exclusive');

    const coldLanes = buildResourceLanePlan(files, 4, new Map(), {
      classify,
      subprocessShardTotal: 6,
    });
    const assigned = coldLanes.flatMap((lane) => lane.shards.flatMap((shard) => shard.files));

    expect(coldLanes.map(({ name, concurrency, shards }) => ({
      concurrency,
      name,
      shardCount: shards.length,
    }))).toEqual([
      { concurrency: 4, name: 'unit', shardCount: 4 },
      { concurrency: 3, name: 'subprocess', shardCount: 6 },
      { concurrency: 1, name: 'exclusive', shardCount: 2 },
    ]);
    expect(assigned).toHaveLength(files.length);
    expect(new Set(assigned).size).toBe(files.length);
    expect(assigned.slice().sort()).toEqual(files.slice().sort());
    expect(coldLanes.find((lane) => lane.name === 'exclusive').shards.every((shard) => shard.files.length === 1)).toBe(true);

    const completeDurations = new Map(files.map((file, index) => [file, index + 1]));
    const warmLanes = buildResourceLanePlan(files, 4, completeDurations, {
      classify,
      subprocessShardTotal: 6,
    });
    expect(warmLanes.find((lane) => lane.name === 'subprocess')).toMatchObject({
      concurrency: 3,
      name: 'subprocess',
    });
    expect(warmLanes.find((lane) => lane.name === 'subprocess').shards).toHaveLength(6);

    completeDurations.delete('process-7.test.js');
    expect(buildResourceLanePlan(files, 4, completeDurations, {
      classify,
      subprocessShardTotal: 6,
    })
      .find((lane) => lane.name === 'subprocess').concurrency).toBe(3);

    const explicitlyCapped = buildResourceLanePlan(files, 1, completeDurations, { classify });
    expect(explicitlyCapped.find((lane) => lane.name === 'unit').shards).toHaveLength(1);
    expect(explicitlyCapped.find((lane) => lane.name === 'subprocess')).toMatchObject({
      concurrency: 1,
      shards: [expect.any(Object)],
    });
  });

  test('runLaneSchedule observes unit/process/exclusive caps without timers', async () => {
    const probe = executionProbe();
    const lanes = [
      { name: 'unit', concurrency: 4, shards: ['u0', 'u1', 'u2', 'u3'].map((id) => ({ id })) },
      { name: 'subprocess', concurrency: 3, shards: ['s0', 's1', 's2', 's3', 's4', 's5'].map((id) => ({ id })) },
      { name: 'exclusive', concurrency: 1, shards: ['e0', 'e1'].map((id) => ({ id })) },
    ];
    const scheduled = runLaneSchedule(lanes, probe.execute);

    await probe.waitForStarted(4);
    expect(probe.started).toEqual(['u0', 's0', 's1', 's2']);
    expect(probe.active.size).toBe(4);
    probe.release('s0');
    await probe.waitForStarted(5);
    expect(probe.started.at(-1)).toBe('s3');
    probe.release('s1');
    await probe.waitForStarted(6);
    expect(probe.started.at(-1)).toBe('s4');
    probe.release('s2');
    await probe.waitForStarted(7);
    expect(probe.started.at(-1)).toBe('s5');
    probe.release('s3');
    probe.release('s4');
    probe.release('s5');
    expect(probe.started).not.toContain('e0');

    for (const [index, id] of ['u0', 'u1', 'u2', 'u3'].entries()) {
      probe.release(id);
      if (index < 3) {
        await probe.waitForStarted(8 + index);
        expect(probe.started.at(-1)).toBe(`u${index + 1}`);
      }
    }

    await probe.waitForStarted(11);
    expect(probe.started.at(-1)).toBe('e0');
    expect(probe.started).not.toContain('e1');
    probe.release('e0');
    await probe.waitForStarted(12);
    expect(probe.started.at(-1)).toBe('e1');
    probe.release('e1');

    expect(await scheduled).toEqual([
      'u0', 'u1', 'u2', 'u3', 's0', 's1', 's2', 's3', 's4', 's5', 'e0', 'e1',
    ]);
    expect(probe.maxActiveByLane).toEqual(new Map([
      ['unit', 1],
      ['subprocess', 3],
      ['exclusive', 1],
    ]));
  });

  test('runLaneSchedule settles in-flight shared work before propagating a failure', async () => {
    const probe = executionProbe();
    const scheduled = runLaneSchedule([
      { name: 'unit', concurrency: 4, shards: ['u0', 'u1'].map((id) => ({ id })) },
      { name: 'subprocess', concurrency: 2, shards: ['s0', 's1', 's2'].map((id) => ({ id })) },
      { name: 'exclusive', concurrency: 1, shards: [{ id: 'e0' }] },
    ], probe.execute);

    await probe.waitForStarted(3);
    expect(probe.started).toEqual(['u0', 's0', 's1']);
    probe.reject('s0', new Error('subprocess failed'));
    await Promise.resolve();
    probe.release('u0');
    probe.release('s1');

    await expect(scheduled).rejects.toThrow('subprocess failed');
    expect(probe.started).toEqual(['u0', 's0', 's1']);
    expect(probe.active.size).toBe(0);
  });

  test('passes absolute shard files to Bun children', async () => {
    const calls = [];
    const reportDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-full-suite-absolute-paths-'));
    const processTree = {
      reserveChild: () => ({ id: 'absolute-paths' }),
      registerChild: (_reservation, child) => child,
      unregisterChild: () => {},
    };
    const spawn = (_command, args) => {
      calls.push(args);
      return fakeShardChild(0, undefined, args);
    };

    try {
      await spawnShard({ index: 0, files: ['test/example.test.js'] }, {
        labelPrefix: 'absolute-paths',
        processTree,
        reportDirectory,
        spawn,
      });

      expect(path.isAbsolute(calls[0].at(-1))).toBe(true);
    } finally {
      fs.rmSync(reportDirectory, { force: true, recursive: true });
    }
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
      expect(fs.existsSync(junitPath)).toBe(true);
      const receiptXml = fs.readFileSync(junitPath, 'utf8');
      expect(receiptXml).toContain('active checkout');
      expect(receiptXml).not.toContain('nested stale checkout');
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

  test('the discovered suite has complete exact resource-lane coverage', async () => {
    const files = listAllFullSuiteTests();
    const resourceMap = await loadTestResourceMap(files);
    const lanes = buildResourceLanePlan(files, 4, new Map(), {
      classify: (file) => resourceMap.get(file),
    });
    const assigned = lanes.flatMap((lane) => lane.shards.flatMap((shard) => shard.files));

    expect(assigned).toHaveLength(files.length);
    expect(new Set(assigned).size).toBe(files.length);
    expect(assigned.slice().sort()).toEqual(files);
    const exclusiveFiles = [
      'test-env/edge-cases/file-limits.test.js',
      'test/cli-lifecycle.test.js',
      'test/forge-cli-registry.test.js',
      'test/helpers/cli-subprocess.test.js',
      'test/hooks-session-start.test.js',
      'test/integration/standalone-package-smoke.test.js',
      'test/migrate-dry-run.test.js',
      'test/options-command.test.js',
      'test/patch-intent.test.js',
      'test/pr-monitor/flow-monitor.test.js',
      'test/release-readiness.test.js',
      'test/scripts/commitlint.test.js',
      'test/scripts/process-tree.test.js',
      'test/sync-agent-skills-authority.test.js',
      'test/test-dashboard.test.js',
    ];
    const exclusiveLane = lanes.find((lane) => lane.name === 'exclusive');
    expect(exclusiveLane.shards.flatMap((shard) => shard.files)).toEqual(exclusiveFiles);
    expect(exclusiveLane.shards.every((shard) => shard.files.length === 1)).toBe(true);
    for (const file of [
      'test/cli-lifecycle.test.js',
      'test/forge-cli-registry.test.js',
      'test/helpers/cli-subprocess.test.js',
      'test/migrate-dry-run.test.js',
      'test/options-command.test.js',
      'test/release-readiness.test.js',
    ]) {
      expect(resourceMap.get(file)).toBe('exclusive');
      expect(exclusiveLane.shards.filter((shard) => shard.files[0] === file)).toHaveLength(1);
    }
    expect(lanes.find((lane) => lane.name === 'subprocess').shards.flatMap((shard) => shard.files))
      .toContain('test/scripts/dep-guard.check-ripple.analyzer.test.js');
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
      classify: () => 'unit',
      durationMap: new Map([
        ['test/a.test.js', 2000],
        ['packages/skills/test/a.test.js', 1000],
      ]),
      processTree: fakeProcessTree(),
      spawn,
    });

    expect(status).toBe(0);
    expect(calls).toHaveLength(2);
    expect(calls[0]).toContain('--reporter=junit');
    expect(calls[0][calls[0].indexOf('--reporter-outfile') + 1]).toContain('unit-full-suite-shard-0.xml');
    expect(calls[0]).toContain('--timeout');
    expect(calls[0]).toContain('30000');
  });

  test('runFullSuiteInParallel derives the duration profile name and label from the label prefix', async () => {
    const writtenProfiles = [];
    const writeProfile = (options) => {
      writtenProfiles.push(options);
      return true;
    };
    const runOptions = () => ({
      allTests: ['test/a.test.js'],
      classify: () => 'unit',
      durationMap: new Map([['test/a.test.js', 1000]]),
      processTree: fakeProcessTree(),
      spawn: (_command, args) => fakeShardChild(0, 9070, args),
      writeDurationProfile: writeProfile,
    });

    const matrixStatus = await runFullSuiteInParallel({
      labelPrefix: 'full-matrix-windows-latest-node22',
      shards: 1,
    }, runOptions());
    const localStatus = await runFullSuiteInParallel({ shards: 1 }, runOptions());

    expect(matrixStatus).toBe(0);
    expect(localStatus).toBe(0);
    expect(writtenProfiles).toHaveLength(2);
    expect(writtenProfiles[0].outputPath.replace(/\\/g, '/'))
      .toContain('test-results/full-matrix-windows-latest-node22.profile.json');
    expect(writtenProfiles[0].label).toBe('full-matrix-windows-latest-node22');
    expect(writtenProfiles[1].outputPath.replace(/\\/g, '/')).toContain('test-results/local-full.profile.json');
    expect(writtenProfiles[1].label).toBe('local-full');
  });

  test('concurrent full-suite invocations use disjoint receipt directories', async () => {
    const receiptPaths = [];
    let pid = 9020;
    const spawn = (_command, args) => {
      receiptPaths.push(args[args.indexOf('--reporter-outfile') + 1]);
      return fakeShardChild(0, pid++, args);
    };

    try {
      const statuses = await Promise.all([
        runFullSuiteInParallel({ labelPrefix: unitLabelPrefix, shards: 1 }, {
          allTests: ['test/a.test.js'],
          classify: () => 'unit',
          durationMap: new Map(),
          processTree: fakeProcessTree(),
          spawn,
        }),
        runFullSuiteInParallel({ labelPrefix: unitLabelPrefix, shards: 1 }, {
          allTests: ['test/a.test.js'],
          classify: () => 'unit',
          durationMap: new Map(),
          processTree: fakeProcessTree(),
          spawn,
        }),
      ]);

      expect(statuses).toEqual([0, 0]);
      expect(path.dirname(receiptPaths[0])).not.toBe(path.dirname(receiptPaths[1]));
      expect(receiptPaths.every((receiptPath) => !fs.existsSync(path.dirname(receiptPath)))).toBe(true);
    } finally {
      for (const directory of new Set(receiptPaths.map((receiptPath) => path.dirname(receiptPath)))) {
        if (path.basename(directory).startsWith('full-suite-')) {
          fs.rmSync(directory, { force: true, recursive: true });
        }
      }
    }
  });
  test('strips Git hook and Forge coordination variables before spawning shards', async () => {
    let spawnedEnv;
    const nodeExecutable = path.resolve('fixture-node');
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
      classify: () => 'unit',
      durationMap: new Map([['test/a.test.js', 1000]]),
      nodeExecutable,
      env: {
        KEEP_ME: 'yes',
        GIT_DIR: '.git',
        GIT_WORK_TREE: 'C:/stale-worktree',
        GIT_INDEX_FILE: 'C:/stale-index',
        Forge_Actor: 'lease-owner',
        forge_session_id: 'session-owner',
        Forge_Worktree_Id: 'worktree-owner',
        forge_lease_ttl_ms: '60000',
      },
      processTree,
      spawn,
    });

    expect(status).toBe(0);
    expect(spawnedEnv).toEqual({
      FORGE_TEST_NODE_EXECUTABLE: nodeExecutable,
      KEEP_ME: 'yes',
    });
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
      classify: () => 'unit',
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
    const errors = [];
    let receiptPath;
    let retained;
    const error = spyOn(console, 'error').mockImplementation((...args) => errors.push(args));
    const processTree = {
      reserveChild: () => ({ id: 'failed-registration' }),
      registerChild: () => null,
      abortChild: (_reservation, child) => child.kill('SIGKILL'),
      unregisterChild: () => {},
      installSignalHandlers: () => () => {},
      cleanup: () => {},
    };
    const spawn = (_command, args) => {
      receiptPath = args[args.indexOf('--reporter-outfile') + 1];
      const child = new EventEmitter();
      child.pid = 9300;
      child.kill = (signal) => killed.push(signal);
      process.nextTick(() => child.emit('error', new Error('spawn failed')));
      return child;
    };

    try {
      expect(await runFullSuiteInParallel({ labelPrefix: unitLabelPrefix, shards: 1 }, {
        allTests: ['test/a.test.js'],
        classify: () => 'unit',
        durationMap: new Map([['test/a.test.js', 1000]]),
        processTree,
        platform: 'linux',
        spawn,
      })).toBe(1);
      retained = fs.existsSync(path.dirname(receiptPath));
    } finally {
      error.mockRestore();
      if (receiptPath) fs.rmSync(path.dirname(receiptPath), { force: true, recursive: true });
    }

    expect(retained).toBe(true);
    expect(killed).toEqual(['SIGKILL']);
    expect(errors).toHaveLength(1);
    expect(errors[0][0]).toBe('Full suite shard execution failed:');
    expect(errors[0][1]).toBeInstanceOf(Error);
    expect(errors[0][1].message).toBe('test shard process could not be registered');
  });

  test('runFullSuiteInParallel returns non-zero when any shard fails', async () => {
    const receiptPaths = [];
    let index = 0;
    let pid = 9200;
    const spawn = (_command, args) => {
      receiptPaths.push(args[args.indexOf('--reporter-outfile') + 1]);
      const child = fakeShardChild(index === 0 ? 0 : 1, pid++, args);
      index += 1;
      return child;
    };

    const status = await runFullSuiteInParallel({
      labelPrefix: unitLabelPrefix,
      shards: 2,
    }, {
      allTests: ['test/a.test.js', 'test/b.test.js'],
      classify: () => 'unit',
      durationMap: new Map([
        ['test/a.test.js', 2000],
        ['test/b.test.js', 1000],
      ]),
      spawn,
      processTree: fakeProcessTree(),
    });

    const retained = receiptPaths.every((receiptPath) => fs.existsSync(path.dirname(receiptPath)));
    for (const directory of new Set(receiptPaths.map((receiptPath) => path.dirname(receiptPath)))) {
      fs.rmSync(directory, { force: true, recursive: true });
    }
    expect(status).toBe(1);
    expect(retained).toBe(true);
  });

  test('mixed resource lanes aggregate every receipt and clean up once', async () => {
    const cleanupSignals = [];
    const calls = [];
    const errors = [];
    let pid = 9350;
    const resourceByFile = new Map([
      ['test/unit.test.js', 'unit'],
      ['test/process.test.js', 'subprocess'],
      ['test/exclusive.test.js', 'exclusive'],
    ]);
    const processTree = {
      ...fakeProcessTree(),
      cleanup: (signal) => cleanupSignals.push(signal),
    };
    const spawn = (_command, args) => {
      const file = args.at(-1).replace(/\\/g, '/');
      calls.push(file);
      return fakeShardChild(file.endsWith('/process.test.js') ? 1 : 0, pid++, args);
    };
    const error = spyOn(console, 'error').mockImplementation((message) => errors.push(message));

    let status;
    try {
      status = await runFullSuiteInParallel({ labelPrefix: unitLabelPrefix, shards: 4 }, {
        allTests: [...resourceByFile.keys()],
        classify: (file) => resourceByFile.get(file),
        durationMap: new Map(),
        processTree,
        spawn,
      });
    } finally {
      error.mockRestore();
    }

    expect(status).toBe(1);
    expect(calls.map((file) => path.basename(file))).toEqual([
      'unit.test.js',
      'process.test.js',
      'exclusive.test.js',
    ]);
    expect(cleanupSignals).toEqual(['SIGTERM']);
    expect(errors).toEqual(['Full suite non-zero shards: 1:subprocess:exit=1']);
  });

  test('runFullSuiteInParallel reports a child process error as incomplete', async () => {
    let receiptPath;
    const spawn = (_command, args) => {
      receiptPath = args[args.indexOf('--reporter-outfile') + 1];
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.pid = 9400;
      child.stderr = new EventEmitter();
      process.nextTick(() => child.emit('error', new Error('spawn failed')));
      return child;
    };

    const status = await runFullSuiteInParallel({ labelPrefix: unitLabelPrefix, shards: 1 }, {
      allTests: ['test/a.test.js'],
      classify: () => 'unit',
      processTree: fakeProcessTree(),
      durationMap: new Map([['test/a.test.js', 1000]]),
      spawn,
    });

    const retained = fs.existsSync(path.dirname(receiptPath));
    fs.rmSync(path.dirname(receiptPath), { force: true, recursive: true });
    expect(status).toBe(1);
    expect(retained).toBe(true);
  });

  test('runFullSuiteInParallel preserves a captured signal when a shard errors and a sibling hangs', async () => {
    const cleanupSignals = [];
    const children = [];
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
      cleanup: (signal) => {
        cleanupSignals.push(signal);
        for (const child of children) child.emit('close', 1);
      },
    };
    const log = spyOn(console, 'log').mockImplementation((message) => logs.push(message));

    try {
      const status = await Promise.race([
        runFullSuiteInParallel({ labelPrefix: unitLabelPrefix, shards: 2 }, {
          allTests: ['test/a.test.js', 'test/b.test.js'],
          classify: () => 'unit',
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
            children.push(child);
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
    let receiptPath;
    let retained;
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
        classify: () => 'unit',
        durationMap: new Map([['test/a.test.js', 1000]]),
        processTree,
        spawn: (_command, args) => {
          receiptPath = args[args.indexOf('--reporter-outfile') + 1];
          const child = fakeShardChild(0, 9500, args);
          process.nextTick(() => signalHandler('SIGTERM'));
          return child;
        },
      });
      expect(status).toBe(143);
      retained = fs.existsSync(path.dirname(receiptPath));
    } finally {
      log.mockRestore();
      if (receiptPath) fs.rmSync(path.dirname(receiptPath), { force: true, recursive: true });
    }
    expect(retained).toBe(true);
    expect(logs.some((line) => line.includes('status=INCOMPLETE'))).toBe(true);
  });
  test('runFullSuiteInParallel fails closed when no tests are discovered', async () => {
    const logs = [];
    const log = spyOn(console, 'log').mockImplementation((message) => logs.push(message));
    try {
      expect(await runFullSuiteInParallel({ labelPrefix: unitLabelPrefix }, {
        allTests: [],
        durationMap: new Map(),
        processTree: fakeProcessTree(),
      })).toBe(1);
    } finally {
      log.mockRestore();
    }

    expect(logs).toContain('Full suite aggregate: status=INCOMPLETE tests=0 assertions=0 passed=0 failed=0 errors=0 skipped=0');
    expect(logs).toContain('Full suite exit: 1');
  });

  test('missing Node executable follows the incomplete aggregate path without spawning', async () => {
    const logs = [];
    const errors = [];
    let spawned = false;
    const log = spyOn(console, 'log').mockImplementation((message) => logs.push(message));
    const error = spyOn(console, 'error').mockImplementation((...messages) => errors.push(messages));
    try {
      const status = await runFullSuiteInParallel({ labelPrefix: unitLabelPrefix, shards: 1 }, {
        allTests: ['test/a.test.js'],
        classify: () => 'unit',
        durationMap: new Map(),
        nodeExecutable: 'node',
        processTree: fakeProcessTree(),
        spawn: () => {
          spawned = true;
          throw new Error('spawn must not run');
        },
      });
      expect(status).toBe(1);
    } finally {
      error.mockRestore();
      log.mockRestore();
    }

    expect(spawned).toBe(false);
    expect(errors[0][0]).toBe('Full suite shard execution failed:');
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

    for (const duplicateAttribute of ['tests', 'assertions', 'failures', 'skipped']) {
      expect(aggregateShardReceipts([
        { code: 0, index: 0, output: passingShardReceipt.replace(duplicateAttribute + '="', duplicateAttribute + '="1" ' + duplicateAttribute + '="') },
      ], 1).status).toBe('INCOMPLETE');
    }

    expect(aggregateShardReceipts([
      { code: 0, index: 0, output: ' ' + String.fromCharCode(10) + '<?xml version="1.0" encoding="UTF-8"?>' + String.fromCharCode(10) + passingShardReceipt + String.fromCharCode(10) },
    ], 1).status).toBe('PASS');
  });

  test('extractFailedTestCases does not attach a later failure to a self-closing testcase', () => {
    const receipt = `<testsuites tests="2" assertions="8" failures="1" skipped="0">
      <testsuite name="migration" file="test/kernel/migrate-events-interactions.test.js">
        <testcase name="maps every event + interaction" file="test/kernel/migrate-events-interactions.test.js" assertions="7" />
      </testsuite>
      <testsuite name="commitlint" file="test/scripts/commitlint.test.js">
        <testcase name="accepts &quot;style: fix formatting&quot;" file="test/scripts/commitlint.test.js" line="131" assertions="1"><failure type="AssertionError" /></testcase>
      </testsuite>
    </testsuites>`;

    expect(extractFailedTestCases(receipt)).toEqual([{
      file: 'test/scripts/commitlint.test.js',
      line: '131',
      name: 'accepts &quot;style: fix formatting&quot;',
      type: 'failure',
    }]);
  });

  test('writeDurationProfile persists only complete loadable timing coverage', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-full-profile-'));
    const runDir = path.join(root, 'run');
    const outputPath = path.join(root, 'local-full.profile.json');
    fs.mkdirSync(runDir);
    try {
      fs.writeFileSync(path.join(runDir, 'shard.xml'), `<testsuites tests="1" assertions="1" failures="0" skipped="0">
        <testsuite name="a"><testcase name="a" file="test/a.test.js" time="1.25" /></testsuite>
      </testsuites>`);

      expect(writeDurationProfile({
        allTests: ['test/a.test.js'],
        outputPath,
        runReportDir: runDir,
      })).toBe(true);
      expect(JSON.parse(fs.readFileSync(outputPath, 'utf8')).allFileDurations).toEqual([
        { durationMs: 1250, file: 'test/a.test.js' },
      ]);
      expect(JSON.parse(fs.readFileSync(outputPath, 'utf8')).label).toBe('local-full');

      const prefixedPath = path.join(root, 'full-matrix-windows-latest-node22.profile.json');
      expect(writeDurationProfile({
        allTests: ['test/a.test.js'],
        label: 'full-matrix-windows-latest-node22',
        outputPath: prefixedPath,
        runReportDir: runDir,
      })).toBe(true);
      expect(JSON.parse(fs.readFileSync(prefixedPath, 'utf8')).label).toBe('full-matrix-windows-latest-node22');

      fs.rmSync(outputPath);
      expect(writeDurationProfile({
        allTests: ['test/a.test.js', 'test/missing.test.js'],
        outputPath,
        runReportDir: runDir,
      })).toBe(false);
      expect(fs.existsSync(outputPath)).toBe(false);

      fs.writeFileSync(path.join(runDir, 'shard.xml'), '<not-junit />');
      expect(writeDurationProfile({
        allTests: ['test/a.test.js'],
        outputPath,
        runReportDir: runDir,
      })).toBe(false);
      expect(fs.existsSync(outputPath)).toBe(false);
    } finally {
      fs.rmSync(root, { force: true, recursive: true });
    }
  });

  test('the manual profile command writes a discoverable profile filename', () => {
    const profileCommand = require('../../package.json').scripts['test:profile'];
    expect(profileCommand).toContain('--output test-results/test-profile.profile.json');
  });
});
