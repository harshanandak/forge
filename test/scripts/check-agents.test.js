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

  test('returns correct shape with current repo root', () => {
    const repoRoot = path.resolve(__dirname, '..', '..');
    const result = checkAgents(repoRoot);
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
      const clineFile = path.join(tmpDir, '.cline', 'workflows', 'plan.md');
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
  test('reports error when plugin support metadata is invalid', () => {
    const tmpDir = createTempRepo({
      plan: '---\ndescription: Plan\n---\n\nPlan body.',
    }, [
      {
        id: 'cursor',
        name: 'Cursor',
        version: '1.0.0',
        capabilities: { commands: true },
        support: { status: 'gold-tier' },
        directories: { commands: '.cursor/commands' },
      },
    ]);
    try {
      const result = checkAgents(tmpDir);
      expect(result.errors.some((e) => e.includes('support.status'))).toBe(true);
    } finally {
      cleanupTempRepo(tmpDir);
    }
  });

  test('reports error when commands-capable plugin has no sync adapter', () => {
    const tmpDir = createTempRepo({
      plan: '---\ndescription: Plan\n---\n\nPlan body.',
    }, [
      {
        id: 'mystery-agent',
        name: 'Mystery Agent',
        version: '1.0.0',
        capabilities: { commands: true },
        directories: { commands: '.mystery/commands' },
      },
    ]);
    try {
      const result = checkAgents(tmpDir);
      expect(result.errors.some((e) => e.includes('sync adapter') && e.includes('mystery-agent'))).toBe(true);
    } finally {
      cleanupTempRepo(tmpDir);
    }
  });

  test('reports error when plugin command directory does not match sync adapter output', () => {
    const tmpDir = createTempRepo({
      plan: '---\ndescription: Plan\n---\n\nPlan body.',
    }, [
      {
        id: 'cursor',
        name: 'Cursor',
        version: '1.0.0',
        capabilities: { commands: true },
        directories: { commands: '.cursor/workflows' },
      },
    ]);
    try {
      const result = checkAgents(tmpDir);
      expect(result.errors.some((e) => e.includes('sync output') && e.includes('.cursor/workflows'))).toBe(true);
    } finally {
      cleanupTempRepo(tmpDir);
    }
  });

  test('reports error when rules capability is declared without any scaffold path', () => {
    const tmpDir = createTempRepo({
      plan: '---\ndescription: Plan\n---\n\nPlan body.',
    }, [
      {
        id: 'cursor',
        name: 'Cursor',
        version: '1.0.0',
        capabilities: { commands: true, rules: true },
        directories: { commands: '.cursor/commands' },
      },
    ]);
    try {
      syncCommands({ dryRun: false, check: false, repoRoot: tmpDir });
      const result = checkAgents(tmpDir);
      expect(result.errors.some((e) => e.includes('rules') && e.includes('cursor'))).toBe(true);
    } finally {
      cleanupTempRepo(tmpDir);
    }
  });

  test('reports error when skills capability is declared without any scaffold path', () => {
    const tmpDir = createTempRepo({
      plan: '---\ndescription: Plan\n---\n\nPlan body.',
    }, [
      {
        id: 'opencode',
        name: 'OpenCode',
        version: '1.0.0',
        capabilities: { commands: true, skills: true },
        directories: { commands: '.opencode/commands' },
      },
    ]);
    try {
      syncCommands({ dryRun: false, check: false, repoRoot: tmpDir });
      const result = checkAgents(tmpDir);
      expect(result.errors.some((e) => e.includes('skills') && e.includes('opencode'))).toBe(true);
    } finally {
      cleanupTempRepo(tmpDir);
    }
  });

  test('accepts plugin metadata when support tier, sync path, and scaffolds align', () => {
    const tmpDir = createTempRepo({
      plan: '---\ndescription: Plan\n---\n\nPlan body.',
    }, [
      {
        id: 'cursor',
        name: 'Cursor',
        version: '1.0.0',
        capabilities: {
          commands: true,
          rules: true,
          skills: true,
          hooks: { blocking: false },
          mcp: true,
          contextMode: false,
        },
        support: {
          status: 'supported',
          surface: 'editor-native',
          install: { required: true, repairRequired: false },
        },
        directories: {
          commands: '.cursor/commands',
          rules: '.cursor/rules',
          skills: '.cursor/skills/forge-workflow',
        },
        files: {
          rootConfig: '.cursorrules',
        },
        setup: {
          copyRules: true,
          createSkill: true,
        },
      },
    ]);
    try {
      syncCommands({ dryRun: false, check: false, repoRoot: tmpDir });
      fs.mkdirSync(path.join(tmpDir, '.cursor', 'rules'), { recursive: true });
      fs.mkdirSync(path.join(tmpDir, '.cursor', 'skills', 'forge-workflow'), { recursive: true });

      const result = checkAgents(tmpDir);
      expect(result.errors).toHaveLength(0);
    } finally {
      cleanupTempRepo(tmpDir);
    }
  });

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
