'use strict';

const { describe, test, expect } = require('bun:test');
const {
  normalizePackPath,
  parsePackOutput,
  mapToBlock,
  measureBlocks,
  buildBaseline,
  evaluateBudget,
  renderReport,
  OTHER_BLOCK,
} = require('../lib/package-budget');

const KB = 1024;

const MANIFEST = {
  blocks: {
    cli: { paths: ['bin/', 'lib/commands/'] },
    kernel: { paths: ['lib/kernel/'] },
    lib: { paths: ['lib/'] },
    contracts: { paths: ['lib/contracts/', 'node_modules/@forge/contracts/'] },
    meta: { paths: ['package.json', 'README.md'] },
  },
};

const POLICY = {
  growth: { pct: 0.02, minBytes: 20 * KB },
  files: { pct: 0.02, min: 1 },
  hardCeiling: { unpackedBytes: 10 * 1024 * KB },
};

describe('normalizePackPath', () => {
  test.each([
    ['lib\\kernel\\broker.js', 'lib/kernel/broker.js'],
    ['./lib/a.js', 'lib/a.js'],
    ['lib/a.js', 'lib/a.js'],
    ['.\\bin\\forge.js', 'bin/forge.js'],
  ])('%s -> %s', (input, expected) => {
    expect(normalizePackPath(input)).toBe(expected);
  });
});

describe('mapToBlock', () => {
  test.each([
    ['bin/forge.js', 'cli'],
    ['lib/commands/setup.js', 'cli'],
    ['lib/kernel/broker.js', 'kernel'],
    ['lib/orientation.js', 'lib'],
    ['lib/contracts/index.js', 'contracts'],
    ['node_modules/@forge/contracts/src/schema.js', 'contracts'],
    ['package.json', 'meta'],
    ['README.md', 'meta'],
    ['docs/reference/EXAMPLES.md', OTHER_BLOCK],
    ['package.json.bak', OTHER_BLOCK],
    ['libx/a.js', OTHER_BLOCK],
    ['lib\\kernel\\schema.js', 'kernel'],
    ['lib\\commands\\push.js', 'cli'],
  ])('%s -> %s', (file, block) => {
    expect(mapToBlock(file, MANIFEST)).toBe(block);
  });

  test('longest prefix wins regardless of declaration order', () => {
    const reversed = { blocks: { deep: { paths: ['lib/a/b/'] }, shallow: { paths: ['lib/'] }, mid: { paths: ['lib/a/'] } } };
    expect(mapToBlock('lib/a/b/c.js', reversed)).toBe('deep');
    expect(mapToBlock('lib/a/c.js', reversed)).toBe('mid');
    expect(mapToBlock('lib/c.js', reversed)).toBe('shallow');
  });

  test('a path declared in two blocks is rejected', () => {
    const dup = { blocks: { a: { paths: ['lib/'] }, b: { paths: ['lib/'] } } };
    expect(() => mapToBlock('lib/x.js', dup)).toThrow(/declared in both/);
  });

  test('a manifest may not declare the reserved other block', () => {
    const bad = { blocks: { [OTHER_BLOCK]: { paths: ['x/'] } } };
    expect(() => mapToBlock('x/y', bad)).toThrow(/reserved/);
  });
});

describe('parsePackOutput + measureBlocks', () => {
  const packJson = JSON.stringify([{
    size: 300,
    unpackedSize: 1000,
    entryCount: 4,
    files: [
      { path: 'bin/forge.js', size: 400 },
      { path: 'lib/kernel/broker.js', size: 300 },
      { path: 'lib\\orientation.js', size: 200 },
      { path: 'docs/x.md', size: 100 },
    ],
  }]);

  test('parses tarball, unpacked, file count and entries', () => {
    const pack = parsePackOutput(packJson);
    expect(pack.tarball).toBe(300);
    expect(pack.unpacked).toBe(1000);
    expect(pack.files).toBe(4);
    expect(pack.entries.map((e) => e.path)).toEqual(['bin/forge.js', 'lib/kernel/broker.js', 'lib/orientation.js', 'docs/x.md']);
  });

  test('rejects output that is not an npm pack --json array', () => {
    expect(() => parsePackOutput('{}')).toThrow(/npm pack/);
    expect(() => parsePackOutput('not json')).toThrow();
  });

  test('every file lands in exactly one block; unmapped go to other', () => {
    const measured = measureBlocks(parsePackOutput(packJson), MANIFEST);
    expect(measured.blocks.cli).toEqual({ bytes: 400, files: 1 });
    expect(measured.blocks.kernel).toEqual({ bytes: 300, files: 1 });
    expect(measured.blocks.lib).toEqual({ bytes: 200, files: 1 });
    expect(measured.blocks[OTHER_BLOCK]).toEqual({ bytes: 100, files: 1 });
    expect(measured.blocks.contracts).toEqual({ bytes: 0, files: 0 });
    const sum = Object.values(measured.blocks).reduce((acc, b) => acc + b.bytes, 0);
    expect(sum).toBe(1000);
    expect(measured.total).toEqual({ tarball: 300, unpacked: 1000, files: 4 });
  });
});

function measuredWith(overrides = {}) {
  const blocks = {
    cli: { bytes: 400 * KB, files: 20 },
    kernel: { bytes: 1000 * KB, files: 50 },
    [OTHER_BLOCK]: { bytes: 10 * KB, files: 2 },
    ...overrides.blocks,
  };
  const unpacked = Object.values(blocks).reduce((acc, b) => acc + b.bytes, 0);
  const files = Object.values(blocks).reduce((acc, b) => acc + b.files, 0);
  return { blocks, total: { tarball: overrides.tarball ?? Math.round(unpacked / 4), unpacked, files } };
}

describe('evaluateBudget decision table', () => {
  const base = buildBaseline(measuredWith());

  const cases = [
    {
      name: 'equal',
      measured: measuredWith(),
      ok: true,
      statuses: { cli: 'equal', kernel: 'equal', total: 'equal' },
    },
    {
      name: 'small growth under the tolerance (20KB floor)',
      measured: measuredWith({ blocks: { cli: { bytes: 400 * KB + 19 * KB, files: 20 } } }),
      ok: true,
      statuses: { cli: 'within', total: 'within' },
    },
    {
      name: 'growth over the tolerance names the block that grew',
      measured: measuredWith({ blocks: { cli: { bytes: 400 * KB + 34 * KB, files: 20 } } }),
      ok: false,
      statuses: { cli: 'grew', kernel: 'equal' },
      failureMentions: ['cli'],
    },
    {
      name: 'file count growth over the tolerance fails',
      measured: measuredWith({ blocks: { cli: { bytes: 400 * KB, files: 22 } } }),
      ok: false,
      statuses: { cli: 'grew' },
      failureMentions: ['cli', 'files'],
    },
    {
      name: 'shrink passes and suggests lowering the baseline',
      measured: measuredWith({ blocks: { kernel: { bytes: 500 * KB, files: 30 } } }),
      ok: true,
      statuses: { kernel: 'shrank', total: 'shrank' },
      noteMentions: ['kernel', '--write-baseline'],
    },
    {
      name: 'a new block missing from the baseline fails',
      measured: measuredWith({ blocks: { flow: { bytes: 5 * KB, files: 1 } } }),
      ok: false,
      statuses: { flow: 'new' },
      failureMentions: ['flow', 'baseline'],
    },
    {
      name: 'a new block with no files passes',
      measured: measuredWith({ blocks: { flow: { bytes: 0, files: 0 } } }),
      ok: true,
      statuses: { flow: 'equal' },
    },
    {
      name: 'tarball growth over the tolerance fails the total',
      measured: measuredWith({ tarball: Math.round((1410 * KB) / 4) + 30 * KB }),
      ok: false,
      statuses: { total: 'grew' },
      failureMentions: ['tarball'],
    },
  ];

  test.each(cases)('$name', ({ measured, ok, statuses, failureMentions = [], noteMentions = [] }) => {
    const result = evaluateBudget({ measured, baseline: base, policy: POLICY });
    expect(result.ok).toBe(ok);
    for (const [name, status] of Object.entries(statuses)) {
      const row = name === 'total' ? result.total : result.blocks.find((b) => b.name === name);
      expect(row && row.status).toBe(status);
    }
    const failures = result.failures.join('\n');
    for (const needle of failureMentions) expect(failures).toContain(needle);
    const notes = result.notes.join('\n');
    for (const needle of noteMentions) expect(notes).toContain(needle);
    if (ok) expect(result.failures).toEqual([]);
  });

  test('growth with the baseline updated in the same PR is acknowledged, not failed', () => {
    const grown = measuredWith({ blocks: { cli: { bytes: 600 * KB, files: 30 } } });
    const result = evaluateBudget({
      measured: grown,
      baseline: buildBaseline(grown),
      previousBaseline: base,
      policy: POLICY,
    });
    expect(result.ok).toBe(true);
    expect(result.blocks.find((b) => b.name === 'cli').status).toBe('acknowledged');
    expect(result.notes.join('\n')).toContain('cli');
  });

  describe('a baseline changed in this PR must match the measured package', () => {
    const measured = measuredWith();
    const inflateBlock = () => {
      const inflated = buildBaseline(measured);
      inflated.blocks.cli = { bytes: 400 * KB + 100 * KB, files: 20 };
      return inflated;
    };

    test('an inflated block baseline fails and points at --write-baseline', () => {
      const result = evaluateBudget({ measured, baseline: inflateBlock(), previousBaseline: base, policy: POLICY });
      expect(result.ok).toBe(false);
      const failures = result.failures.join('\n');
      expect(failures).toContain('cli');
      expect(failures).toContain('node scripts/package-size-check.js --write-baseline');
    });

    test('an inflated total baseline fails and points at --write-baseline', () => {
      const inflated = buildBaseline(measured);
      inflated.total = { ...inflated.total, unpacked: inflated.total.unpacked + 200 * KB };
      const result = evaluateBudget({ measured, baseline: inflated, previousBaseline: base, policy: POLICY });
      expect(result.ok).toBe(false);
      const failures = result.failures.join('\n');
      expect(failures).toContain('unpacked');
      expect(failures).toContain('node scripts/package-size-check.js --write-baseline');
    });

    test('a mis-merged baseline that carries a stale larger block fails', () => {
      // The base branch shrank the kernel block; the PR baseline kept the old larger value.
      const shrunk = measuredWith({ blocks: { kernel: { bytes: 500 * KB, files: 30 } } });
      const previous = buildBaseline(shrunk);
      const misMerged = buildBaseline(shrunk);
      misMerged.blocks.kernel = { ...base.blocks.kernel };
      const result = evaluateBudget({ measured: shrunk, baseline: misMerged, previousBaseline: previous, policy: POLICY });
      expect(result.ok).toBe(false);
      expect(result.failures.join('\n')).toContain('kernel');
    });

    test('a changed baseline within tolerance of the measurement passes', () => {
      const nearly = buildBaseline(measured);
      nearly.blocks.cli = { bytes: 400 * KB + 5 * KB, files: 20 };
      const result = evaluateBudget({ measured, baseline: nearly, previousBaseline: base, policy: POLICY });
      expect(result.ok).toBe(true);
    });

    test('an unchanged baseline above a shrunk package still only notes the shrink', () => {
      const shrunk = measuredWith({ blocks: { kernel: { bytes: 500 * KB, files: 30 } } });
      const result = evaluateBudget({ measured: shrunk, baseline: base, previousBaseline: base, policy: POLICY });
      expect(result.ok).toBe(true);
      expect(result.notes.join('\n')).toContain('--write-baseline');
    });
  });

  test('over the hard ceiling fails even when the baseline was updated', () => {
    const huge = measuredWith({ blocks: { kernel: { bytes: 11 * 1024 * KB, files: 50 } } });
    const result = evaluateBudget({
      measured: huge,
      baseline: buildBaseline(huge),
      previousBaseline: base,
      policy: POLICY,
    });
    expect(result.ok).toBe(false);
    expect(result.failures.join('\n')).toMatch(/hard ceiling/);
  });

  test('the percentage tolerance applies once 2% exceeds the 20KB floor', () => {
    // kernel baseline 1000KB -> 2% = 20KB; a 2000KB block allows 40KB.
    const big = buildBaseline(measuredWith({ blocks: { kernel: { bytes: 2000 * KB, files: 50 } } }));
    const grown = measuredWith({ blocks: { kernel: { bytes: 2000 * KB + 35 * KB, files: 50 } } });
    const result = evaluateBudget({ measured: grown, baseline: big, policy: POLICY });
    expect(result.blocks.find((b) => b.name === 'kernel').status).toBe('within');
  });
});

describe('renderReport', () => {
  test('prints a per-block table with deltas and the verdict', () => {
    const base = buildBaseline(measuredWith());
    const grown = measuredWith({ blocks: { cli: { bytes: 400 * KB + 34 * KB, files: 20 } } });
    const md = renderReport(evaluateBudget({ measured: grown, baseline: base, policy: POLICY }));
    expect(md).toContain('| cli |');
    expect(md).toContain('+34.0 KB');
    expect(md).toContain('grew');
    expect(md).toMatch(/FAIL/);
  });
});

describe('input validation boundary fails closed', () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { validateBaseline, validateManifest, DEFAULT_POLICY } = require('../lib/package-budget');
  const { check, main } = require('../scripts/package-size-check');

  const PACK = { size: 300, unpackedSize: 1000, entryCount: 2, files: [
    { path: 'bin/forge.js', size: 600 },
    { path: 'lib/kernel/broker.js', size: 400 },
  ] };
  const packText = (pack = PACK) => JSON.stringify([pack]);
  const validBaseline = () => buildBaseline(measureBlocks(parsePackOutput(packText()), MANIFEST));
  const validManifest = () => ({ ...MANIFEST, policy: structuredClone(POLICY) });
  const withValue = (object, keyPath, value) => {
    const copy = structuredClone(object);
    const keys = keyPath.split('.');
    const leaf = keys.pop();
    const parent = keys.reduce((node, key) => node[key], copy);
    if (value === undefined) delete parent[leaf];
    else parent[leaf] = value;
    return copy;
  };
  const messageOf = (fn) => {
    try {
      fn();
    } catch (error) {
      return error.message;
    }
    return '(did not throw)';
  };

  const BAD_METRICS = [
    ['a string', 'oops', /"oops"/],
    ['null', null, /null/],
    ['a missing key', undefined, /missing/],
    ['a negative value', -1, /-1/],
    ['NaN', Number.NaN, /NaN/],
    ['Infinity', Number.POSITIVE_INFINITY, /Infinity/],
    ['a float', 1.5, /1\.5/],
  ];

  describe.each(['blocks.cli.bytes', 'blocks.kernel.files', 'total.unpacked', 'total.tarball', 'total.files'])('baseline %s', (keyPath) => {
    test.each(BAD_METRICS)('%s fails closed, naming the file, key, value and fix', (_label, value, valuePattern) => {
      const bad = withValue(validBaseline(), keyPath, value);
      const message = messageOf(() => validateBaseline(bad, { source: 'scripts/package-size-baseline.json' }));
      expect(message).toContain('scripts/package-size-baseline.json');
      expect(message).toContain(keyPath);
      expect(message).toMatch(valuePattern);
      expect(message).toContain('--write-baseline');
    });
  });

  test('a baseline block that is not an object, and a missing total, fail closed', () => {
    expect(messageOf(() => validateBaseline(withValue(validBaseline(), 'blocks.cli', 'oops'), { source: 'b.json' }))).toMatch(/b\.json.*blocks\.cli/);
    expect(messageOf(() => validateBaseline(withValue(validBaseline(), 'total', undefined), { source: 'b.json' }))).toMatch(/b\.json.*total/);
  });

  test.each([
    ['a nonnumeric file size', withValue(PACK, 'files.0.size', 'oops'), /files\[0\]\.size/],
    ['a missing file size', withValue(PACK, 'files.1.size', undefined), /files\[1\]\.size/],
    ['a float file size', withValue(PACK, 'files.0.size', 2.5), /2\.5/],
    ['a negative tarball size', withValue(PACK, 'size', -3), /size/],
    ['a nonnumeric unpacked size', withValue(PACK, 'unpackedSize', 'big'), /unpackedSize/],
    ['a nonnumeric entry count', withValue(PACK, 'entryCount', 'many'), /entryCount/],
    ['an empty file path', withValue(PACK, 'files.0.path', ''), /files\[0\]\.path/],
  ])('npm pack output with %s fails closed', (_label, pack, keyPattern) => {
    const message = messageOf(() => parsePackOutput(packText(pack)));
    expect(message).toContain('npm pack');
    expect(message).toMatch(keyPattern);
  });

  test.each([
    ['a string tolerance pct', 'policy.growth.pct', '0.02', /policy\.growth\.pct/],
    ['a negative files pct', 'policy.files.pct', -0.1, /policy\.files\.pct/],
    ['an Infinity pct', 'policy.growth.pct', Number.POSITIVE_INFINITY, /Infinity/],
    ['a string minBytes', 'policy.growth.minBytes', '20480', /policy\.growth\.minBytes/],
    ['a float files min', 'policy.files.min', 0.5, /policy\.files\.min/],
    ['a missing ceiling', 'policy.hardCeiling.unpackedBytes', undefined, /policy\.hardCeiling\.unpackedBytes/],
    ['a zero ceiling (would disable it)', 'policy.hardCeiling.unpackedBytes', 0, /policy\.hardCeiling\.unpackedBytes/],
    ['block paths that are not a list', 'blocks.cli.paths', 'bin/', /blocks\.cli\.paths/],
    ['an empty block path', 'blocks.kernel.paths', [''], /blocks\.kernel\.paths/],
  ])('a manifest with %s fails closed', (_label, keyPath, value, keyPattern) => {
    const message = messageOf(() => validateManifest(withValue(validManifest(), keyPath, value), { source: 'scripts/package-budgets.json' }));
    expect(message).toContain('scripts/package-budgets.json');
    expect(message).toMatch(keyPattern);
  });

  test('valid fixtures pass the boundary unchanged, and a manifest without a policy gets the default', () => {
    expect(validateBaseline(validBaseline(), { source: 'b.json' })).toEqual(validBaseline());
    expect(validateManifest(validManifest(), { source: 'm.json' }).policy).toEqual(POLICY);
    expect(validateManifest({ blocks: MANIFEST.blocks }, { source: 'm.json' }).policy).toEqual(DEFAULT_POLICY);
    const { result } = check({ packText: packText(), manifest: validManifest(), baseline: validBaseline() });
    expect(result.ok).toBe(true);
  });

  test('check() validates every input: a bad baseline, previous baseline or manifest throws instead of passing', () => {
    const args = { packText: packText(), manifest: validManifest(), baseline: validBaseline() };
    expect(messageOf(() => check({ ...args, baseline: withValue(validBaseline(), 'blocks.cli.bytes', 'oops') }))).toMatch(/package-size-baseline\.json.*blocks\.cli\.bytes/);
    expect(messageOf(() => check({ ...args, previousBaseline: withValue(validBaseline(), 'total.unpacked', null) }))).toMatch(/base-branch baseline.*total\.unpacked/);
    expect(messageOf(() => check({ ...args, manifest: withValue(validManifest(), 'policy.growth.pct', 'x') }))).toMatch(/package-budgets\.json.*policy\.growth\.pct/);
  });

  test('a --previous file that exists but is not valid JSON fails closed instead of being ignored', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pkg-budget-'));
    try {
      const previous = path.join(dir, 'base-baseline.json');
      const pack = path.join(dir, 'pack.json');
      fs.writeFileSync(previous, '{ not json');
      fs.writeFileSync(pack, packText());
      expect(messageOf(() => main(['--pack-json', pack, '--previous', previous], {}))).toContain('base-baseline.json');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
