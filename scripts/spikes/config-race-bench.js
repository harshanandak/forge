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

function machinePatch(trial, machine) {
  const sharedValue = trial % 10 === 0 ? `shared-${trial}` : undefined;
  const conflictingValue = trial === 37 ? `${machine}-conflict-${trial}` : undefined;
  return {
    machine,
    global: {
      ...(sharedValue ? { 'stage.review.timeout': sharedValue } : {}),
      ...(conflictingValue ? { 'stage.dev.parallelism': conflictingValue } : {}),
    },
    machineLocal: {
      [`${machine}.shell`]: machine === 'machine-a' ? 'git-bash' : 'pwsh',
      [`${machine}.workspace`]: `.forge/machines/${machine}`,
    },
  };
}

function mergeTrial(trial) {
  const left = machinePatch(trial, 'machine-a');
  const right = machinePatch(trial, 'machine-b');
  const merged = { global: {}, machineLocal: {} };
  const conflicts = [];

  for (const patch of [left, right]) {
    Object.assign(merged.machineLocal, patch.machineLocal);
  }

  const globalKeys = new Set([...Object.keys(left.global), ...Object.keys(right.global)]);
  for (const key of globalKeys) {
    const leftHas = Object.prototype.hasOwnProperty.call(left.global, key);
    const rightHas = Object.prototype.hasOwnProperty.call(right.global, key);
    if (leftHas && rightHas && left.global[key] !== right.global[key]) {
      conflicts.push(key);
      continue;
    }
    merged.global[key] = leftHas ? left.global[key] : right.global[key];
  }

  return {
    trial,
    manualResolve: conflicts.length > 0,
    conflicts,
    mergedKeyCount: Object.keys(merged.global).length + Object.keys(merged.machineLocal).length,
  };
}

function runBench(options = {}) {
  const trials = options.trials ?? 50;
  const threshold = options.threshold ?? 0.05;
  const start = performance.now();
  const results = Array.from({ length: trials }, (_, index) => mergeTrial(index + 1));
  const manualResolves = results.filter((result) => result.manualResolve);
  const manualResolveRate = manualResolves.length / trials;
  const elapsedMs = performance.now() - start;

  return {
    spike: 'cross-machine-config-race',
    trials,
    manualResolves: manualResolves.length,
    manualResolveRate,
    threshold,
    passed: manualResolveRate < threshold,
    elapsedMs: Number(elapsedMs.toFixed(3)),
    complexity: 'O(trials * changed keys); machine-local files avoid shared-file git conflicts',
    conflictTrials: manualResolves.map((result) => ({
      trial: result.trial,
      conflicts: result.conflicts,
    })),
  };
}

function main() {
  const args = process.argv.slice(2);
  const result = runBench({
    trials: readNumberFlag(args, '--trials', 50),
    threshold: readNumberFlag(args, '--threshold', 0.05),
  });

  console.log(JSON.stringify(result, null, args.includes('--json') ? 0 : 2));
  if (!result.passed) {
    process.exitCode = 1;
  }
}

if (require.main === module) {
  main();
}

module.exports = { runBench, mergeTrial };
