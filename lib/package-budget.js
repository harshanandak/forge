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

const DEFAULT_POLICY = Object.freeze({
  growth: { pct: 0.02, minBytes: 20 * 1024 },
  files: { pct: 0.02, min: 1 },
  hardCeiling: { unpackedBytes: 10 * 1024 * 1024 },
});

function normalizePackPath(filePath) {
  return String(filePath).replaceAll('\\', '/').replace(/^(\.\/)+/, '');
}

function parsePackOutput(text) {
  const parsed = JSON.parse(text);
  const pack = Array.isArray(parsed) ? parsed[0] : null;
  if (!pack || !Array.isArray(pack.files)) {
    throw new Error('Expected npm pack --dry-run --json output (an array with a files list)');
  }
  return {
    tarball: pack.size,
    unpacked: pack.unpackedSize,
    files: pack.entryCount ?? pack.files.length,
    entries: pack.files.map((f) => ({ path: normalizePackPath(f.path), size: f.size })),
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
  for (const name of Object.keys(measured.blocks).sort()) {
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

function evaluateBudget({ measured, baseline, previousBaseline = null, policy = DEFAULT_POLICY }) {
  const failures = [];
  const notes = [];
  const baseBlocks = baseline.blocks || {};
  const prevBlocks = previousBaseline ? previousBaseline.blocks || {} : null;

  const blockMetrics = (base) => [
    { key: 'bytes', tolerance: byteTolerance(base.bytes, policy) },
    { key: 'files', tolerance: fileTolerance(base.files, policy) },
  ];

  const blocks = Object.keys(measured.blocks).sort().map((name) => {
    const current = measured.blocks[name];
    const base = baseBlocks[name];
    if (!base) {
      if (current.files === 0) return { name, status: 'equal', current, baseline: null, details: null };
      failures.push(`Block "${name}" (${formatBytes(current.bytes)}, ${current.files} files) is not in the baseline; run --write-baseline and commit it`);
      return { name, status: 'new', current, baseline: null, details: null };
    }
    const details = compareMetrics(current, base, blockMetrics(base));
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
  for (const [key, d] of Object.entries(totalDetails)) {
    if (d.status === 'grew') failures.push(`Total ${key} grew ${formatMetric(key, d.delta)} (tolerance ${formatMetric(key, d.tolerance)}); if intended, update the baseline in this PR`);
  }
  if (totalStatus === 'shrank') notes.push('Total package shrank beyond tolerance; consider lowering the baseline with --write-baseline');

  const ceiling = policy.hardCeiling && policy.hardCeiling.unpackedBytes;
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
  lines.push(`| **total (unpacked)** | ${formatBytes(t.unpacked.current)} | ${formatBytes(t.unpacked.baseline)} | ${formatMetric('bytes', t.unpacked.delta)} | ${t.files.current} | ${t.files.baseline} | ${result.total.status} |`);
  lines.push(`| **tarball** | ${formatBytes(t.tarball.current)} | ${formatBytes(t.tarball.baseline)} | ${formatMetric('bytes', t.tarball.delta)} | | | ${t.tarball.status} |`);
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
  evaluateBudget,
  renderReport,
  formatBytes,
};
