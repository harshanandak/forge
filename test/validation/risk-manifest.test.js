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
      'test/validation/risk-manifest-generator.test.js',
      'test/validation/risk-manifest.test.js',
    ]);
    expect(selected.changed_surfaces.map((surface) => surface.value)).toEqual([
      'lib/kernel/broker.js',
      'lib/validation/risk-manifest.js',
    ]);
  });

  test('uses package, contract, and platform baselines when package is known but surface is ambiguous', () => {
    const narrowed = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
    const kernel = narrowed.owners.find((owner) => owner.id === 'kernel-authority');
    kernel.selectors = kernel.selectors.map((selector) => selector.kind === 'path'
      ? { kind: 'path', prefix: 'lib/kernel/broker.js' }
      : selector);
    narrowed.manifest_hash = hashManifest(narrowed);
    const manifest = loadRiskManifest(narrowed);
    const selected = selectValidation({
      manifest,
      changedSurfaces: [{ kind: 'path', value: 'lib/kernel/worker.js' }],
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
    expect(selected.dependent_routes).toEqual(['memory-contract']);
    expect(selected.platform_runtime_additions).toEqual(['linux-sqlite', 'windows-sqlite']);
  });

  test('path selectors match exact files and segment-bounded directories only', () => {
    const manifest = loadRiskManifest(MANIFEST_PATH);
    const exactFile = selectValidation({
      manifest,
      changedSurfaces: [{ kind: 'path', value: 'scripts/generate-risk-manifest.js' }],
    });
    const directoryRoot = selectValidation({
      manifest,
      changedSurfaces: [{ kind: 'path', value: 'lib/kernel' }],
    });

    expect(exactFile.status).toBe('exact');
    expect(exactFile.owner_ids).toEqual(['validation-control']);
    expect(exactFile.test_ids).toEqual([
      'test/validation/risk-manifest-generator.test.js',
      'test/validation/risk-manifest.test.js',
    ]);
    expect(directoryRoot.status).toBe('exact');
    expect(directoryRoot.owner_ids).toEqual(['kernel-authority']);
  });

  test('lexical sibling paths are unowned and force the repository baseline', () => {
    const manifest = loadRiskManifest(MANIFEST_PATH);
    const selected = selectValidation({
      manifest,
      changedSurfaces: [
        { kind: 'path', value: 'scripts/generate-risk-manifest.js.bak' },
        { kind: 'path', value: 'lib/kernel-next/prototype.js' },
        { kind: 'path', value: 'packages/binary/forge.js' },
      ],
    });

    expect(selected.status).toBe('repository-baseline');
    expect(selected.targeted_pass_allowed).toBe(false);
    expect(selected.owner_ids).toEqual([]);
    expect(selected.unowned_surfaces).toEqual([
      { kind: 'path', value: 'lib/kernel-next/prototype.js' },
      { kind: 'path', value: 'packages/binary/forge.js' },
      { kind: 'path', value: 'scripts/generate-risk-manifest.js.bak' },
    ]);
  });

  test('workflow run selection carries dependent routes and every declared platform addition', () => {
    const manifest = loadRiskManifest(MANIFEST_PATH);
    const selected = selectValidation({
      manifest,
      changedSurfaces: [{ kind: 'path', value: 'lib/workflow/run.js' }],
    });

    expect(selected.dependent_routes).toEqual(['flow-memory-contract']);
    expect(selected.platform_runtime_additions).toEqual([
      'linux-process',
      'macos-process',
      'windows-process',
    ]);
    expect(selected.lanes).toEqual(['flow-package']);
    expect(selected.owner_selections).toEqual([{
      owner_id: 'workflow-runtime',
      product: 'flow',
      package: 'forge-flow',
      risk_ids: ['contract-compatibility', 'monitor-cleanup'],
      lanes: ['flow-package'],
      canonical_test_ids: ['test/workflow/**/*.test.js'],
      dependent_routes: ['flow-memory-contract'],
      platform_runtime_additions: ['linux-process', 'macos-process', 'windows-process'],
    }]);
  });

  test('issue CLI selection resolves G7 to deterministic argv commands', () => {
    const manifest = loadRiskManifest(MANIFEST_PATH);
    const selected = selectValidation({
      manifest,
      changedSurfaces: [{ kind: 'command', value: 'forge issue list' }],
    });

    expect(selected.status).toBe('exact');
    expect(selected.owner_ids).toEqual(['facade-cli']);
    expect(selected.required_gates).toEqual(['G0', 'G1', 'G7']);
    expect(selected.dependent_routes).toEqual(['installed-cli']);
    expect(selected.platform_runtime_additions).toEqual(['windows-shell']);
    expect(selected.commands.find((command) => command.id === 'validation.command.g7-journey')).toEqual({
      id: 'validation.command.g7-journey',
      executable: 'bun',
      argv: ['test', '--timeout', '15000', 'test/e2e'],
    });
    expect(selected.commands.every((command) => Array.isArray(command.argv))).toBe(true);
  });

  test('kernel broker selection includes Windows and Linux runtime additions', () => {
    const manifest = loadRiskManifest(MANIFEST_PATH);
    const selected = selectValidation({
      manifest,
      changedSurfaces: [{ kind: 'path', value: 'lib/kernel/broker.js' }],
    });

    expect(selected.platform_runtime_additions).toEqual(['linux-sqlite', 'windows-sqlite']);
    expect(selected.commands.map((command) => command.id)).toEqual([
      'validation.command.g0-static',
      'validation.command.g1-manifest-check',
      'validation.command.g1-selector',
      'validation.command.g4-authority',
      'validation.command.kernel-package',
    ]);
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
    expect(selected.commands.map((command) => command.id)).toEqual([
      'validation.command.g0-static',
      'validation.command.g1-manifest-check',
      'validation.command.g1-selector',
      'validation.command.g3-contract',
      'validation.command.g6-platform',
      'validation.command.repository-baseline',
    ]);
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

  test('rejects any gate or lane whose executable command cannot be resolved', () => {
    const original = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
    original.commands = original.commands.filter((command) => command.id !== 'validation.command.g4-authority');
    original.manifest_hash = hashManifest(original);

    expect(() => loadRiskManifest(original)).toThrow(/unknown command/i);
  });

  test('rejects a conservative fallback that drops a mandatory gate', () => {
    const original = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
    original.unknown_owner_fallback.required_gates = ['G0', 'G1', 'G3'];
    original.manifest_hash = hashManifest(original);

    expect(() => loadRiskManifest(original)).toThrow(/conservative fallback.*G6/i);
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
