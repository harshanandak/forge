'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { afterEach, describe, expect, test } = require('bun:test');

const {
  BENCHMARK_GROUPS,
  buildBenchmarkResults,
  buildJUnitCommand,
  calculateMedian,
  formatResultLine,
  main,
  parseArgs,
  resolveGroups,
  runBenchmarkGroup,
  summarizeSamples,
} = require('../../scripts/benchmark');

const tempDirs = [];

function makeTempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-benchmark-test-'));
  tempDirs.push(dir);
  return dir;
}

function createSpawnStub() {
  const calls = [];
  const fn = (binary, args) => {
    calls.push({ args, binary });
    const outfileIndex = args.indexOf('--reporter-outfile');
    if (outfileIndex !== -1) {
      const junitPath = args[outfileIndex + 1];
      fs.mkdirSync(path.dirname(junitPath), { recursive: true });
      fs.writeFileSync(junitPath, `<?xml version="1.0" encoding="UTF-8"?>
<testsuites>
  <testsuite name="suite" time="0.25">
    <testcase classname="benchmark" name="sample" file="test/scripts/example.test.js" time="0.25"></testcase>
  </testsuite>
</testsuites>`, 'utf8');
    }
    return { status: 0 };
  };
  fn.calls = calls;
  return fn;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
  }
});

describe('scripts/benchmark.js', () => {
  test('parseArgs reads output, profileDir, samples, json, and groups', () => {
    const parsed = parseArgs([
      '--json',
      '--output', 'tmp/out.json',
      '--profile-dir', 'tmp/profiles',
      '--samples', '5',
      '--group', 'hotspot-shell',
      '--group', 'validation-core',
    ]);

    expect(parsed).toMatchObject({
      json: true,
      output: 'tmp/out.json',
      profileDir: 'tmp/profiles',
      samples: 5,
    });
    expect(parsed.groups).toEqual(['hotspot-shell', 'validation-core']);
  });

  test('resolveGroups keeps requested ordering and rejects unknown ids', () => {
    const resolved = resolveGroups(['validation-core', 'hotspot-shell']);
    expect(resolved.map((group) => group.id)).toEqual(['validation-core', 'hotspot-shell']);
    expect(() => resolveGroups(['missing-group'])).toThrow(/Unknown benchmark group/);
  });

  test('calculateMedian and summarizeSamples use median-of-three semantics', () => {
    expect(calculateMedian([100, 300, 200])).toBe(200);
    expect(summarizeSamples([100, 300, 200])).toEqual({
      maxMs: 300,
      meanMs: 200,
      medianMs: 200,
      minMs: 100,
      samplesMs: [100, 300, 200],
    });
  });

  test('buildJUnitCommand adds JUnit output for bun test commands', () => {
    expect(buildJUnitCommand(['bun', 'test', 'test/foo.test.js'], 'tmp/result.xml')).toEqual([
      'bun',
      'test',
      'test/foo.test.js',
      '--reporter=junit',
      '--reporter-outfile',
      'tmp/result.xml',
    ]);
    expect(buildJUnitCommand(['node', 'scripts/custom.js'], 'tmp/result.xml')).toEqual([
      'node',
      'scripts/custom.js',
    ]);
  });

  test('runBenchmarkGroup writes profile output and summary fields from repeated samples', () => {
    const profileDir = makeTempDir();
    const spawnStub = createSpawnStub();

    const result = runBenchmarkGroup(BENCHMARK_GROUPS[0], {
      profileDir,
      samples: 3,
      spawnSync: spawnStub,
    });

    expect(result.groupId).toBe(BENCHMARK_GROUPS[0].id);
    expect(result.samples).toBe(3);
    expect(result.samplesMs).toHaveLength(3);
    expect(result.profilePath.endsWith('.profile.json')).toBe(true);
    expect(fs.existsSync(path.join(process.cwd(), result.profilePath.replace(/\//g, path.sep)))).toBe(true);
    expect(spawnStub.calls).toHaveLength(3);
  });

  test('buildBenchmarkResults summarizes slowest group and total median', () => {
    const payload = buildBenchmarkResults(
      [BENCHMARK_GROUPS[0], BENCHMARK_GROUPS[1]],
      [
        { groupId: 'pre-push-runner', groupLabel: 'Pre-push runner slice', medianMs: 250, samples: 3 },
        { groupId: 'validation-core', groupLabel: 'Validation core slice', medianMs: 400, samples: 3 },
      ],
      '2026-04-17T00:00:00.000Z',
    );

    expect(payload.totalMedianMs).toBe(650);
    expect(payload.slowestGroup).toEqual({
      groupId: 'validation-core',
      groupLabel: 'Validation core slice',
      medianMs: 400,
    });
    expect(payload.timestamp).toBe('2026-04-17T00:00:00.000Z');
  });

  test('main writes benchmark output JSON for selected groups', () => {
    const profileDir = makeTempDir();
    const outputPath = path.join(profileDir, 'benchmarks.json');
    const spawnStub = createSpawnStub();
    const captured = [];
    const originalWrite = process.stdout.write;
    process.stdout.write = (chunk) => {
      captured.push(String(chunk));
      return true;
    };

    try {
      const payload = main([
        '--json',
        '--output', outputPath,
        '--profile-dir', profileDir,
        '--samples', '2',
        '--group', 'validation-core',
      ], {
        spawnSync: spawnStub,
      });

      const written = JSON.parse(fs.readFileSync(outputPath, 'utf8'));
      expect(payload.requestedGroups).toEqual(['validation-core']);
      expect(written.requestedGroups).toEqual(['validation-core']);
      expect(written.groups).toHaveLength(1);
      expect(JSON.parse(captured.join(''))).toEqual(written);
    } finally {
      process.stdout.write = originalWrite;
    }
  });

  test('formatResultLine produces a readable median summary', () => {
    expect(formatResultLine({
      groupLabel: 'Hotspot shell slice',
      maxMs: 900,
      medianMs: 700,
      minMs: 500,
    })).toBe('  Hotspot shell slice: median 700ms (min 500ms, max 900ms)');
  });
});
