#!/usr/bin/env node
'use strict';

const { performance } = require('node:perf_hooks');

function readNumberFlag(args, name, fallback) {
  const index = args.indexOf(name);
  if (index === -1) return fallback;
  const value = Number(args[index + 1]);
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${name} must be a non-negative number`);
  }
  return value;
}

function assertPositiveInteger(name, value) {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
}

function assertNonNegativeInteger(name, value) {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer`);
  }
}

function runBench(options = {}) {
  const anchorCount = options.anchorCount ?? 500;
  const patchCount = options.patchCount ?? 50;
  const renameCount = options.renameCount ?? patchCount;
  const unmappedCount = options.unmappedCount ?? 2;
  const threshold = options.threshold ?? 0.10;

  assertPositiveInteger('anchorCount', anchorCount);
  assertPositiveInteger('patchCount', patchCount);
  assertNonNegativeInteger('renameCount', renameCount);
  assertNonNegativeInteger('unmappedCount', unmappedCount);
  if (patchCount > anchorCount) {
    throw new Error('patchCount must be <= anchorCount');
  }
  if (renameCount > patchCount) {
    throw new Error('renameCount must be <= patchCount');
  }
  if (unmappedCount > renameCount) {
    throw new Error('unmappedCount must be <= renameCount');
  }

  const start = performance.now();
  const oldAnchors = Array.from({ length: anchorCount }, (_, i) => `stage.${i}.body`);
  const patches = oldAnchors.slice(0, patchCount).map((anchor, i) => ({
    id: `patch-${String(i + 1).padStart(3, '0')}`,
    anchor,
  }));

  const currentAnchors = new Set(oldAnchors);
  const aliases = new Map();
  for (let i = 0; i < renameCount; i += 1) {
    const oldAnchor = oldAnchors[i];
    const newAnchor = `${oldAnchor}.v2`;
    currentAnchors.delete(oldAnchor);
    currentAnchors.add(newAnchor);
    if (i >= unmappedCount) {
      aliases.set(oldAnchor, newAnchor);
    }
  }

  let resolved = 0;
  let orphaned = 0;
  const orphanIds = [];
  for (const patch of patches) {
    if (currentAnchors.has(patch.anchor)) {
      resolved += 1;
      continue;
    }
    const alias = aliases.get(patch.anchor);
    if (alias && currentAnchors.has(alias)) {
      resolved += 1;
      continue;
    }
    orphaned += 1;
    orphanIds.push(patch.id);
  }

  const elapsedMs = performance.now() - start;
  const orphanRate = orphaned / patchCount;
  return {
    spike: 'patch-anchor-stability',
    patchCount,
    anchorCount,
    renamedAnchors: renameCount,
    aliasEntries: aliases.size,
    orphaned,
    resolved,
    orphanRate,
    threshold,
    passed: orphanRate < threshold,
    elapsedMs: Number(elapsedMs.toFixed(3)),
    complexity: 'O(patches + anchors + aliases) with Map/Set lookups',
    orphanIds,
  };
}

function main() {
  const args = process.argv.slice(2);
  const result = runBench({
    anchorCount: readNumberFlag(args, '--anchors', 500),
    patchCount: readNumberFlag(args, '--patches', 50),
    renameCount: readNumberFlag(args, '--renames', 50),
    unmappedCount: readNumberFlag(args, '--unmapped', 2),
    threshold: readNumberFlag(args, '--threshold', 0.10),
  });

  console.log(JSON.stringify(result, null, args.includes('--json') ? 0 : 2));
  if (!result.passed) {
    process.exitCode = 1;
  }
}

if (require.main === module) {
  main();
}

module.exports = { runBench };
