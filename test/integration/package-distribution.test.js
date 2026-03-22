const { describe, it, expect } = require('bun:test');
const { execSync } = require('child_process');
const path = require('path');

/**
 * Comprehensive integration test for npm package distribution.
 * Verifies that `npm pack --dry-run` includes ALL required files
 * across all 24 install-fixes issues and excludes dev/test artifacts.
 *
 * This extends the basic test/package-distribution.test.js with full
 * coverage of lib modules, agent directories, workflow templates, and
 * sync modules added across the install-fixes feature branch.
 *
 * Uses execSync with a hardcoded command (no user input) — safe from injection.
 */

const ROOT = path.resolve(__dirname, '..', '..');

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

describe('comprehensive package distribution (npm pack --dry-run)', () => {
  const packFiles = getPackFiles();

  it('pack produced a non-empty file list', () => {
    expect(packFiles.length).toBeGreaterThan(0);
  });

  // -- Hook scripts ---------------------------------------------------

  describe('hook scripts in scripts/', () => {
    const requiredHookScripts = [
      'scripts/commitlint.js',
      'scripts/branch-protection.js',
      'scripts/lint.js',
      'scripts/test.js',
    ];

    for (const script of requiredHookScripts) {
      it(`includes ${script}`, () => {
        expect(packFiles).toContain(script);
      });
    }
  });

  // -- Multi-dev scripts ----------------------------------------------

  describe('multi-dev scripts in scripts/', () => {
    const requiredMultiDevScripts = [
      'scripts/sync-utils.sh',
      'scripts/file-index.sh',
      'scripts/conflict-detect.sh',
    ];

    for (const script of requiredMultiDevScripts) {
      it(`includes ${script}`, () => {
        expect(packFiles).toContain(script);
      });
    }
  });

  // -- GitHub-Beads sync modules --------------------------------------

  describe('scripts/github-beads-sync/ modules', () => {
    const requiredSyncModules = [
      'scripts/github-beads-sync/index.mjs',
      'scripts/github-beads-sync/config.mjs',
      'scripts/github-beads-sync/github-api.mjs',
      'scripts/github-beads-sync/comment.mjs',
      'scripts/github-beads-sync/label-mapper.mjs',
      'scripts/github-beads-sync/mapping.mjs',
      'scripts/github-beads-sync/reverse-sync.mjs',
      'scripts/github-beads-sync/reverse-sync-cli.mjs',
      'scripts/github-beads-sync/run-bd.mjs',
      'scripts/github-beads-sync/sanitize.mjs',
    ];

    for (const syncFile of requiredSyncModules) {
      it(`includes ${syncFile}`, () => {
        expect(packFiles).toContain(syncFile);
      });
    }
  });

  // -- Workflow templates ---------------------------------------------

  describe('GitHub workflow templates', () => {
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

  // -- New lib modules (install-fixes feature) ------------------------

  describe('lib/ modules added by install-fixes', () => {
    const requiredLibModules = [
      'lib/setup-utils.js',
      'lib/smart-merge.js',
      'lib/symlink-utils.js',
      'lib/lefthook-check.js',
      'lib/husky-migration.js',
      'lib/beads-setup.js',
      'lib/beads-health-check.js',
      'lib/beads-sync-scaffold.js',
      'lib/pat-setup.js',
    ];

    for (const libFile of requiredLibModules) {
      it(`includes ${libFile}`, () => {
        expect(packFiles).toContain(libFile);
      });
    }
  });

  // -- Core lib modules (pre-existing) --------------------------------

  describe('core lib/ modules', () => {
    const coreLibModules = [
      'lib/setup.js',
      'lib/detect-agent.js',
      'lib/detect-worktree.js',
      'lib/context-merge.js',
      'lib/plugin-catalog.js',
      'lib/plugin-manager.js',
      'lib/plugin-recommender.js',
      'lib/project-discovery.js',
      'lib/agents-config.js',
      'lib/workflow-profiles.js',
      'lib/file-hash.js',
      'lib/setup-action-log.js',
      'lib/setup-summary-renderer.js',
    ];

    for (const libFile of coreLibModules) {
      it(`includes ${libFile}`, () => {
        expect(packFiles).toContain(libFile);
      });
    }
  });

  // -- Agent directories ----------------------------------------------

  describe('agent directories', () => {
    const agentPrefixes = [
      '.claude/',
      '.cursor/',
      '.cline/',
      '.roo/',
      '.codex/',
      '.kilocode/',
      '.opencode/',
    ];

    for (const prefix of agentPrefixes) {
      it(`includes files under ${prefix}`, () => {
        const agentFiles = packFiles.filter((f) => f.startsWith(prefix));
        expect(agentFiles.length).toBeGreaterThan(0);
      });
    }
  });

  // -- Core files -----------------------------------------------------

  describe('core distribution files', () => {
    const coreFiles = [
      'bin/forge.js',
      'bin/forge-preflight.js',
      'install.sh',
      'lefthook.yml',
      'AGENTS.md',
      'CLAUDE.md',
      'package.json',
      'README.md',
      'LICENSE',
    ];

    for (const coreFile of coreFiles) {
      it(`includes ${coreFile}`, () => {
        expect(packFiles).toContain(coreFile);
      });
    }
  });

  // -- .forge hooks ---------------------------------------------------

  describe('.forge/hooks/', () => {
    it('includes .forge/hooks/ files', () => {
      const forgeHookFiles = packFiles.filter((f) =>
        f.startsWith('.forge/hooks/'),
      );
      expect(forgeHookFiles.length).toBeGreaterThan(0);
    });
  });

  // -- GitHub prompts -------------------------------------------------

  describe('.github/prompts/', () => {
    it('includes .github/prompts/ files', () => {
      const promptFiles = packFiles.filter((f) =>
        f.startsWith('.github/prompts/'),
      );
      expect(promptFiles.length).toBeGreaterThan(0);
    });
  });

  // -- Exclusions -----------------------------------------------------

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

    it('does NOT include .beads/issues.jsonl', () => {
      expect(packFiles).not.toContain('.beads/issues.jsonl');
    });

    it('does NOT include any .beads/ files', () => {
      const beadsFiles = packFiles.filter((f) => f.startsWith('.beads/'));
      expect(beadsFiles).toEqual([]);
    });

    it('does NOT include test-env/ directory files', () => {
      const testEnvFiles = packFiles.filter((f) => f.startsWith('test-env/'));
      expect(testEnvFiles).toEqual([]);
    });

    it('does NOT include .git/ directory files', () => {
      const gitFiles = packFiles.filter((f) => f.startsWith('.git/'));
      expect(gitFiles).toEqual([]);
    });
  });

  // -- MCP configuration example --------------------------------------

  describe('MCP configuration example', () => {
    it('includes .mcp.json.example', () => {
      expect(packFiles).toContain('.mcp.json.example');
    });
  });

  // -- docs/ ----------------------------------------------------------

  describe('documentation files', () => {
    it('includes docs/*.md files', () => {
      const docFiles = packFiles.filter((f) =>
        f.startsWith('docs/') && f.endsWith('.md'),
      );
      expect(docFiles.length).toBeGreaterThan(0);
    });
  });

  // -- .kilocode agent (specific check) -------------------------------

  describe('.kilocode/ agent directory', () => {
    it('includes .kilocode/ command files', () => {
      const kiloFiles = packFiles.filter((f) =>
        f.startsWith('.kilocode/'),
      );
      expect(kiloFiles.length).toBeGreaterThan(0);
    });
  });

  // -- scripts/lib/ subdirectory --------------------------------------

  describe('scripts/lib/ evaluation modules', () => {
    it('includes scripts/lib/ files', () => {
      const scriptLibFiles = packFiles.filter((f) =>
        f.startsWith('scripts/lib/'),
      );
      expect(scriptLibFiles.length).toBeGreaterThan(0);
    });
  });

  // -- lib/commands/ subdirectory -------------------------------------

  describe('lib/commands/ modules', () => {
    const requiredCommands = [
      'lib/commands/plan.js',
      'lib/commands/dev.js',
      'lib/commands/validate.js',
      'lib/commands/ship.js',
      'lib/commands/status.js',
    ];

    for (const cmd of requiredCommands) {
      it(`includes ${cmd}`, () => {
        expect(packFiles).toContain(cmd);
      });
    }
  });

  // -- lib/dep-guard/ subdirectory ------------------------------------

  describe('lib/dep-guard/ modules', () => {
    it('includes lib/dep-guard/ files', () => {
      const depGuardFiles = packFiles.filter((f) =>
        f.startsWith('lib/dep-guard/'),
      );
      expect(depGuardFiles.length).toBeGreaterThan(0);
    });
  });

  // -- lib/agents/ plugin definitions ---------------------------------

  describe('lib/agents/ plugin definitions', () => {
    it('includes lib/agents/ plugin JSON files', () => {
      const agentPlugins = packFiles.filter(
        (f) => f.startsWith('lib/agents/') && f.endsWith('.plugin.json'),
      );
      expect(agentPlugins.length).toBeGreaterThan(0);
    });
  });
});
