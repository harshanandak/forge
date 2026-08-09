'use strict';

const { describe, test, expect } = require('bun:test');
const fs = require('node:fs');
const path = require('node:path');

const {
  hashManifest,
  loadRiskManifest,
  selectValidation,
} = require('../../lib/validation/risk-manifest');

const ROOT = path.resolve(__dirname, '../..');
const MANIFEST_PATH = path.join(ROOT, 'validation/risk-manifest.v1.json');

describe('risk-owned validation manifest', () => {
  test('loads a versioned, self-hashed manifest', () => {
    const manifest = loadRiskManifest(MANIFEST_PATH);

    expect(manifest.schema_id).toBe('forge.validation.risk-manifest.v1');
    expect(manifest.revision).toBe(1);
    expect(manifest.source_hash).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(manifest.manifest_hash).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(manifest.unknown_owner_fallback.lane).toBe('repository-baseline');
  });

  test('selects exact canonical owners with deterministic gates and tests', () => {
    const manifest = loadRiskManifest(MANIFEST_PATH);
    const selected = selectValidation({
      manifest,
      changedSurfaces: [
        { kind: 'path', value: 'lib/kernel/broker.js' },
        { kind: 'path', value: 'lib/validation/risk-manifest.js' },
      ],
    });

    expect(selected.status).toBe('exact');
    expect(selected.targeted_pass_allowed).toBe(true);
    expect(selected.manifest_digest).toBe(manifest.manifest_hash);
    expect(selected.owner_ids).toEqual(['kernel-authority', 'validation-control']);
    expect(selected.matched_selectors).toEqual([
      {
        surface: { kind: 'path', value: 'lib/kernel/broker.js' },
        owner_id: 'kernel-authority',
        selector: { kind: 'path', prefix: 'lib/kernel/' },
      },
      {
        surface: { kind: 'path', value: 'lib/validation/risk-manifest.js' },
        owner_id: 'validation-control',
        selector: { kind: 'path', prefix: 'lib/validation/' },
      },
    ]);
    expect(selected.required_gates).toEqual(['G0', 'G1', 'G4']);
    expect(selected.test_ids).toEqual([
      'test/kernel/**/*.test.js',
      'test/validation/risk-manifest.test.js',
    ]);
    expect(selected.changed_surfaces.map((surface) => surface.value)).toEqual([
      'lib/kernel/broker.js',
      'lib/validation/risk-manifest.js',
    ]);
  });

  test('uses package, contract, and platform baselines when package is known but surface is ambiguous', () => {
    const manifest = loadRiskManifest(MANIFEST_PATH);
    const selected = selectValidation({
      manifest,
      changedSurfaces: [{ kind: 'path', value: 'lib/kernel-next/prototype.js' }],
    });

    expect(selected.status).toBe('conservative-package');
    expect(selected.targeted_pass_allowed).toBe(false);
    expect(selected.owner_ids).toEqual(['kernel-authority']);
    expect(selected.required_gates).toEqual(['G0', 'G1', 'G3', 'G4', 'G6']);
    expect(selected.lanes).toEqual([
      'affected-platform-baseline',
      'contract-baseline',
      'kernel-package',
    ]);
  });

  test('maps public commands and contract schemas through the same ownership contract', () => {
    const manifest = loadRiskManifest(MANIFEST_PATH);
    const selected = selectValidation({
      manifest,
      changedSurfaces: [
        { kind: 'command', value: 'forge issue list' },
        { kind: 'schema', value: 'forge.kernel.issue.v1' },
      ],
    });

    expect(selected.status).toBe('exact');
    expect(selected.owner_ids).toEqual(['facade-cli', 'kernel-authority']);
    expect(selected.required_gates).toEqual(['G0', 'G1', 'G4', 'G7']);
  });

  test('fails closed to the repository baseline for an unowned changed surface', () => {
    const manifest = loadRiskManifest(MANIFEST_PATH);
    const selected = selectValidation({
      manifest,
      changedSurfaces: [{ kind: 'path', value: 'experimental/unowned.js' }],
    });

    expect(selected.status).toBe('repository-baseline');
    expect(selected.targeted_pass_allowed).toBe(false);
    expect(selected.owner_ids).toEqual([]);
    expect(selected.lanes).toEqual(['repository-baseline']);
    expect(selected.unowned_surfaces).toEqual([{ kind: 'path', value: 'experimental/unowned.js' }]);
  });

  test('does not claim targeted PASS when no changed surfaces were supplied', () => {
    const manifest = loadRiskManifest(MANIFEST_PATH);
    const selected = selectValidation({ manifest, changedSurfaces: [] });

    expect(selected.status).toBe('repository-baseline');
    expect(selected.targeted_pass_allowed).toBe(false);
  });

  test('rejects a modified or overlapping manifest instead of selecting optimistically', () => {
    const original = fs.readFileSync(MANIFEST_PATH, 'utf8');
    const tampered = JSON.parse(original);
    tampered.revision += 1;

    expect(() => loadRiskManifest(tampered)).toThrow(/manifest hash mismatch/i);

    const overlapping = JSON.parse(original);
    overlapping.owners.push({ ...overlapping.owners[0], id: 'overlap' });
    overlapping.manifest_hash = hashManifest(overlapping);

    expect(() => loadRiskManifest(overlapping)).toThrow(/selectors overlap/i);
  });

  test('normalizes and de-duplicates changed surfaces before selection', () => {
    const manifest = loadRiskManifest(MANIFEST_PATH);
    const selected = selectValidation({
      manifest,
      changedSurfaces: [
        { kind: 'path', value: '.\\lib\\kernel\\broker.js' },
        { kind: 'path', value: 'lib/kernel/broker.js' },
      ],
    });

    expect(selected.changed_surfaces).toEqual([{ kind: 'path', value: 'lib/kernel/broker.js' }]);
  });
});
