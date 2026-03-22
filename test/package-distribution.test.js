const { describe, it, expect } = require('bun:test');
const { execSync } = require('child_process');
const path = require('path');

/**
 * Package distribution tests.
 * Verifies that `npm pack --dry-run` includes all required files
 * and excludes development/test artifacts.
 *
 * Uses execSync with a hardcoded command (no user input) — safe from injection.
 */

const ROOT = path.resolve(__dirname, '..');

/**
 * Run npm pack --dry-run and return the list of files that would be included.
 * @returns {string[]} Array of relative file paths in the tarball
 */
function getPackFiles() {
  // Hardcoded command, no user input — safe from injection
  const output = execSync('npm pack --dry-run 2>&1', {
    cwd: ROOT,
    encoding: 'utf-8',
  });
  // npm pack --dry-run outputs lines like:
  //   npm notice 1.2kB  bin/forge.js
  // We extract file paths from lines that have size + path
  const lines = output.split('\n');
  const files = [];
  for (const line of lines) {
    const match = line.match(/npm notice\s+[\d.]+\s*[kKmMgG]?B\s+(.+)/);
    if (match) {
      files.push(match[1].trim());
    }
  }
  return files;
}

describe('package distribution (npm pack --dry-run)', () => {
  const packFiles = getPackFiles();

  describe('scripts/ directory — hook scripts', () => {
    const requiredScripts = [
      'scripts/commitlint.js',
      'scripts/branch-protection.js',
      'scripts/lint.js',
      'scripts/test.js',
      'scripts/sync-utils.sh',
      'scripts/file-index.sh',
      'scripts/conflict-detect.sh',
    ];

    for (const script of requiredScripts) {
      it(`includes ${script}`, () => {
        expect(packFiles).toContain(script);
      });
    }
  });

  describe('scripts/github-beads-sync/ — sync modules', () => {
    const requiredSyncFiles = [
      'scripts/github-beads-sync/index.mjs',
      'scripts/github-beads-sync/config.mjs',
    ];

    for (const syncFile of requiredSyncFiles) {
      it(`includes ${syncFile}`, () => {
        expect(packFiles).toContain(syncFile);
      });
    }
  });

  describe('.github/workflows/ — Beads sync workflow templates', () => {
    const requiredWorkflows = [
      '.github/workflows/github-to-beads.yml',
      '.github/workflows/beads-to-github.yml',
    ];

    for (const workflow of requiredWorkflows) {
      it(`includes ${workflow}`, () => {
        expect(packFiles).toContain(workflow);
      });
    }
  });

  describe('excludes development/test artifacts', () => {
    it('does NOT include test/ directory files', () => {
      const testFiles = packFiles.filter((f) => f.startsWith('test/'));
      expect(testFiles).toEqual([]);
    });

    it('does NOT include .worktrees/ directory files', () => {
      const worktreeFiles = packFiles.filter((f) =>
        f.startsWith('.worktrees/'),
      );
      expect(worktreeFiles).toEqual([]);
    });

    it('does NOT include node_modules/ directory files', () => {
      const nmFiles = packFiles.filter((f) => f.startsWith('node_modules/'));
      expect(nmFiles).toEqual([]);
    });
  });
});
