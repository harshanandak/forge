'use strict';

const { describe, expect, test } = require('bun:test');
const fs = require('node:fs');
const path = require('node:path');

const { loadRiskManifest, selectValidation } = require('../../lib/validation/risk-manifest');

const ROOT = path.resolve(__dirname, '../..');
const LOCK_PATH = path.join(ROOT, 'bun.lock');
const RISK_MANIFEST_PATH = path.join(ROOT, 'validation', 'risk-manifest.v1.json');
const rootPackage = require('../../package.json');

function workspaceBlock(lock, workspacePath) {
  const marker = `    "${workspacePath}": {`;
  const start = lock.indexOf(marker);
  if (start === -1) throw new Error(`bun.lock is missing workspace ${workspacePath}`);
  const end = lock.indexOf('\n    },', start);
  if (end === -1) throw new Error(`bun.lock workspace ${workspacePath} is malformed`);
  return lock.slice(start, end);
}

describe('PR2 root package integration', () => {
  test('resolves all three prerelease packages through the existing workspace contract', () => {
    expect(rootPackage.version).toBe('0.1.0-beta.7');
    expect(rootPackage.workspaces).toContain('packages/*');

    const lock = fs.readFileSync(LOCK_PATH, 'utf8');
    const expected = [
      ['packages/contracts', '@forge/contracts'],
      ['packages/memory', '@forge/memory'],
      ['packages/flow', '@forge/flow'],
    ];
    for (const [workspacePath, packageName] of expected) {
      const block = workspaceBlock(lock, workspacePath);
      expect(block).toContain(`"name": "${packageName}"`);
      expect(block).toContain('"version": "0.1.0-beta.6"');

      const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, workspacePath, 'package.json'), 'utf8'));
      expect(manifest.license).toBe('MIT');
      expect(manifest.repository).toEqual({
        type: 'git',
        url: 'git+https://github.com/harshanandak/forge.git',
        directory: workspacePath,
      });
      expect(manifest.homepage).toBe('https://github.com/harshanandak/forge#readme');
      expect(manifest.bugs).toEqual({ url: 'https://github.com/harshanandak/forge/issues' });
      expect(manifest.publishConfig).toEqual({ access: 'public' });
    }

    expect(workspaceBlock(lock, 'packages/flow')).toContain(
      '"@forge/contracts": "0.1.0-beta.6"',
    );
    expect(lock).toContain('"@forge/contracts@workspace:packages/contracts"');
  });

  test.each([
    {
      path: 'packages/contracts/src/validate.js', owner: 'contracts',
      product: 'memory', lane: 'contract-baseline', route: 'flow-memory-contract',
      command: 'validation.command.contract-baseline', testPath: 'packages/contracts',
    },
    {
      path: 'packages/memory/src/backend-registry.js', owner: 'memory-foundation',
      product: 'memory', lane: 'memory-package', route: 'memory-contract',
      command: 'validation.command.memory-package', testPath: 'packages/memory',
    },
    {
      path: 'packages/flow/index.js', owner: 'workflow-runtime',
      product: 'flow', lane: 'flow-package', route: 'flow-memory-contract',
      command: 'validation.command.flow-package', testPath: 'packages/flow',
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
