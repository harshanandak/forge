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
    expect(JSON.parse(first).owners.map((owner) => owner.id)).toEqual([
      'facade-cli',
      'kernel-authority',
      'memory-foundation',
      'validation-control',
      'workflow-runtime',
    ]);
  });
});
