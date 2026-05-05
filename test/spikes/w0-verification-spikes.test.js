const { describe, expect, test } = require('bun:test');
const { execFileSync } = require('node:child_process');
const path = require('node:path');
const { runBench: runPatchAnchorBench } = require('../../scripts/spikes/patch-anchor-stability-bench');
const { runBench: runConfigRaceBench } = require('../../scripts/spikes/config-race-bench');

const repoRoot = path.resolve(__dirname, '..', '..');

function runJson(scriptName, args = []) {
  const scriptPath = path.join(repoRoot, 'scripts', 'spikes', scriptName);
  const output = execFileSync(process.execPath, [scriptPath, '--json', ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  return JSON.parse(output);
}

describe('Wave 0 verification spike benches', () => {
  test('patch anchor rename bench stays below orphan threshold', () => {
    const result = runJson('patch-anchor-stability-bench.js');
    expect(result.patchCount).toBe(50);
    expect(result.renamedAnchors).toBe(50);
    expect(result.orphanRate).toBeLessThan(0.10);
    expect(result.passed).toBe(true);
  });

  test('cross-machine config race bench stays below manual resolve threshold', () => {
    const result = runJson('config-race-bench.js');
    expect(result.trials).toBe(50);
    expect(result.manualResolveRate).toBeLessThan(0.05);
    expect(result.passed).toBe(true);
  });

  test('patch anchor bench rejects zero and fractional patch counts', () => {
    expect(() => runPatchAnchorBench({ patchCount: 0 })).toThrow('patchCount must be a positive integer');
    expect(() => runPatchAnchorBench({ patchCount: 1.5 })).toThrow('patchCount must be a positive integer');
  });

  test('patch anchor CLI defaults rename count to patch count', () => {
    const result = runJson('patch-anchor-stability-bench.js', ['--patches', '25']);
    expect(result.patchCount).toBe(25);
    expect(result.renamedAnchors).toBe(25);
    expect(result.passed).toBe(true);
  });

  test('config race bench rejects zero and fractional trial counts', () => {
    expect(() => runConfigRaceBench({ trials: 0 })).toThrow('trials must be a positive integer');
    expect(() => runConfigRaceBench({ trials: 1.5 })).toThrow('trials must be a positive integer');
  });
});
