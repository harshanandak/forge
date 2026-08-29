const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { afterEach, describe, expect, test } = require('bun:test');

const {
  BENCHMARK_GROUPS,
  benchmarkCorpusContentHash,
  benchmarkResultContentHash,
  buildBenchmarkResults,
  buildBenchmarkConfigHash,
  buildJUnitCommand,
  calculateMedian,
  compareBenchmarkResults,
  main,
  parseArgs,
  resolveGroups,
  runBenchmarkGroup,
  summarizeSamples,
} = require('../scripts/benchmark');

const tempDirs = [];

function makeTempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-benchmark-test-'));
  tempDirs.push(dir);
  return dir;
}

const TEST_CORPUS = {
  version: 1,
  files: [
    { path: 'test/e2e/memory-recall-holdout.test.js', blob: '1'.repeat(40) },
    { path: 'test/kernel/broker-concurrency.test.js', blob: '2'.repeat(40) },
    { path: 'test/kernel/readiness-model.test.js', blob: '3'.repeat(40) },
    { path: 'test/memory-recall.test.js', blob: '4'.repeat(40) },
  ],
};

const TEST_IDENTITY = {
  source_sha: 'a'.repeat(40),
  runtime: { node: '24.0.0', bun: '1.3.12' },
  platform: { platform: 'win32', arch: 'x64' },
  corpus: TEST_CORPUS,
};

function createGitExec(status = '') {
  return (_binary, args) => {
    if (args[0] === 'rev-parse') return 'a'.repeat(40);
    if (args[0] === 'status') return status;
    if (args[0] === 'ls-tree') return TEST_CORPUS.files
      .map((file) => `100644 blob ${file.blob}\t${file.path}`).join('\n');
    return '';
  };
}

afterEach(() => {
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop(), { force: true, recursive: true });
  }
});

describe('scripts/benchmark.js', () => {
  test('package.json wires test:benchmark through test-results artifacts', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
    expect(pkg.scripts['test:benchmark']).toContain('scripts/benchmark.js');
    expect(pkg.scripts['test:benchmark']).toContain('test-results/benchmark-results.json');
  });

  test('parseArgs keeps benchmark outputs in test-results by default', () => {
    const args = parseArgs([]);

    expect(args.output.replace(/\\/g, '/')).toContain('test-results/benchmark-results.json');
    expect(args.profileDir.replace(/\\/g, '/')).toContain('test-results/benchmark-profiles');
    expect(args.samples).toBe(30);
    expect(args.warmups).toBe(3);
  });

  test('main enforces production warmup and sample floors for CLI overrides', () => {
    const outputDir = makeTempDir();
    const calls = [];
    const spawnSync = (_binary, args) => {
      const outputIndex = args.indexOf('--reporter-outfile');
      const junitPath = args[outputIndex + 1];
      calls.push(junitPath);
      fs.writeFileSync(junitPath, '<testsuites><testsuite name="floors" time="0.1"><testcase file="test/kernel/readiness-model.test.js" time="0.1"/></testsuite></testsuites>');
      return { status: 0, stderr: '', stdout: '' };
    };
    const result = main([
      '--group', 'kernel-core',
      '--warmups', '0',
      '--samples', '1',
      '--output', path.join(outputDir, 'benchmark-results.json'),
      '--profile-dir', path.join(outputDir, 'profiles'),
    ], {
      spawnSync,
      gitExec: createGitExec(),
      identity: TEST_IDENTITY,
    });

    expect(result.warmups).toBe(3);
    expect(result.samples).toBe(30);
    expect(result.groups[0].warmups).toBe(3);
    expect(result.groups[0].samples).toBe(30);
    expect(calls).toHaveLength(33);
  });

  test('resolveGroups returns the requested benchmark slices', () => {
    const groups = resolveGroups(['pre-push-runner', 'hotspot-shell']);
    expect(groups.map((group) => group.id)).toEqual(['pre-push-runner', 'hotspot-shell']);
  });

  test('resolveGroups exposes deterministic kernel and memory recall slices', () => {
    const groups = resolveGroups(['kernel-core', 'memory-recall']);

    expect(groups[0]).toEqual({
      id: 'kernel-core',
      label: 'Kernel core slice',
      command: [
        'bun',
        'test',
        'test/kernel/readiness-model.test.js',
        'test/kernel/broker-concurrency.test.js',
      ],
    });
    expect(groups[1].id).toBe('memory-recall');
    expect(groups[1].command.slice(0, 4)).toEqual([
      'bun',
      'test',
      'test/memory-recall.test.js',
      'test/e2e/memory-recall-holdout.test.js',
    ]);
    const patternIndex = groups[1].command.indexOf('--test-name-pattern');
    expect(patternIndex).toBeGreaterThan(-1);
    expect(groups[1].command[patternIndex + 1]).toContain('real locked SQLite');
    expect(groups[1].command[patternIndex + 1]).toContain('assembled 1,000-row recall');
    expect(groups[1].command[patternIndex + 1]).toMatch(/^\^\(\?!/);
  });

  test('buildJUnitCommand injects junit reporter flags for bun test lanes', () => {
    const command = buildJUnitCommand(['bun', 'test', 'test/scripts/test-runner.test.js'], 'tmp/out.xml');
    expect(command).toEqual([
      'bun',
      'test',
      'test/scripts/test-runner.test.js',
      '--reporter=junit',
      '--reporter-outfile',
      'tmp/out.xml',
    ]);
  });

  test('calculateMedian and summarizeSamples use median-oriented timing summaries', () => {
    expect(calculateMedian([100, 700, 300])).toBe(300);
    expect(calculateMedian([100, 500, 700, 900])).toBe(600);
    expect(summarizeSamples([100, 300, 700])).toEqual({
      coefficientOfVariation: 0.6803013430498075,
      maxMs: 700,
      meanMs: 367,
      medianMs: 300,
      minMs: 100,
      p95Ms: 700,
      samplesMs: [100, 300, 700],
    });
  });

  test('summarizeSamples reports nearest-rank p95 and coefficient of variation', () => {
    const summary = summarizeSamples([100, 200, 300, 400]);

    expect(summary.p95Ms).toBe(400);
    expect(summary.coefficientOfVariation).toBeCloseTo(Math.sqrt(12500) / 250);
  });

  test('runBenchmarkGroup runs injected warmups before recorded samples and records metadata', () => {
    const profileDir = makeTempDir();
    const group = {
      id: 'warmup-order',
      label: 'Warmup order',
      command: ['bun', 'test', 'test/example.test.js'],
    };
    const outputPaths = [];
    const spawnSync = (_binary, args) => {
      const outputIndex = args.indexOf('--reporter-outfile');
      const junitPath = args[outputIndex + 1];
      outputPaths.push(path.basename(junitPath));
      fs.writeFileSync(junitPath, '<testsuites><testsuite name="warmup-order" time="0.1"><testcase file="test/example.test.js" time="0.1"/></testsuite></testsuites>');
      return { status: 0, stderr: '', stdout: '' };
    };

    const result = runBenchmarkGroup(group, {
      profileDir,
      warmups: 2,
      samples: 2,
      spawnSync,
    });

    expect(outputPaths).toEqual([
      'warmup-order.warmup-1.xml',
      'warmup-order.warmup-2.xml',
      'warmup-order.sample-1.xml',
      'warmup-order.sample-2.xml',
    ]);
    expect(result.warmups).toBe(2);
    expect(result.commandArgs).toEqual(group.command);
    expect(result).toHaveProperty('p95Ms');
    expect(result).toHaveProperty('coefficientOfVariation');
  });

  test('runBenchmarkGroup records samples and emits a matching profile file', () => {
    const profileDir = makeTempDir();
    const defaultJunitPath = path.join(profileDir, 'default-junit.xml');
    const repositoryFallbackPath = path.resolve(__dirname, '..', 'test-results', 'test-results.xml');
    const removedPaths = [];
    const originalRmSync = fs.rmSync;
    fs.rmSync = (target, ...args) => {
      removedPaths.push(path.resolve(target));
      return originalRmSync(target, ...args);
    };
    const group = {
      id: 'synthetic',
      label: 'Synthetic slice',
      command: ['bun', 'test', 'test/example.test.js'],
    };

    const spawnSync = (_binary, args) => {
      const outputIndex = args.indexOf('--reporter-outfile');
      const junitPath = args[outputIndex + 1];
      fs.writeFileSync(junitPath, `<?xml version="1.0" encoding="UTF-8"?>
<testsuites>
  <testsuite name="synthetic" time="0.5">
    <testcase classname="synthetic" name="uses shell helper" file="test/scripts/synthetic.test.js" time="0.5"></testcase>
  </testsuite>
</testsuites>`, 'utf8');
      return { status: 0, stderr: '', stdout: '' };
    };

    let result;
    try {
      result = runBenchmarkGroup(group, {
        profileDir,
        samples: 2,
        spawnSync,
        defaultJunitPath,
      });
    } finally {
      fs.rmSync = originalRmSync;
    }

    expect(result.groupId).toBe('synthetic');
    expect(result.samples).toBe(2);
    expect(result.samplesMs).toHaveLength(2);

    const profile = JSON.parse(fs.readFileSync(path.join(profileDir, 'synthetic.profile.json'), 'utf8'));
    expect(profile.label).toBe('benchmark-synthetic');
    expect(profile.slowestFiles[0].file).toBe('test/scripts/synthetic.test.js');
    expect(removedPaths).toContain(path.resolve(defaultJunitPath));
    expect(removedPaths).not.toContain(repositoryFallbackPath);
  });

  test('runBenchmarkGroup without an injected fallback never removes the repository fallback', () => {
    const profileDir = makeTempDir();
    const repositoryFallbackPath = path.resolve(__dirname, '..', 'test-results', 'test-results.xml');
    const removedPaths = [];
    const originalRmSync = fs.rmSync;
    fs.rmSync = (target, ...args) => {
      removedPaths.push(path.resolve(target));
      return originalRmSync(target, ...args);
    };
    const group = {
      id: 'no-fallback',
      label: 'No fallback slice',
      command: ['bun', 'test', 'test/example.test.js'],
    };

    const spawnSync = (_binary, args) => {
      const outputIndex = args.indexOf('--reporter-outfile');
      const junitPath = args[outputIndex + 1];
      fs.writeFileSync(junitPath, '<testsuites><testsuite name="no-fallback" time="0.1"><testcase file="test/example.test.js" time="0.1"/></testsuite></testsuites>');
      return { status: 0, stderr: '', stdout: '' };
    };

    try {
      runBenchmarkGroup(group, { profileDir, samples: 1, spawnSync });
    } finally {
      fs.rmSync = originalRmSync;
    }

    expect(removedPaths).not.toContain(repositoryFallbackPath);
  });

  test('runBenchmarkGroup falls back to Bun default junit output when reporter-outfile is ignored', () => {
    const profileDir = makeTempDir();
    const fallbackJunitPath = path.join(profileDir, 'test-results.xml');
    const group = {
      id: 'fallback',
      label: 'Fallback slice',
      command: ['bun', 'test', 'test/example.test.js'],
    };

    const spawnSync = () => {
      fs.mkdirSync(path.dirname(fallbackJunitPath), { recursive: true });
      fs.writeFileSync(fallbackJunitPath, `<?xml version="1.0" encoding="UTF-8"?>
<testsuites>
  <testsuite name="fallback" time="0.4">
    <testcase classname="fallback" name="uses fallback junit path" file="test/scripts/fallback.test.js" time="0.4"></testcase>
  </testsuite>
</testsuites>`, 'utf8');
      return { status: 0, stderr: '', stdout: '' };
    };

    try {
      const result = runBenchmarkGroup(group, {
        profileDir,
        samples: 1,
        spawnSync,
        defaultJunitPath: fallbackJunitPath,
      });

      expect(result.profilePath.endsWith('fallback.profile.json')).toBe(true);
      const copiedJUnit = path.join(profileDir, 'fallback.sample-1.xml');
      expect(fs.existsSync(copiedJUnit)).toBe(true);
    } finally {
      fs.rmSync(fallbackJunitPath, { force: true });
    }
  });

  test('main writes grouped benchmark JSON using supplied benchmark groups', () => {
    const outputDir = makeTempDir();
    const outputPath = path.join(outputDir, 'benchmark-results.json');
    const profileDir = path.join(outputDir, 'profiles');

    const spawnSync = (_binary, args) => {
      const outputIndex = args.indexOf('--reporter-outfile');
      const junitPath = args[outputIndex + 1];
      fs.writeFileSync(junitPath, `<?xml version="1.0" encoding="UTF-8"?>
<testsuites>
  <testsuite name="runner" time="0.2">
    <testcase classname="runner" name="runs targeted tests" file="test/scripts/test-runner.test.js" time="0.2"></testcase>
  </testsuite>
</testsuites>`, 'utf8');
      return { status: 0, stderr: '', stdout: '' };
    };

    const stdoutChunks = [];
    const write = process.stdout.write;
    const removedPaths = [];
    const repositoryFallbackPath = path.resolve(__dirname, '..', 'test-results', 'test-results.xml');
    const originalRmSync = fs.rmSync;
    fs.rmSync = (target, ...args) => {
      removedPaths.push(path.resolve(target));
      return originalRmSync(target, ...args);
    };
    process.stdout.write = (chunk) => {
      stdoutChunks.push(String(chunk));
      return true;
    };

    try {
      const result = main([
        '--json',
        '--group', 'pre-push-runner',
        '--samples', '2',
        '--output', outputPath,
        '--profile-dir', profileDir,
      ], {
        spawnSync,
        defaultJunitPath: path.join(profileDir, 'default-junit.xml'),
        gitExec: createGitExec(),
        identity: TEST_IDENTITY,
      });

      expect(result.groups).toHaveLength(1);
      expect(result.groups[0].groupId).toBe('pre-push-runner');
      expect(result.totalMedianMs).toBe(result.groups[0].medianMs);
      expect(result.slowestGroup.groupId).toBe('pre-push-runner');

      const written = JSON.parse(fs.readFileSync(outputPath, 'utf8'));
      expect(written.requestedGroups).toEqual(['pre-push-runner']);
      expect(JSON.parse(stdoutChunks.join(''))).toEqual(result);
    } finally {
      process.stdout.write = write;
      fs.rmSync = originalRmSync;
    }
    expect(removedPaths).not.toContain(repositoryFallbackPath);
  });

  test('buildBenchmarkResults keeps the slowest median group in summary', () => {
    const groups = BENCHMARK_GROUPS.slice(0, 2);
    const summary = buildBenchmarkResults(groups, [
      { groupId: 'pre-push-runner', groupLabel: 'Pre-push runner slice', medianMs: 1200, samples: 3 },
      { groupId: 'validation-core', groupLabel: 'Validation core slice', medianMs: 900, samples: 3 },
    ], '2026-04-17T12:00:00.000Z', TEST_IDENTITY);

    expect(summary.totalMedianMs).toBe(2100);
    expect(summary.slowestGroup).toEqual({
      groupId: 'pre-push-runner',
      groupLabel: 'Pre-push runner slice',
      medianMs: 1200,
    });
    expect(summary.timestamp).toBe('2026-04-17T12:00:00.000Z');
  });

  test('buildBenchmarkResults binds source/runtime/platform/config identity and hashes stable evidence', () => {
    const groups = [{ id: 'synthetic', command: ['bun', 'test', 'test/example.test.js'] }];
    const results = [{ groupId: 'synthetic', groupLabel: 'Synthetic', medianMs: 100, samples: 3, tokens: 12 }];
    const first = buildBenchmarkResults(groups, results, '2026-04-17T12:00:00.000Z', TEST_IDENTITY);
    const equivalent = buildBenchmarkResults(groups, results, '2026-04-18T12:00:00.000Z', TEST_IDENTITY);
    const changed = buildBenchmarkResults(groups, [{ ...results[0], tokens: 13 }], '2026-04-18T12:00:00.000Z', TEST_IDENTITY);

    expect(first.source_sha).toMatch(/^[a-f0-9]{40}$/);
    expect(first.runtime).toEqual({
      node: TEST_IDENTITY.runtime.node,
      bun: TEST_IDENTITY.runtime.bun,
    });
    expect(first.platform).toEqual(TEST_IDENTITY.platform);
    expect(first.config_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(first.config_hash).toBe(buildBenchmarkConfigHash(first.config));
    expect(first.config).toEqual({
      groups: [{ id: 'synthetic', command: ['bun', 'test', 'test/example.test.js'] }],
      samples: 3,
      warmups: 3,
    });
    expect(first.corpus).toEqual(TEST_CORPUS);
    expect(first.corpus_hash).toBe(benchmarkCorpusContentHash(TEST_CORPUS));
    expect(first.totalTokens).toBe(12);
    expect(first.content_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(first.content_hash).toBe(equivalent.content_hash);
    expect(first.content_hash).not.toBe(changed.content_hash);

    const noTokens = buildBenchmarkResults(groups, [{ ...results[0], tokens: undefined }], '2026-04-18T12:00:00.000Z', TEST_IDENTITY);
    expect(noTokens.totalTokens).toBeUndefined();
  });

  test('compareBenchmarkResults permits distinct SHAs, enforces caps, and fails closed on incomplete evidence', () => {
    const groups = [{ id: 'synthetic', command: ['bun', 'test', 'test/example.test.js'] }];
    const identity = {
      runtime: { node: '24.0.0', bun: '1.3.12' },
      platform: { platform: 'win32', arch: 'x64' },
      corpus: TEST_CORPUS,
    };
    const base = buildBenchmarkResults(groups, [
      {
        command: 'bun test test/example.test.js',
        groupId: 'synthetic',
        groupLabel: 'Synthetic',
        medianMs: 100,
        samples: 3,
        warmups: 3,
        commandArgs: ['bun', 'test', 'test/example.test.js'],
        minMs: 100,
        maxMs: 100,
        meanMs: 100,
        p95Ms: 100,
        coefficientOfVariation: 0,
        samplesMs: [100, 100, 100],
        tokens: 100,
      },
    ], '2026-04-17T12:00:00.000Z', { ...identity, source_sha: 'a'.repeat(40) });
    const candidate = buildBenchmarkResults(groups, [
      {
        command: 'bun test test/example.test.js',
        groupId: 'synthetic',
        groupLabel: 'Synthetic',
        medianMs: 125,
        samples: 3,
        warmups: 3,
        commandArgs: ['bun', 'test', 'test/example.test.js'],
        minMs: 125,
        maxMs: 125,
        meanMs: 125,
        p95Ms: 125,
        coefficientOfVariation: 0,
        samplesMs: [125, 125, 125],
        tokens: 120,
      },
    ], '2026-04-18T12:00:00.000Z', { ...identity, source_sha: 'b'.repeat(40) });

    expect(compareBenchmarkResults(base, candidate).status).toBe('PASS');
    const runtimeMismatch = {
      ...candidate,
      runtime: { ...candidate.runtime, node: '25.0.0' },
    };
    runtimeMismatch.content_hash = benchmarkResultContentHash(runtimeMismatch);
    expect(compareBenchmarkResults(base, runtimeMismatch).status).toBe('INCOMPLETE');
    expect(compareBenchmarkResults(base, {
      ...candidate,
      content_hash: 'bad',
    }).status).toBe('INCOMPLETE');
    const corpusMismatch = {
      ...candidate,
      corpus: {
        ...candidate.corpus,
        files: candidate.corpus.files.map((file, index) => index === 0
          ? { ...file, blob: 'f'.repeat(40) }
          : file),
      },
    };
    corpusMismatch.corpus_hash = benchmarkCorpusContentHash(corpusMismatch.corpus);
    corpusMismatch.content_hash = benchmarkResultContentHash(corpusMismatch);
    expect(compareBenchmarkResults(base, corpusMismatch).status).toBe('INCOMPLETE');
    const configMismatch = {
      ...candidate,
      config: { ...candidate.config, samples: 4 },
    };
    configMismatch.config_hash = buildBenchmarkConfigHash(configMismatch.config.groups, configMismatch.config.samples);
    configMismatch.content_hash = benchmarkResultContentHash(configMismatch);
    expect(compareBenchmarkResults(base, configMismatch).status).toBe('INCOMPLETE');
    const badTimestamp = { ...candidate, timestamp: 'not-a-time' };
    badTimestamp.content_hash = benchmarkResultContentHash(badTimestamp);
    expect(compareBenchmarkResults(base, badTimestamp).status).toBe('INCOMPLETE');
    const nonexistentTimestamp = { ...candidate, timestamp: '2026-02-31T12:00:00.000Z' };
    nonexistentTimestamp.content_hash = benchmarkResultContentHash(nonexistentTimestamp);
    expect(compareBenchmarkResults(base, nonexistentTimestamp).status).toBe('INCOMPLETE');
    expect(compareBenchmarkResults(base, buildBenchmarkResults(groups, [
      {
        command: 'bun test test/example.test.js',
        groupId: 'synthetic',
        groupLabel: 'Synthetic',
        medianMs: 100,
        samples: 3,
      },
    ], '2026-04-18T12:00:00.000Z', { ...identity, source_sha: 'c'.repeat(40) })).status).toBe('INCOMPLETE');
    expect(compareBenchmarkResults(base, buildBenchmarkResults(groups, [
      {
        command: 'bun test test/example.test.js',
        groupId: 'synthetic',
        groupLabel: 'Synthetic',
        medianMs: 126,
        samples: 3,
        warmups: 3,
        commandArgs: ['bun', 'test', 'test/example.test.js'],
        minMs: 126,
        maxMs: 126,
        meanMs: 126,
        p95Ms: 126,
        coefficientOfVariation: 0,
        samplesMs: [126, 126, 126],
        tokens: 100,
      },
    ], '2026-04-18T12:00:00.000Z', { ...identity, source_sha: 'd'.repeat(40) })).status).toBe('FAIL');
  });

  test('compareBenchmarkResults rejects rehashed artifacts with inconsistent redundant fields', () => {
    const groups = [
      { id: 'first', command: ['bun', 'test', 'test/first.test.js'] },
      { id: 'second', command: ['bun', 'test', 'test/second.test.js'] },
    ];
    const identity = {
      runtime: { node: '24.0.0', bun: '1.3.12' },
      platform: { platform: 'win32', arch: 'x64' },
      corpus: TEST_CORPUS,
    };
    const valid = buildBenchmarkResults(groups, [
      {
        command: 'bun test test/first.test.js',
        groupId: 'first',
        groupLabel: 'First',
        medianMs: 100,
        samples: 3,
        warmups: 3,
        commandArgs: ['bun', 'test', 'test/first.test.js'],
        minMs: 100,
        maxMs: 100,
        meanMs: 100,
        p95Ms: 100,
        coefficientOfVariation: 0,
        samplesMs: [100, 100, 100],
        tokens: 100,
      },
      {
        command: 'bun test test/second.test.js',
        groupId: 'second',
        groupLabel: 'Second',
        medianMs: 200,
        samples: 3,
        warmups: 3,
        commandArgs: ['bun', 'test', 'test/second.test.js'],
        minMs: 200,
        maxMs: 200,
        meanMs: 200,
        p95Ms: 200,
        coefficientOfVariation: 0,
        samplesMs: [200, 200, 200],
        tokens: 120,
      },
    ], '2026-04-17T12:00:00.000Z', { ...identity, source_sha: 'e'.repeat(40) });
    const rehashed = (mutate) => {
      const payload = JSON.parse(JSON.stringify(valid));
      mutate(payload);
      payload.content_hash = benchmarkResultContentHash(payload);
      return payload;
    };

    const inconsistent = [
      rehashed((payload) => { payload.samples = 4; }),
      rehashed((payload) => { payload.requestedGroups = ['second', 'first']; }),
      rehashed((payload) => { payload.groups = payload.groups.slice(0, 1); }),
      rehashed((payload) => { payload.groups.reverse(); }),
      rehashed((payload) => { payload.groups[0].groupId = 'wrong'; }),
      rehashed((payload) => { payload.groups[0].command = 'bun test test/wrong.test.js'; }),
      rehashed((payload) => { payload.groups[0].samples = 2; }),
      rehashed((payload) => { payload.groups[0].warmups = 4; }),
      rehashed((payload) => { payload.groups[0].commandArgs = ['node']; }),
      rehashed((payload) => { payload.totalMedianMs = 999; }),
      rehashed((payload) => { payload.totalTokens = 999; }),
      rehashed((payload) => { payload.groups[0].p95Ms = 999; }),
      rehashed((payload) => { payload.groups[0].coefficientOfVariation = 999; }),
      rehashed((payload) => { payload.slowestGroup = { ...payload.slowestGroup, groupId: 'first' }; }),
    ];

    for (const payload of inconsistent) {
      expect(compareBenchmarkResults(valid, payload).status).toBe('INCOMPLETE');
    }
  });

  test('compareBenchmarkResults rejects rehashed artifacts with inconsistent raw sample summaries', () => {
    const groups = [{ id: 'synthetic', command: ['bun', 'test', 'test/example.test.js'] }];
    const valid = buildBenchmarkResults(groups, [{
      command: 'bun test test/example.test.js',
      groupId: 'synthetic',
      groupLabel: 'Synthetic',
      samples: 3,
      samplesMs: [100, 200, 300],
      minMs: 100,
      maxMs: 300,
      meanMs: 200,
      medianMs: 200,
      tokens: 100,
    }], '2026-04-17T12:00:00.000Z', {
      ...TEST_IDENTITY,
      source_sha: 'f'.repeat(40),
    });
    const rehashed = JSON.parse(JSON.stringify(valid));
    rehashed.groups[0].samplesMs = [150, 150, 150];
    rehashed.content_hash = benchmarkResultContentHash(rehashed);

    expect(compareBenchmarkResults(valid, rehashed).status).toBe('INCOMPLETE');
  });

  test('main checks clean tracked HEAD before benchmarking and ignores untracked planning files', () => {
    const outputDir = makeTempDir();
    const outputPath = path.join(outputDir, 'benchmark-results.json');
    const profileDir = path.join(outputDir, 'profiles');
    const spawnSync = (_binary, args) => {
      const outfileIndex = args.indexOf('--reporter-outfile');
      if (outfileIndex !== -1) {
        fs.writeFileSync(args[outfileIndex + 1], '<testsuites><testsuite time="0.1"><testcase file="test/kernel/readiness-model.test.js" time="0.1"/></testsuite></testsuites>');
      }
      return { status: 0, stderr: '', stdout: '' };
    };
    expect(() => main([
      '--json', '--group', 'kernel-core', '--output', outputPath, '--profile-dir', profileDir,
    ], {
      spawnSync,
      defaultJunitPath: path.join(profileDir, 'default-junit.xml'),
      gitExec: createGitExec('?? docs/work/2026-08-30-agent-architecture-convergence/plan.md'),
      identity: TEST_IDENTITY,
    })).not.toThrow();
  });

  test('main rejects an untracked code or test input before spawning a benchmark', () => {
    let spawned = false;
    const spawnSync = () => {
      spawned = true;
      throw new Error('benchmark should not start');
    };

    expect(() => main(['--group', 'kernel-core'], {
      spawnSync,
      defaultJunitPath: path.join(makeTempDir(), 'default-junit.xml'),
      gitExec: createGitExec('?? test/new-input.test.js'),
      identity: TEST_IDENTITY,
    })).toThrow(/untracked code or test input/);
    expect(spawned).toBe(false);
  });

  test('main rejects a source snapshot change after sampling before writing output', () => {
    const outputDir = makeTempDir();
    const outputPath = path.join(outputDir, 'benchmark-results.json');
    const profileDir = path.join(outputDir, 'profiles');
    let sourceCalls = 0;
    const gitExec = (_binary, args) => {
      if (args[0] === 'rev-parse') {
        sourceCalls += 1;
        return sourceCalls === 1 ? 'a'.repeat(40) : 'b'.repeat(40);
      }
      if (args[0] === 'status' || args[0] === 'ls-tree') {
        return args[0] === 'ls-tree'
          ? TEST_CORPUS.files.map((file) => `100644 blob ${file.blob}\t${file.path}`).join('\n')
          : '';
      }
      return '';
    };
    const spawnSync = (_binary, args) => {
      const outfileIndex = args.indexOf('--reporter-outfile');
      fs.writeFileSync(args[outfileIndex + 1], '<testsuites><testsuite time="0.1"><testcase file="test/kernel/readiness-model.test.js" time="0.1"/></testsuite></testsuites>');
      return { status: 0, stderr: '', stdout: '' };
    };

    expect(() => main([
      '--json', '--group', 'kernel-core', '--output', outputPath, '--profile-dir', profileDir,
    ], {
      spawnSync,
      defaultJunitPath: path.join(profileDir, 'default-junit.xml'),
      gitExec,
      identity: TEST_IDENTITY,
    })).toThrow(/source snapshot changed/);
    expect(fs.existsSync(outputPath)).toBe(false);
  });

  test('main rejects a corpus snapshot change after sampling before writing output', () => {
    const outputDir = makeTempDir();
    const outputPath = path.join(outputDir, 'benchmark-results.json');
    const profileDir = path.join(outputDir, 'profiles');
    let corpusCalls = 0;
    const gitExec = (_binary, args) => {
      if (args[0] === 'rev-parse') return 'a'.repeat(40);
      if (args[0] === 'status') return '';
      if (args[0] === 'ls-tree') {
        corpusCalls += 1;
        const files = corpusCalls === 1
          ? TEST_CORPUS.files
          : TEST_CORPUS.files.map((file, index) => index === 0 ? { ...file, blob: 'f'.repeat(40) } : file);
        return files.map((file) => `100644 blob ${file.blob}\t${file.path}`).join('\n');
      }
      return '';
    };
    const spawnSync = (_binary, args) => {
      const outfileIndex = args.indexOf('--reporter-outfile');
      fs.writeFileSync(args[outfileIndex + 1], '<testsuites><testsuite time="0.1"><testcase file="test/kernel/readiness-model.test.js" time="0.1"/></testsuite></testsuites>');
      return { status: 0, stderr: '', stdout: '' };
    };

    expect(() => main([
      '--json', '--group', 'kernel-core', '--output', outputPath, '--profile-dir', profileDir,
    ], {
      spawnSync,
      defaultJunitPath: path.join(profileDir, 'default-junit.xml'),
      gitExec,
      identity: TEST_IDENTITY,
    })).toThrow(/source snapshot changed/);
    expect(fs.existsSync(outputPath)).toBe(false);
  });

  test('main rejects tracked source changes before spawning a benchmark', () => {
    const spawnSync = () => {
      throw new Error('benchmark should not start');
    };

    expect(() => main(['--group', 'kernel-core'], {
      spawnSync,
      defaultJunitPath: path.join(makeTempDir(), 'default-junit.xml'),
      gitExec: createGitExec(' M scripts/benchmark.js'),
      identity: TEST_IDENTITY,
    })).toThrow(/source is dirty/);
  });
});
