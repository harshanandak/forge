const fs = require('node:fs');
const path = require('node:path');
const { describe, test, expect } = require('bun:test');

const ROOT = path.resolve(__dirname, '..');

/**
 * Modules deleted when the live Beads surfaces were retired (Slice D).
 * Requiring any of them must fail — they have no replacement.
 */
const DELETED_MODULES = [
  '../lib/beads-setup',
  '../lib/beads-sync-scaffold',
  '../lib/pat-setup',
];

/**
 * The ONLY runtime modules allowed to require a beads-named module.
 *
 * Beads survives exclusively as an inbound migration path
 * (`forge migrate --from beads`), the upgrade-time advisory that detects stale
 * Beads artifacts, and the kernel's JSONL projection compat writer. Every
 * entry is named individually — a directory-wide exemption would let any new
 * module under it reintroduce a live Beads surface without failing this test.
 */
const ALLOWED_IMPORTERS = new Set([
  'lib/commands/migrate.js',
  'lib/upgrade-safety.js',
  'lib/kernel/projection-jsonl-writer.js',
]);

const BEADS_REQUIRE = /require\(\s*['"]([^'"]*beads[^'"]*)['"]\s*\)/g;

function collectJsFiles(dir, acc = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      collectJsFiles(full, acc);
    } else if (entry.name.endsWith('.js')) {
      acc.push(full);
    }
  }
  return acc;
}

function toRepoPath(absolute) {
  return path.relative(ROOT, absolute).split(path.sep).join('/');
}

function isAllowedImporter(repoPath) {
  return ALLOWED_IMPORTERS.has(repoPath);
}

describe('beads isolation', () => {
  test.each(DELETED_MODULES)('%s no longer exists', modulePath => {
    // require.resolve, not require: a restored module that throws its own
    // "Cannot find module" would otherwise satisfy this assertion.
    expect(() => require.resolve(modulePath)).toThrow(/Cannot find module/);
  });

  test('no runtime module outside the migration path requires a beads module', () => {
    const files = [
      ...collectJsFiles(path.join(ROOT, 'lib')),
      ...collectJsFiles(path.join(ROOT, 'bin')),
    ];

    const violations = [];
    for (const file of files) {
      const repoPath = toRepoPath(file);
      if (isAllowedImporter(repoPath)) continue;

      const source = fs.readFileSync(file, 'utf8');
      for (const match of source.matchAll(BEADS_REQUIRE)) {
        violations.push(`${repoPath} requires ${match[1]}`);
      }
    }

    expect(violations).toEqual([]);
  });

  test('the deleted sync scaffold scripts are gone', () => {
    const removed = [
      'scripts/github-beads-sync',
      'scripts/github-beads-sync.config.json',
      'scripts/beads-context.sh',
      'scripts/beads-migrate-to-dolt.sh',
      'scripts/lib/beads-migrate-to-dolt.mjs',
      'scripts/beads-upgrade-smoke.sh',
    ];

    const survivors = removed.filter(rel => fs.existsSync(path.join(ROOT, rel)));
    expect(survivors).toEqual([]);
  });

  test('detectDefaultBranch lives in a beads-free module', () => {
    const { detectDefaultBranch } = require('../lib/git-defaults');
    expect(typeof detectDefaultBranch).toBe('function');
  });
});
