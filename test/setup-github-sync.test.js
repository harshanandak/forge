const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { describe, test, expect, beforeEach, afterEach } = require('bun:test');
const { scaffoldGithubBeadsSync } = require('../lib/setup');

describe('GitHub-Beads sync setup integration', () => {
  let tmpDir;

  beforeEach(async () => {
    tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'forge-sync-test-'));
  });

  afterEach(async () => {
    await fs.promises.rm(tmpDir, { recursive: true, force: true });
  });

  describe('scaffoldGithubBeadsSync', () => {
    test('creates expected files when enabled', async () => {
      const packageDir = path.join(__dirname, '..');

      await scaffoldGithubBeadsSync(tmpDir, packageDir);

      // Phase 1 workflow
      expect(fs.existsSync(path.join(tmpDir, '.github', 'workflows', 'github-to-beads.yml'))).toBe(true);

      // Phase 2 workflow
      expect(fs.existsSync(path.join(tmpDir, '.github', 'workflows', 'beads-to-github.yml'))).toBe(true);

      // Config file
      expect(fs.existsSync(path.join(tmpDir, 'scripts', 'github-beads-sync.config.json'))).toBe(true);

      // Mapping file
      const mappingPath = path.join(tmpDir, '.github', 'beads-mapping.json');
      expect(fs.existsSync(mappingPath)).toBe(true);
      expect(JSON.parse(fs.readFileSync(mappingPath, 'utf-8'))).toEqual({});

      // Sync script modules (spot-check key files)
      expect(fs.existsSync(path.join(tmpDir, 'scripts', 'github-beads-sync', 'index.mjs'))).toBe(true);
      expect(fs.existsSync(path.join(tmpDir, 'scripts', 'github-beads-sync', 'reverse-sync-cli.mjs'))).toBe(true);
    });

    test('does not overwrite existing config files', async () => {
      const packageDir = path.join(__dirname, '..');

      // Pre-create config with custom content
      const scriptsDir = path.join(tmpDir, 'scripts');
      await fs.promises.mkdir(scriptsDir, { recursive: true });
      const configPath = path.join(scriptsDir, 'github-beads-sync.config.json');
      const customConfig = '{"custom": true}';
      await fs.promises.writeFile(configPath, customConfig, 'utf-8');

      // Pre-create mapping with custom content
      const githubDir = path.join(tmpDir, '.github');
      await fs.promises.mkdir(githubDir, { recursive: true });
      const mappingPath = path.join(githubDir, 'beads-mapping.json');
      const customMapping = '{"issue-1": "beads-1"}';
      await fs.promises.writeFile(mappingPath, customMapping, 'utf-8');

      await scaffoldGithubBeadsSync(tmpDir, packageDir);

      // Config should retain custom content
      const configContent = fs.readFileSync(configPath, 'utf-8');
      expect(configContent).toBe(customConfig);

      // Mapping should retain custom content
      const mappingContent = fs.readFileSync(mappingPath, 'utf-8');
      expect(mappingContent).toBe(customMapping);
    });

    test('creates directories as needed', async () => {
      const packageDir = path.join(__dirname, '..');

      await scaffoldGithubBeadsSync(tmpDir, packageDir);

      expect(fs.existsSync(path.join(tmpDir, '.github', 'workflows'))).toBe(true);
      expect(fs.existsSync(path.join(tmpDir, 'scripts'))).toBe(true);
    });

    test('returns list of created files', async () => {
      const packageDir = path.join(__dirname, '..');

      const result = await scaffoldGithubBeadsSync(tmpDir, packageDir);

      expect(result.created.length).toBeGreaterThan(0);
      expect(result.skipped.length).toBe(0);
    });

    test('returns skipped files when they already exist', async () => {
      const packageDir = path.join(__dirname, '..');

      // Pre-create all files
      const dirs = [
        path.join(tmpDir, '.github', 'workflows'),
        path.join(tmpDir, 'scripts'),
      ];
      for (const dir of dirs) {
        await fs.promises.mkdir(dir, { recursive: true });
      }
      // Pre-create all expected files
      await fs.promises.writeFile(
        path.join(tmpDir, '.github', 'workflows', 'github-to-beads.yml'), 'existing', 'utf-8'
      );
      await fs.promises.writeFile(
        path.join(tmpDir, '.github', 'workflows', 'beads-to-github.yml'), 'existing', 'utf-8'
      );
      await fs.promises.writeFile(
        path.join(tmpDir, 'scripts', 'github-beads-sync.config.json'), '{}', 'utf-8'
      );
      await fs.promises.writeFile(
        path.join(tmpDir, '.github', 'beads-mapping.json'), '{}', 'utf-8'
      );
      // Pre-create script modules
      const syncDir = path.join(tmpDir, 'scripts', 'github-beads-sync');
      await fs.promises.mkdir(syncDir, { recursive: true });
      const scriptNames = [
        'config.mjs', 'mapping.mjs', 'comment.mjs', 'github-api.mjs',
        'sanitize.mjs', 'run-bd.mjs', 'label-mapper.mjs', 'index.mjs',
        'reverse-sync.mjs', 'reverse-sync-cli.mjs',
      ];
      for (const name of scriptNames) {
        await fs.promises.writeFile(path.join(syncDir, name), 'existing', 'utf-8');
      }

      const result = await scaffoldGithubBeadsSync(tmpDir, packageDir);

      expect(result.created.length).toBe(0);
      expect(result.skipped.length).toBe(14);
    });
  });

  describe('forge.js integration', () => {
    const forgePath = path.join(__dirname, '..', 'bin', 'forge.js');
    const content = fs.readFileSync(forgePath, 'utf-8');

    test('--quick mode skips sync setup (no prompt)', () => {
      // quickSetup should NOT prompt for sync — it only runs sync when --sync flag is set
      const quickStart = content.indexOf('async function quickSetup');
      const quickEnd = content.indexOf('\nasync function ', quickStart + 1);
      const quickSection = content.substring(quickStart, quickEnd > quickStart ? quickEnd : quickStart + 3000);
      // Quick mode should not contain the interactive sync prompt
      expect(quickSection).not.toContain('Beads issue sync');
      expect(quickSection).not.toContain('scaffoldGithubBeadsSync');
    });

    test('configureExternalServices includes sync prompt', () => {
      // The external services config should reference the sync setup
      expect(content).toContain('GitHub');
      expect(content).toContain('Beads issue sync');
      expect(content).toContain('scaffoldGithubBeadsSync');
    });
  });
});
