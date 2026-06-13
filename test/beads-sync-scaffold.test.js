const { describe, test, expect } = require('bun:test');
const path = require('path');
const fs = require('fs');
const os = require('os');

const { scaffoldBeadsSync } = require('../lib/beads-sync-scaffold');

function createTmpProject() {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'beads-sync-scaffold-'));
  return {
    projectRoot,
    cleanup: () => fs.rmSync(projectRoot, { recursive: true, force: true })
  };
}

describe('scaffoldBeadsSync', () => {
  test('is a deprecated no-op for new installs', () => {
    const { projectRoot, cleanup } = createTmpProject();
    try {
      const result = scaffoldBeadsSync(projectRoot, __dirname);

      expect(result).toMatchObject({
        filesCreated: [],
        filesSkipped: [],
        filesRemoved: [],
        deprecated: true,
      });
      expect(result.message).toContain('Forge Kernel/server authority');
      expect(fs.existsSync(path.join(projectRoot, '.github', 'workflows', 'github-to-beads.yml'))).toBe(false);
    } finally {
      cleanup();
    }
  });

  test('removes deprecated generated sync files from existing installs', () => {
    const { projectRoot, cleanup } = createTmpProject();
    try {
      const oldFiles = [
        '.github/workflows/github-to-beads.yml',
        '.github/workflows/beads-to-github.yml',
        '.github/beads-mapping.json',
        'scripts/github-beads-sync.config.json',
        'scripts/github-beads-sync/index.mjs',
        'scripts/github-beads-sync/reverse-sync-cli.mjs',
      ];
      for (const file of oldFiles) {
        const fullPath = path.join(projectRoot, file);
        fs.mkdirSync(path.dirname(fullPath), { recursive: true });
        fs.writeFileSync(fullPath, 'old sync file');
      }

      const result = scaffoldBeadsSync(projectRoot, __dirname);

      for (const file of oldFiles) {
        expect(fs.existsSync(path.join(projectRoot, file))).toBe(false);
        expect(result.filesRemoved).toContain(file);
      }
    } finally {
      cleanup();
    }
  });

  test('preserves unrelated workflow files', () => {
    const { projectRoot, cleanup } = createTmpProject();
    try {
      const unrelated = path.join(projectRoot, '.github', 'workflows', 'test.yml');
      fs.mkdirSync(path.dirname(unrelated), { recursive: true });
      fs.writeFileSync(unrelated, 'name: test\n');

      scaffoldBeadsSync(projectRoot, __dirname);

      expect(fs.readFileSync(unrelated, 'utf8')).toBe('name: test\n');
    } finally {
      cleanup();
    }
  });
});
