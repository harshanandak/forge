const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { describe, test, expect, beforeEach, afterEach } = require('bun:test');
const { scaffoldGithubBeadsSync } = require('../lib/setup');

describe('deprecated GitHub-Beads sync setup cleanup', () => {
  let tmpDir;

  beforeEach(async () => {
    tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'forge-sync-test-'));
  });

  afterEach(async () => {
    await fs.promises.rm(tmpDir, { recursive: true, force: true });
  });

  test('does not create sync files for new installs', async () => {
    const result = await scaffoldGithubBeadsSync(tmpDir, path.join(__dirname, '..'));

    expect(result).toMatchObject({
      created: [],
      skipped: [],
      deprecated: true,
    });
    expect(fs.existsSync(path.join(tmpDir, '.github', 'workflows', 'github-to-beads.yml'))).toBe(false);
    expect(fs.existsSync(path.join(tmpDir, '.github', 'workflows', 'beads-to-github.yml'))).toBe(false);
    expect(fs.existsSync(path.join(tmpDir, 'scripts', 'github-beads-sync'))).toBe(false);
  });

  test('removes old generated sync files from existing installs', async () => {
    const oldFiles = [
      '.github/workflows/github-to-beads.yml',
      '.github/workflows/beads-to-github.yml',
      '.github/beads-mapping.json',
      'scripts/github-beads-sync.config.json',
      'scripts/github-beads-sync/index.mjs',
      'scripts/github-beads-sync/reverse-sync-cli.mjs',
    ];
    for (const file of oldFiles) {
      const fullPath = path.join(tmpDir, file);
      await fs.promises.mkdir(path.dirname(fullPath), { recursive: true });
      await fs.promises.writeFile(fullPath, 'old sync file', 'utf8');
    }

    const result = await scaffoldGithubBeadsSync(tmpDir, path.join(__dirname, '..'));

    for (const file of oldFiles) {
      expect(fs.existsSync(path.join(tmpDir, file))).toBe(false);
      expect(result.removed).toContain(file);
    }
  });

  test('does not remove unrelated workflow files', async () => {
    const unrelated = path.join(tmpDir, '.github', 'workflows', 'test.yml');
    await fs.promises.mkdir(path.dirname(unrelated), { recursive: true });
    await fs.promises.writeFile(unrelated, 'name: test\n', 'utf8');

    await scaffoldGithubBeadsSync(tmpDir, path.join(__dirname, '..'));

    expect(fs.readFileSync(unrelated, 'utf8')).toBe('name: test\n');
  });

  describe('forge.js integration', () => {
    const forgePath = path.join(__dirname, '..', 'bin', 'forge.js');
    const content = fs.readFileSync(forgePath, 'utf-8');

    test('--quick mode skips sync setup prompt', () => {
      const quickStart = content.indexOf('async function quickSetup');
      const quickEnd = content.indexOf('\nasync function ', quickStart + 1);
      const quickSection = content.substring(quickStart, quickEnd > quickStart ? quickEnd : quickStart + 3000);

      expect(quickSection).not.toContain('Beads issue sync');
      expect(quickSection).not.toContain('scaffoldGithubBeadsSync');
    });

    test('interactive setup no longer prompts for GitHub-Beads sync', () => {
      expect(content).not.toContain('Enable GitHub');
      expect(content).toContain('GitHub-Beads issue sync setup is deprecated');
    });
  });
});
