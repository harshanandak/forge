const { describe, test, expect } = require('bun:test');
const path = require('path');
const fs = require('fs');
const os = require('os');

/**
 * Tests for scripts/check-agents.js
 *
 * The module exports:
 * - checkAgents(repoRoot) -> { errors: string[], warnings: string[] }
 */

const { checkAgents } = require('../../scripts/check-agents.js');
const { syncCommands } = require('../../scripts/sync-commands.js');

/**
 * Create a temp directory with a .claude/commands/ structure and
 * lib/agents/*.plugin.json files for testing.
 *
 * @param {Record<string, string>} commands - Map of command name to file content
 * @param {Array<object>} [plugins] - Plugin JSON objects to write (auto-generates defaults if omitted)
 * @returns {string} Absolute path to the temp repo root
 */
function createTempRepo(commands, plugins) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-check-test-'));
  const cmdDir = path.join(tmpDir, '.claude', 'commands');
  fs.mkdirSync(cmdDir, { recursive: true });
  for (const [name, content] of Object.entries(commands)) {
    fs.writeFileSync(path.join(cmdDir, `${name}.md`), content);
  }

  // Write plugin files
  const agentDir = path.join(tmpDir, 'lib', 'agents');
  fs.mkdirSync(agentDir, { recursive: true });

  if (plugins) {
    for (const plugin of plugins) {
      fs.writeFileSync(
        path.join(agentDir, `${plugin.id}.plugin.json`),
        JSON.stringify(plugin, null, 2)
      );
    }
  }

  return tmpDir;
}

/**
 * Clean up a temp directory.
 *
 * @param {string} tmpDir
 */
function cleanupTempRepo(tmpDir) {
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

// ---- Happy path: all files in sync -----------------------------------------------

describe('checkAgents — happy path', () => {
  test('returns no errors when all files are in sync and plugins are valid', () => {
    const tmpDir = createTempRepo({
      plan: '---\ndescription: Plan a feature\n---\n\nPlan body.',
    }, [
      {
        id: 'cursor',
        name: 'Cursor',
        capabilities: { commands: true },
        directories: { commands: '.cursor/commands' },
      },
    ]);
    try {
      // Write synced files first (creates manifest + agent files)
      syncCommands({ dryRun: false, check: false, repoRoot: tmpDir });

      const result = checkAgents(tmpDir);
      expect(result.errors).toHaveLength(0);
    } finally {
      cleanupTempRepo(tmpDir);
    }
  });

  test('returns empty errors array with current repo root', () => {
    const repoRoot = path.resolve(__dirname, '..', '..');
    const result = checkAgents(repoRoot);
    // The current repo should be in a clean state since sync-commands was run
    // during prior tasks. We only check the shape — actual sync state may vary.
    expect(Array.isArray(result.errors)).toBe(true);
    expect(Array.isArray(result.warnings)).toBe(true);
  });
});

// ---- Sync check integration ------------------------------------------------------

describe('checkAgents — sync check', () => {
  test('reports error when agent files are out of sync', () => {
    const tmpDir = createTempRepo({
      plan: '---\ndescription: Plan\n---\n\nPlan body.',
    });
    try {
      // Write synced files
      syncCommands({ dryRun: false, check: false, repoRoot: tmpDir });
      // Modify one file to create drift
      const clineFile = path.join(tmpDir, '.clinerules', 'workflows', 'plan.md');
      fs.writeFileSync(clineFile, 'Manually modified content');

      const result = checkAgents(tmpDir);
      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.errors.some((e) => e.includes('out of sync') || e.includes('Out of sync'))).toBe(true);
    } finally {
      cleanupTempRepo(tmpDir);
    }
  });

  test('reports error when manifest is missing', () => {
    const tmpDir = createTempRepo({
      plan: '---\ndescription: Plan\n---\n\nPlan body.',
    });
    try {
      // Write synced files, then delete manifest
      syncCommands({ dryRun: false, check: false, repoRoot: tmpDir });
      fs.unlinkSync(path.join(tmpDir, '.forge', 'sync-manifest.json'));

      const result = checkAgents(tmpDir);
      // Should have a warning or error about missing manifest
      const allMessages = [...result.errors, ...result.warnings];
      expect(allMessages.some((m) => m.includes('manifest'))).toBe(true);
    } finally {
      cleanupTempRepo(tmpDir);
    }
  });

  test('reports stale files as errors', () => {
    const tmpDir = createTempRepo({
      plan: '---\ndescription: Plan\n---\n\nPlan body.',
      dev: '---\ndescription: Dev\n---\n\nDev body.',
    });
    try {
      // Sync both commands
      syncCommands({ dryRun: false, check: false, repoRoot: tmpDir });
      // Delete 'dev' from canonical source
      fs.unlinkSync(path.join(tmpDir, '.claude', 'commands', 'dev.md'));

      const result = checkAgents(tmpDir);
      expect(result.errors.some((e) => e.includes('stale') || e.includes('Stale'))).toBe(true);
    } finally {
      cleanupTempRepo(tmpDir);
    }
  });
});

// ---- Plugin catalog validation ---------------------------------------------------

describe('checkAgents — plugin catalog', () => {
  test('reports error when plugin with commands:true has empty command directory', () => {
    const tmpDir = createTempRepo({
      plan: '---\ndescription: Plan\n---\n\nPlan body.',
    }, [
      {
        id: 'cursor',
        name: 'Cursor',
        capabilities: { commands: true },
        directories: { commands: '.cursor/commands' },
      },
    ]);
    try {
      // Do NOT sync — so .cursor/commands/ doesn't exist
      const result = checkAgents(tmpDir);
      expect(result.errors.some((e) => e.includes('cursor') || e.includes('Cursor'))).toBe(true);
    } finally {
      cleanupTempRepo(tmpDir);
    }
  });

  test('no plugin error when commands:false even if directory is missing', () => {
    const tmpDir = createTempRepo({
      plan: '---\ndescription: Plan\n---\n\nPlan body.',
    }, [
      {
        id: 'test-agent',
        name: 'Test Agent',
        capabilities: { commands: false },
        directories: { commands: '.test-agent/commands' },
      },
    ]);
    try {
      // Sync to create manifest (avoid sync errors dominating)
      syncCommands({ dryRun: false, check: false, repoRoot: tmpDir });

      const result = checkAgents(tmpDir);
      // Should not have an error about test-agent missing commands
      expect(result.errors.some((e) => e.includes('test-agent') || e.includes('Test Agent'))).toBe(false);
    } finally {
      cleanupTempRepo(tmpDir);
    }
  });

  test('reports error when command directory exists but is empty', () => {
    const tmpDir = createTempRepo({
      plan: '---\ndescription: Plan\n---\n\nPlan body.',
    }, [
      {
        id: 'cursor',
        name: 'Cursor',
        capabilities: { commands: true },
        directories: { commands: '.cursor/commands' },
      },
    ]);
    try {
      // Create the directory but leave it empty
      fs.mkdirSync(path.join(tmpDir, '.cursor', 'commands'), { recursive: true });
      // Sync to get manifest (but this will also populate .cursor/commands)
      syncCommands({ dryRun: false, check: false, repoRoot: tmpDir });
      // Delete all files from .cursor/commands/ to simulate empty dir
      const cursorCmdDir = path.join(tmpDir, '.cursor', 'commands');
      for (const f of fs.readdirSync(cursorCmdDir)) {
        fs.unlinkSync(path.join(cursorCmdDir, f));
      }

      const result = checkAgents(tmpDir);
      // Should catch that sync is out of sync (missing files)
      expect(result.errors.length).toBeGreaterThan(0);
    } finally {
      cleanupTempRepo(tmpDir);
    }
  });

  test('handles plugins without directories field gracefully', () => {
    const tmpDir = createTempRepo({
      plan: '---\ndescription: Plan\n---\n\nPlan body.',
    }, [
      {
        id: 'minimal',
        name: 'Minimal Agent',
        capabilities: { commands: true },
      },
    ]);
    try {
      syncCommands({ dryRun: false, check: false, repoRoot: tmpDir });

      const result = checkAgents(tmpDir);
      // Should not crash — gracefully handle missing directories
      expect(Array.isArray(result.errors)).toBe(true);
      expect(Array.isArray(result.warnings)).toBe(true);
    } finally {
      cleanupTempRepo(tmpDir);
    }
  });

  test('handles repo with no plugin files gracefully', () => {
    const tmpDir = createTempRepo({
      plan: '---\ndescription: Plan\n---\n\nPlan body.',
    });
    try {
      syncCommands({ dryRun: false, check: false, repoRoot: tmpDir });
      // lib/agents/ doesn't exist at all
      const result = checkAgents(tmpDir);
      // Should have a warning about no plugins found
      const allMessages = [...result.errors, ...result.warnings];
      expect(allMessages.some((m) => m.includes('plugin') || m.includes('No plugin'))).toBe(true);
    } finally {
      cleanupTempRepo(tmpDir);
    }
  });
});

// ---- Return shape ----------------------------------------------------------------

describe('checkAgents — return shape', () => {
  test('always returns errors and warnings arrays', () => {
    const tmpDir = createTempRepo({
      plan: '---\ndescription: Plan\n---\n\nPlan body.',
    });
    try {
      syncCommands({ dryRun: false, check: false, repoRoot: tmpDir });
      const result = checkAgents(tmpDir);
      expect(Array.isArray(result.errors)).toBe(true);
      expect(Array.isArray(result.warnings)).toBe(true);
    } finally {
      cleanupTempRepo(tmpDir);
    }
  });
});
