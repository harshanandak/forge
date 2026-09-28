'use strict';

const { describe, expect, test } = require('bun:test');
const fs = require('node:fs');
const path = require('node:path');

const { loadRiskManifest, selectValidation } = require('../../lib/validation/risk-manifest');

const ROOT = path.resolve(__dirname, '../..');
const LOCK_PATH = path.join(ROOT, 'bun.lock');
const RISK_MANIFEST_PATH = path.join(ROOT, 'validation', 'risk-manifest.v1.json');
const rootPackage = require('../../package.json');

const BLOCKS = [
  ['lib/contracts', '@forge/contracts'],
  ['lib/memory-core', '@forge/memory'],
  ['lib/flow', '@forge/flow'],
];

describe('root package integration of the internal building blocks', () => {
  test('ships contracts, memory and flow as lib/ modules of the one forge package', () => {
    expect(rootPackage.files).toContain('lib/');
    const lock = fs.readFileSync(LOCK_PATH, 'utf8');
    for (const [directory, formerName] of BLOCKS) {
      expect(fs.existsSync(path.join(ROOT, directory, 'index.js'))).toBe(true);
      // An internal module, not a package: no manifest of its own.
      expect(fs.existsSync(path.join(ROOT, directory, 'package.json'))).toBe(false);
      expect(rootPackage.files.filter((entry) => entry.startsWith(`!${directory}`))).toEqual([]);
      for (const field of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
        expect(Object.keys(rootPackage[field] || {})).not.toContain(formerName);
      }
      expect(lock).not.toContain(`"${formerName}"`);
    }
    expect(rootPackage.bundledDependencies).toBeUndefined();
    expect(rootPackage.bundleDependencies).toBeUndefined();
    expect(rootPackage.workspaces).toEqual(['packages/skills']);
  });

  test.each([
    {
      path: 'lib/contracts/src/validate.js', owner: 'contracts',
      product: 'memory', lane: 'contract-baseline', route: 'flow-memory-contract',
      command: 'validation.command.contract-baseline', testPath: 'test/contracts',
    },
    {
      path: 'lib/memory-core/src/backend-registry.js', owner: 'memory-foundation',
      product: 'memory', lane: 'memory-package', route: 'memory-contract',
      command: 'validation.command.memory-package', testPath: 'test/memory-core',
    },
    {
      path: 'lib/flow/index.js', owner: 'workflow-runtime',
      product: 'flow', lane: 'flow-package', route: 'flow-memory-contract',
      command: 'validation.command.flow-package', testPath: 'test/flow',
    },
  ])('$path selects its product lane without repository fallback', (expected) => {
    const manifest = loadRiskManifest(RISK_MANIFEST_PATH);
    const selected = selectValidation({
      manifest,
      changedSurfaces: [{ kind: 'path', value: expected.path }],
    });

    expect(selected.status).toBe('exact');
    expect(selected.targeted_pass_allowed).toBe(true);
    expect(selected.owner_ids).toEqual([expected.owner]);
    expect(selected.owner_selections[0].product).toBe(expected.product);
    expect(selected.lanes).toEqual([expected.lane]);
    expect(selected.dependent_routes).toEqual([expected.route]);
    expect(selected.commands.find((command) => command.id === expected.command)?.argv)
      .toContain(expected.testPath);
  });
});
