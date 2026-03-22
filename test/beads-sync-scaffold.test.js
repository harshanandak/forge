const { describe, test, expect } = require('bun:test');
const path = require('path');
const fs = require('fs');
const os = require('os');

const { scaffoldBeadsSync } = require('../lib/beads-sync-scaffold');

/**
 * Helper: create a fake packageDir that mimics the forge package's layout.
 * Contains the source workflow templates and sync scripts that scaffolding copies.
 *
 * @param {string} baseDir - Temp directory to create the fake package inside
 * @returns {string} Path to the fake package root
 */
function createFakePackageDir(baseDir) {
  const pkgDir = path.join(baseDir, 'fake-package');

  // .github/workflows/ — workflow templates
  const workflowsDir = path.join(pkgDir, '.github', 'workflows');
  fs.mkdirSync(workflowsDir, { recursive: true });
  fs.writeFileSync(
    path.join(workflowsDir, 'github-to-beads.yml'),
    '# github-to-beads workflow\non: issues\n'
  );
  fs.writeFileSync(
    path.join(workflowsDir, 'beads-to-github.yml'),
    '# beads-to-github workflow\non: push\n'
  );

  // scripts/github-beads-sync/ — sync modules
  const syncDir = path.join(pkgDir, 'scripts', 'github-beads-sync');
  fs.mkdirSync(syncDir, { recursive: true });
  fs.writeFileSync(path.join(syncDir, 'index.mjs'), '// index module\n');
  fs.writeFileSync(path.join(syncDir, 'config.mjs'), '// config module\n');
  fs.writeFileSync(path.join(syncDir, 'mapping.mjs'), '// mapping module\n');

  // scripts/github-beads-sync.config.json — default config
  fs.writeFileSync(
    path.join(pkgDir, 'scripts', 'github-beads-sync.config.json'),
    JSON.stringify({ defaultType: 'task', defaultPriority: 2 }, null, 2) + '\n'
  );

  return pkgDir;
}

/**
 * Helper: create a fresh temp directory for a test project.
 * @returns {{ projectRoot: string, cleanup: () => void }}
 */
function createTmpProject() {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'beads-sync-scaffold-'));
  return {
    projectRoot,
    cleanup: () => fs.rmSync(projectRoot, { recursive: true, force: true })
  };
}

describe('scaffoldBeadsSync', () => {
  /** @type {string} */
  let tmpBase;
  /** @type {string} */
  let packageDir;

  // Create a shared fake package dir for all tests
  tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'beads-sync-pkg-'));
  packageDir = createFakePackageDir(tmpBase);

  test('creates all expected files in .github/', () => {
    const { projectRoot, cleanup } = createTmpProject();
    try {
      const result = scaffoldBeadsSync(projectRoot, packageDir);

      // Workflow files
      expect(fs.existsSync(path.join(projectRoot, '.github', 'workflows', 'github-to-beads.yml'))).toBe(true);
      expect(fs.existsSync(path.join(projectRoot, '.github', 'workflows', 'beads-to-github.yml'))).toBe(true);

      // Sync scripts
      expect(fs.existsSync(path.join(projectRoot, '.github', 'scripts', 'beads-sync', 'index.mjs'))).toBe(true);
      expect(fs.existsSync(path.join(projectRoot, '.github', 'scripts', 'beads-sync', 'config.mjs'))).toBe(true);
      expect(fs.existsSync(path.join(projectRoot, '.github', 'scripts', 'beads-sync', 'mapping.mjs'))).toBe(true);

      // Config and mapping
      expect(fs.existsSync(path.join(projectRoot, '.github', 'beads-sync-config.json'))).toBe(true);
      expect(fs.existsSync(path.join(projectRoot, '.github', 'beads-mapping.json'))).toBe(true);

      // Result should list created files
      expect(result.filesCreated.length).toBeGreaterThanOrEqual(7);
      expect(result.filesSkipped).toEqual([]);
    } finally {
      cleanup();
    }
  });

  test('workflow files are copied from package source with correct content', () => {
    const { projectRoot, cleanup } = createTmpProject();
    try {
      scaffoldBeadsSync(projectRoot, packageDir);

      const ghToBeads = fs.readFileSync(
        path.join(projectRoot, '.github', 'workflows', 'github-to-beads.yml'), 'utf8'
      );
      expect(ghToBeads).toContain('github-to-beads workflow');

      const beadsToGh = fs.readFileSync(
        path.join(projectRoot, '.github', 'workflows', 'beads-to-github.yml'), 'utf8'
      );
      expect(beadsToGh).toContain('beads-to-github workflow');
    } finally {
      cleanup();
    }
  });

  test('existing .github/beads-mapping.json is preserved (not overwritten)', () => {
    const { projectRoot, cleanup } = createTmpProject();
    try {
      // Pre-create the mapping file with existing content
      const githubDir = path.join(projectRoot, '.github');
      fs.mkdirSync(githubDir, { recursive: true });
      const existingContent = JSON.stringify({ 'issue-1': 'beads-001' });
      fs.writeFileSync(path.join(githubDir, 'beads-mapping.json'), existingContent);

      const result = scaffoldBeadsSync(projectRoot, packageDir);

      // Should NOT overwrite the existing mapping
      const content = fs.readFileSync(
        path.join(projectRoot, '.github', 'beads-mapping.json'), 'utf8'
      );
      expect(content).toBe(existingContent);

      // The mapping file should appear in filesSkipped, not filesCreated
      const mappingRelPath = '.github/beads-mapping.json';
      expect(result.filesSkipped).toContain(mappingRelPath);
      expect(result.filesCreated).not.toContain(mappingRelPath);
    } finally {
      cleanup();
    }
  });

  test('sync config created at .github/beads-sync-config.json with correct content', () => {
    const { projectRoot, cleanup } = createTmpProject();
    try {
      scaffoldBeadsSync(projectRoot, packageDir);

      const configPath = path.join(projectRoot, '.github', 'beads-sync-config.json');
      expect(fs.existsSync(configPath)).toBe(true);

      const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      expect(config.defaultType).toBe('task');
      expect(config.defaultPriority).toBe(2);
    } finally {
      cleanup();
    }
  });

  test('returns filesCreated and filesSkipped arrays', () => {
    const { projectRoot, cleanup } = createTmpProject();
    try {
      const result = scaffoldBeadsSync(projectRoot, packageDir);

      expect(Array.isArray(result.filesCreated)).toBe(true);
      expect(Array.isArray(result.filesSkipped)).toBe(true);

      // All created files should be relative paths
      for (const f of result.filesCreated) {
        expect(f.startsWith('.')).toBe(true); // .github/...
        expect(path.isAbsolute(f)).toBe(false);
      }
    } finally {
      cleanup();
    }
  });

  test('existing workflow files are skipped (idempotent re-runs)', () => {
    const { projectRoot, cleanup } = createTmpProject();
    try {
      // Pre-create a customised workflow
      const wfDir = path.join(projectRoot, '.github', 'workflows');
      fs.mkdirSync(wfDir, { recursive: true });
      fs.writeFileSync(path.join(wfDir, 'github-to-beads.yml'), '# user customised\n');

      const result = scaffoldBeadsSync(projectRoot, packageDir);

      // Should preserve user content (not overwrite)
      const content = fs.readFileSync(
        path.join(projectRoot, '.github', 'workflows', 'github-to-beads.yml'), 'utf8'
      );
      expect(content).toContain('user customised');

      // Should be in filesSkipped (not filesCreated)
      expect(result.filesSkipped).toContain('.github/workflows/github-to-beads.yml');
      expect(result.filesCreated).not.toContain('.github/workflows/github-to-beads.yml');
    } finally {
      cleanup();
    }
  });

  test('handles missing source sync scripts directory gracefully', () => {
    const { projectRoot, cleanup } = createTmpProject();
    try {
      // Create a minimal packageDir without sync scripts
      const minimalPkg = fs.mkdtempSync(path.join(os.tmpdir(), 'beads-sync-minimal-'));
      const wfDir = path.join(minimalPkg, '.github', 'workflows');
      fs.mkdirSync(wfDir, { recursive: true });
      fs.writeFileSync(path.join(wfDir, 'github-to-beads.yml'), '# wf\n');
      fs.writeFileSync(path.join(wfDir, 'beads-to-github.yml'), '# wf\n');
      // No scripts/github-beads-sync/ and no config.json

      // Should not throw — just skip what's missing
      const result = scaffoldBeadsSync(projectRoot, minimalPkg);

      expect(result.filesCreated.length).toBeGreaterThanOrEqual(1);
      // Mapping should still be created
      expect(fs.existsSync(path.join(projectRoot, '.github', 'beads-mapping.json'))).toBe(true);

      fs.rmSync(minimalPkg, { recursive: true, force: true });
    } finally {
      cleanup();
    }
  });
});
