'use strict';

const { describe, test, expect } = require('bun:test');
const fs = require('node:fs');
const path = require('node:path');

const { generateRiskManifest } = require('../../scripts/generate-risk-manifest');

const ROOT = path.resolve(__dirname, '../..');
const SOURCE_PATH = path.join(ROOT, 'validation/risk-manifest.source.yaml');

describe('risk manifest generator', () => {
  test('generates byte-identical canonical output without host or time data', () => {
    const source = fs.readFileSync(SOURCE_PATH, 'utf8');
    const first = generateRiskManifest(source);
    const second = generateRiskManifest(source);
    const windowsCheckout = generateRiskManifest(source.replaceAll('\n', '\r\n'));

    expect(first).toBe(second);
    expect(windowsCheckout).toBe(first);
    expect(first.endsWith('\n')).toBe(true);
    expect(first).not.toContain('generated_at');
    expect(first).not.toContain(process.cwd());
    const generated = JSON.parse(first);
    expect(generated.owners.map((owner) => owner.id)).toEqual([
      'facade-cli',
      'kernel-authority',
      'memory-foundation',
      'validation-control',
      'workflow-runtime',
    ]);
    expect(generated.gates.map((gate) => gate.id)).toEqual(['G0', 'G1', 'G3', 'G4', 'G5', 'G6', 'G7']);
    expect(generated.lanes.map((lane) => lane.id)).toEqual([
      'affected-platform-baseline',
      'contract-baseline',
      'facade-package',
      'flow-package',
      'kernel-package',
      'memory-package',
      'repository-baseline',
      'validation-selector',
    ]);
    expect(generated.commands.every((command) => command.executable && Array.isArray(command.argv))).toBe(true);
  });
});
