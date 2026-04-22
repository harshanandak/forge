const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { afterEach, describe, expect, test } = require('bun:test');

const {
  BENCHMARK_GROUPS,
  buildBenchmarkResults,
  buildJUnitCommand,
  calculateMedian,
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
    expect(args.samples).toBe(3);
  });

  test('resolveGroups returns the requested benchmark slices', () => {
    const groups = resolveGroups(['pre-push-runner', 'hotspot-shell']);
    expect(groups.map((group) => group.id)).toEqual(['pre-push-runner', 'hotspot-shell']);
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
      maxMs: 700,
      meanMs: 367,
      medianMs: 300,
      minMs: 100,
      samplesMs: [100, 300, 700],
    });
  });

  test('runBenchmarkGroup records samples and emits a matching profile file', () => {
    const profileDir = makeTempDir();
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

    const result = runBenchmarkGroup(group, {
      profileDir,
      samples: 2,
      spawnSync,
    });

    expect(result.groupId).toBe('synthetic');
    expect(result.samples).toBe(2);
    expect(result.samplesMs).toHaveLength(2);

    const profile = JSON.parse(fs.readFileSync(path.join(profileDir, 'synthetic.profile.json'), 'utf8'));
    expect(profile.label).toBe('benchmark-synthetic');
    expect(profile.slowestFiles[0].file).toBe('test/scripts/synthetic.test.js');
  });

  test('runBenchmarkGroup falls back to Bun default junit output when reporter-outfile is ignored', () => {
    const profileDir = makeTempDir();
    const fallbackJunitPath = path.join(__dirname, '..', 'test-results', 'test-results.xml');
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
      ], { spawnSync });

      expect(result.groups).toHaveLength(1);
      expect(result.groups[0].groupId).toBe('pre-push-runner');
      expect(result.totalMedianMs).toBe(result.groups[0].medianMs);
      expect(result.slowestGroup.groupId).toBe('pre-push-runner');

      const written = JSON.parse(fs.readFileSync(outputPath, 'utf8'));
      expect(written.requestedGroups).toEqual(['pre-push-runner']);
      expect(JSON.parse(stdoutChunks.join(''))).toEqual(result);
    } finally {
      process.stdout.write = write;
    }
  });

  test('buildBenchmarkResults keeps the slowest median group in summary', () => {
    const groups = BENCHMARK_GROUPS.slice(0, 2);
    const summary = buildBenchmarkResults(groups, [
      { groupId: 'pre-push-runner', groupLabel: 'Pre-push runner slice', medianMs: 1200, samples: 3 },
      { groupId: 'validation-core', groupLabel: 'Validation core slice', medianMs: 900, samples: 3 },
    ], '2026-04-17T12:00:00.000Z');

    expect(summary.totalMedianMs).toBe(2100);
    expect(summary.slowestGroup).toEqual({
      groupId: 'pre-push-runner',
      groupLabel: 'Pre-push runner slice',
      medianMs: 1200,
    });
    expect(summary.timestamp).toBe('2026-04-17T12:00:00.000Z');
  });
});
