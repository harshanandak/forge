'use strict';

/**
 * Package budget building block: pure logic for measuring the published
 * package per named block and ratcheting it against a committed baseline.
 *
 * No process, filesystem, or CI coupling. Callers supply the raw
 * `npm pack --dry-run --json` output, a block manifest, a baseline, and a
 * policy; this module returns data and markdown. See
 * scripts/package-size-check.js for the thin CLI wrapper.
 */

const OTHER_BLOCK = 'other';

const WRITE_BASELINE_COMMAND = 'node scripts/package-size-check.js --write-baseline';

// Deterministic byte-order comparison; independent of the host locale.
function byteOrder(a, b) {
  if (a < b) return -1;
  return a > b ? 1 : 0;
}

const DEFAULT_POLICY = Object.freeze({
  growth: { pct: 0.02, minBytes: 20 * 1024 },
  files: { pct: 0.02, min: 1 },
  hardCeiling: { unpackedBytes: 10 * 1024 * 1024 },
});

// --- Input validation boundary -------------------------------------------
// Every input (npm pack output, block manifest + policy, current and previous
// baseline) is validated where it is loaded, so evaluateBudget only ever sees
// finite, non-negative integers. A NaN or string metric would otherwise make
// every comparison false and classify the metric as "within": failing open.

const PACK_SOURCE = 'npm pack --dry-run --json output';
const PACK_FIX = 'rerun npm pack --dry-run --json --ignore-scripts; the pack output is malformed';
const BASELINE_FIX = `run ${WRITE_BASELINE_COMMAND} and commit the result`;

function describeValue(value) {
  if (value === undefined) return 'missing';
  if (typeof value === 'number') return String(value);
  return JSON.stringify(value);
}

function invalid(where, key, value, rule) {
  throw new Error(`${where.source}: ${key} ${rule} (got ${describeValue(value)}); ${where.fix}`);
}

function requireObject(value, where, key) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) invalid(where, key, value, 'must be an object');
  return value;
}

function requireCount(value, where, key) {
  if (!Number.isSafeInteger(value) || value < 0) invalid(where, key, value, 'must be a finite non-negative integer');
  return value;
}

function requireRatio(value, where, key) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) invalid(where, key, value, 'must be a finite number >= 0');
  return value;
}

function validatePolicy(policy, where) {
  requireObject(policy, where, 'policy');
  const growth = requireObject(policy.growth, where, 'policy.growth');
  const files = requireObject(policy.files, where, 'policy.files');
  const ceiling = requireObject(policy.hardCeiling, where, 'policy.hardCeiling');
  const unpackedBytes = requireCount(ceiling.unpackedBytes, where, 'policy.hardCeiling.unpackedBytes');
  // A zero ceiling would silently disable the hard-ceiling check.
  if (unpackedBytes === 0) invalid(where, 'policy.hardCeiling.unpackedBytes', unpackedBytes, 'must be greater than 0');
  return {
    growth: { pct: requireRatio(growth.pct, where, 'policy.growth.pct'), minBytes: requireCount(growth.minBytes, where, 'policy.growth.minBytes') },
    files: { pct: requireRatio(files.pct, where, 'policy.files.pct'), min: requireCount(files.min, where, 'policy.files.min') },
    hardCeiling: { unpackedBytes },
  };
}

/**
 * Validates a block manifest (block paths and optional policy). Returns
 * `{ blocks, policy }` with the default policy applied when none is declared.
 */
function validateManifest(manifest, { source = 'scripts/package-budgets.json' } = {}) {
  const where = { source, fix: `fix ${source}` };
  requireObject(manifest, where, '(root)');
  const blocks = {};
  for (const [name, block] of Object.entries(requireObject(manifest.blocks, where, 'blocks'))) {
    requireObject(block, where, `blocks.${name}`);
    const key = `blocks.${name}.paths`;
    if (!Array.isArray(block.paths) || block.paths.length === 0) invalid(where, key, block.paths, 'must be a non-empty list of paths');
    if (block.paths.some((entry) => typeof entry !== 'string' || entry.trim() === '')) invalid(where, key, block.paths, 'must contain only non-empty path strings');
    blocks[name] = { paths: [...block.paths] };
  }
  const policy = manifest.policy === undefined ? DEFAULT_POLICY : validatePolicy(manifest.policy, where);
  const validated = { blocks, policy };
  compilePrefixes(validated); // reserved and duplicate paths
  return validated;
}

/**
 * Validates a baseline (current or base-branch). Block names are checked by
 * evaluateBudget: a manifest block missing here is "new", a baseline block the
 * manifest no longer declares is noted for removal.
 */
function validateBaseline(baseline, { source = 'scripts/package-size-baseline.json', fix = BASELINE_FIX } = {}) {
  const where = { source, fix };
  requireObject(baseline, where, '(root)');
  const total = requireObject(baseline.total, where, 'total');
  const blocks = {};
  for (const [name, block] of Object.entries(requireObject(baseline.blocks, where, 'blocks'))) {
    requireObject(block, where, `blocks.${name}`);
    blocks[name] = {
      bytes: requireCount(block.bytes, where, `blocks.${name}.bytes`),
      files: requireCount(block.files, where, `blocks.${name}.files`),
    };
  }
  return {
    total: {
      tarball: requireCount(total.tarball, where, 'total.tarball'),
      unpacked: requireCount(total.unpacked, where, 'total.unpacked'),
      files: requireCount(total.files, where, 'total.files'),
    },
    blocks,
  };
}

function normalizePackPath(filePath) {
  return String(filePath).replaceAll('\\', '/').replace(/^(\.\/)+/, '');
}

function parsePackOutput(text) {
  const parsed = JSON.parse(text);
  const pack = Array.isArray(parsed) ? parsed[0] : null;
  if (!pack || !Array.isArray(pack.files)) {
    throw new Error('Expected npm pack --dry-run --json output (an array with a files list)');
  }
  const where = { source: PACK_SOURCE, fix: PACK_FIX };
  const entries = pack.files.map((f, i) => {
    requireObject(f, where, `files[${i}]`);
    if (typeof f.path !== 'string' || f.path.trim() === '') invalid(where, `files[${i}].path`, f.path, 'must be a non-empty string');
    return { path: normalizePackPath(f.path), size: requireCount(f.size, where, `files[${i}].size`) };
  });
  return {
    tarball: requireCount(pack.size, where, 'size'),
    unpacked: requireCount(pack.unpackedSize, where, 'unpackedSize'),
    files: pack.entryCount === undefined ? entries.length : requireCount(pack.entryCount, where, 'entryCount'),
    entries,
  };
}

function compilePrefixes(manifest) {
  const owners = new Map();
  for (const [name, block] of Object.entries(manifest.blocks || {})) {
    if (name === OTHER_BLOCK) {
      throw new Error(`Block name "${OTHER_BLOCK}" is reserved for unmapped files`);
    }
    for (const raw of block.paths || []) {
      const prefix = normalizePackPath(raw);
      if (owners.has(prefix)) {
        throw new Error(`Path "${prefix}" is declared in both "${owners.get(prefix)}" and "${name}"`);
      }
      owners.set(prefix, name);
    }
  }
  // Longest prefix first, so the most specific declaration wins.
  return [...owners.entries()].sort((a, b) => b[0].length - a[0].length);
}

function prefixMatches(filePath, prefix) {
  if (prefix.endsWith('/')) return filePath.startsWith(prefix);
  return filePath === prefix || filePath.startsWith(`${prefix}/`);
}

function mapWithPrefixes(filePath, prefixes) {
  const normalized = normalizePackPath(filePath);
  const hit = prefixes.find(([prefix]) => prefixMatches(normalized, prefix));
  return hit ? hit[1] : OTHER_BLOCK;
}

function mapToBlock(filePath, manifest) {
  return mapWithPrefixes(filePath, compilePrefixes(manifest));
}

function measureBlocks(pack, manifest) {
  const prefixes = compilePrefixes(manifest);
  const blocks = {};
  for (const name of Object.keys(manifest.blocks || {})) blocks[name] = { bytes: 0, files: 0 };
  blocks[OTHER_BLOCK] = { bytes: 0, files: 0 };
  for (const entry of pack.entries) {
    const block = blocks[mapWithPrefixes(entry.path, prefixes)];
    block.bytes += entry.size;
    block.files += 1;
  }
  return { blocks, total: { tarball: pack.tarball, unpacked: pack.unpacked, files: pack.files } };
}

function buildBaseline(measured) {
  const blocks = {};
  for (const name of Object.keys(measured.blocks).sort(byteOrder)) {
    blocks[name] = { bytes: measured.blocks[name].bytes, files: measured.blocks[name].files };
  }
  return { total: { ...measured.total }, blocks };
}

function byteTolerance(base, policy) {
  return Math.max(Math.round(base * policy.growth.pct), policy.growth.minBytes);
}

function fileTolerance(base, policy) {
  return Math.max(base * policy.files.pct, policy.files.min);
}

function classify(current, base, tolerance) {
  const delta = current - base;
  if (delta === 0) return 'equal';
  if (delta > tolerance) return 'grew';
  if (delta < -tolerance) return 'shrank';
  return 'within';
}

// Combine per-metric verdicts: any growth wins, then shrink, then within.
function combine(statuses) {
  for (const s of ['grew', 'shrank', 'within']) if (statuses.includes(s)) return s;
  return 'equal';
}

function compareMetrics(current, base, metrics) {
  const details = {};
  for (const { key, tolerance } of metrics) {
    details[key] = {
      current: current[key],
      baseline: base[key],
      delta: current[key] - base[key],
      tolerance,
      status: classify(current[key], base[key], tolerance),
    };
  }
  return details;
}

// A baseline value this PR changed (relative to the base branch) must match
// the current measurement within tolerance in both directions; otherwise an
// inflated or mis-merged baseline would bank headroom for later growth.
function changedBaselineFailures(label, details, previous) {
  const failures = [];
  for (const [key, d] of Object.entries(details)) {
    const changed = !previous || previous[key] !== d.baseline;
    if (changed && d.status === 'shrank') {
      failures.push(`${label} baseline ${key} changed in this PR but is ${formatMetric(key, -d.delta)} above the measured package (tolerance ${formatMetric(key, d.tolerance)}); a changed baseline must match the package: run ${WRITE_BASELINE_COMMAND} and commit it`);
    }
  }
  return failures;
}

function evaluateBudget({ measured, baseline, previousBaseline = null, policy = DEFAULT_POLICY }) {
  const failures = [];
  const notes = [];
  const baseBlocks = baseline.blocks || {};
  const prevBlocks = previousBaseline ? previousBaseline.blocks || {} : null;

  const blockMetrics = (base) => [
    { key: 'bytes', tolerance: byteTolerance(base.bytes, policy) },
    { key: 'files', tolerance: fileTolerance(base.files, policy) },
  ];

  const blocks = Object.keys(measured.blocks).sort(byteOrder).map((name) => {
    const current = measured.blocks[name];
    const base = baseBlocks[name];
    if (!base) {
      if (current.files === 0) return { name, status: 'equal', current, baseline: null, details: null };
      failures.push(`Block "${name}" (${formatBytes(current.bytes)}, ${current.files} files) is not in the baseline; run --write-baseline and commit it`);
      return { name, status: 'new', current, baseline: null, details: null };
    }
    const details = compareMetrics(current, base, blockMetrics(base));
    if (prevBlocks) failures.push(...changedBaselineFailures(`Block "${name}"`, details, prevBlocks[name]));
    let status = combine(Object.values(details).map((d) => d.status));
    if (status === 'grew') {
      for (const [key, d] of Object.entries(details)) {
        if (d.status === 'grew') failures.push(`Block "${name}" grew ${formatMetric(key, d.delta)} ${key} (tolerance ${formatMetric(key, d.tolerance)}); if intended, update the baseline in this PR`);
      }
    } else if (prevBlocks) {
      const prev = prevBlocks[name];
      const grewVsPrev = !prev || Object.values(compareMetrics(current, prev, blockMetrics(prev))).some((d) => d.status === 'grew');
      if (grewVsPrev) {
        status = 'acknowledged';
        notes.push(`Block "${name}" growth is acknowledged by the baseline update in this PR`);
      }
    }
    if (status === 'shrank') notes.push(`Block "${name}" shrank beyond tolerance; consider lowering the baseline with --write-baseline`);
    return { name, status, current, baseline: base, details };
  });

  for (const name of Object.keys(baseBlocks)) {
    if (!measured.blocks[name]) notes.push(`Baseline block "${name}" no longer exists in the manifest; regenerate with --write-baseline`);
  }

  const baseTotal = baseline.total;
  const totalDetails = compareMetrics(measured.total, baseTotal, [
    { key: 'unpacked', tolerance: byteTolerance(baseTotal.unpacked, policy) },
    { key: 'tarball', tolerance: byteTolerance(baseTotal.tarball, policy) },
    { key: 'files', tolerance: fileTolerance(baseTotal.files, policy) },
  ]);
  const totalStatus = combine(Object.values(totalDetails).map((d) => d.status));
  if (previousBaseline) failures.push(...changedBaselineFailures('Total', totalDetails, previousBaseline.total));
  for (const [key, d] of Object.entries(totalDetails)) {
    if (d.status === 'grew') failures.push(`Total ${key} grew ${formatMetric(key, d.delta)} (tolerance ${formatMetric(key, d.tolerance)}); if intended, update the baseline in this PR`);
  }
  if (totalStatus === 'shrank') notes.push('Total package shrank beyond tolerance; consider lowering the baseline with --write-baseline');

  const ceiling = policy.hardCeiling?.unpackedBytes;
  if (ceiling && measured.total.unpacked > ceiling) {
    failures.push(`Unpacked size ${formatBytes(measured.total.unpacked)} exceeds the hard ceiling of ${formatBytes(ceiling)}`);
  }

  return {
    ok: failures.length === 0,
    blocks,
    total: { status: totalStatus, details: totalDetails },
    failures,
    notes,
  };
}

function formatBytes(bytes) {
  const abs = Math.abs(bytes);
  if (abs >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  return `${(bytes / 1024).toFixed(1)} KB`;
}

function signed(text, n) {
  return n > 0 ? `+${text}` : text;
}

function formatMetric(key, n) {
  return key === 'files' ? signed(String(Math.round(n * 100) / 100), n) : signed(formatBytes(n), n);
}

function renderReport(result) {
  const lines = [
    '## Package size budget',
    '',
    `**Verdict:** ${result.ok ? 'PASS' : 'FAIL'}`,
    '',
    '| Block | Bytes | Baseline | Delta | Files | Baseline files | Status |',
    '| --- | ---: | ---: | ---: | ---: | ---: | --- |',
  ];
  for (const b of result.blocks) {
    const baseBytes = b.baseline ? b.baseline.bytes : 0;
    const baseFiles = b.baseline ? b.baseline.files : 0;
    lines.push(`| ${b.name} | ${formatBytes(b.current.bytes)} | ${b.baseline ? formatBytes(baseBytes) : '-'} | ${formatMetric('bytes', b.current.bytes - baseBytes)} | ${b.current.files} | ${b.baseline ? baseFiles : '-'} | ${b.status} |`);
  }
  const t = result.total.details;
  lines.push(
    `| **total (unpacked)** | ${formatBytes(t.unpacked.current)} | ${formatBytes(t.unpacked.baseline)} | ${formatMetric('bytes', t.unpacked.delta)} | ${t.files.current} | ${t.files.baseline} | ${result.total.status} |`,
    `| **tarball** | ${formatBytes(t.tarball.current)} | ${formatBytes(t.tarball.baseline)} | ${formatMetric('bytes', t.tarball.delta)} | | | ${t.tarball.status} |`,
  );
  if (result.failures.length) lines.push('', '### Failures', ...result.failures.map((f) => `- ${f}`));
  if (result.notes.length) lines.push('', '### Notes', ...result.notes.map((n) => `- ${n}`));
  return `${lines.join('\n')}\n`;
}

module.exports = {
  OTHER_BLOCK,
  DEFAULT_POLICY,
  normalizePackPath,
  parsePackOutput,
  mapToBlock,
  measureBlocks,
  buildBaseline,
  validateBaseline,
  validateManifest,
  evaluateBudget,
  renderReport,
  formatBytes,
};
