const { describe, test, expect } = require('bun:test');

/**
 * Tests for scripts/sync-commands.js
 *
 * The module exports two functions:
 * - parseFrontmatter(content) -> { frontmatter: object, body: string }
 * - buildFile(frontmatter, body) -> string (reconstructed file content)
 */

const {
  parseFrontmatter,
  buildFile,
  AGENT_ADAPTERS,
  adaptForAgent,
} = require('../../scripts/sync-commands.js');

// ---- parseFrontmatter ---------------------------------------------------------

describe('parseFrontmatter', () => {
  test('extracts simple key-value frontmatter', () => {
    const input = '---\ndescription: Check current stage\n---\nSome body text';
    const result = parseFrontmatter(input);
    expect(result.frontmatter).toEqual({ description: 'Check current stage' });
    expect(result.body).toBe('Some body text');
  });

  test('handles multiple frontmatter keys', () => {
    const input = '---\ndescription: Plan a feature\nallowed_agents: claude\n---\nbody here';
    const result = parseFrontmatter(input);
    expect(result.frontmatter).toEqual({
      description: 'Plan a feature',
      allowed_agents: 'claude',
    });
    expect(result.body).toBe('body here');
  });

  test('returns empty object and full content when no frontmatter markers', () => {
    const input = 'Just a regular markdown file\nwith no frontmatter';
    const result = parseFrontmatter(input);
    expect(result.frontmatter).toEqual({});
    expect(result.body).toBe(input);
  });

  test('handles empty body after frontmatter', () => {
    const input = '---\ndescription: Something\n---\n';
    const result = parseFrontmatter(input);
    expect(result.frontmatter).toEqual({ description: 'Something' });
    expect(result.body).toBe('');
  });

  test('handles empty frontmatter block', () => {
    const input = '---\n---\nBody only';
    const result = parseFrontmatter(input);
    expect(result.frontmatter).toEqual({});
    expect(result.body).toBe('Body only');
  });

  test('preserves body that contains --- separators (not frontmatter)', () => {
    const input = '---\ndescription: Test\n---\n\n---\n\nThis has horizontal rules';
    const result = parseFrontmatter(input);
    expect(result.frontmatter).toEqual({ description: 'Test' });
    expect(result.body).toContain('---');
    expect(result.body).toContain('This has horizontal rules');
  });

  test('strips leading newline from body (newline after closing ---)', () => {
    const input = '---\ndescription: X\n---\n\nActual body starts here';
    const result = parseFrontmatter(input);
    expect(result.body).toBe('\nActual body starts here');
  });

  test('handles multiline YAML values (quoted strings)', () => {
    const input = '---\ndescription: "A value with: colons"\n---\nbody';
    const result = parseFrontmatter(input);
    expect(result.frontmatter.description).toBe('A value with: colons');
    expect(result.body).toBe('body');
  });

  test('handles real plan.md frontmatter format', () => {
    const input = '---\ndescription: Design intent → research → branch + worktree + task list\n---\n\nPlan a feature from scratch.';
    const result = parseFrontmatter(input);
    expect(result.frontmatter.description).toBe(
      'Design intent → research → branch + worktree + task list'
    );
    expect(result.body).toContain('Plan a feature from scratch.');
  });

  test('returns empty object for content with single --- at start only', () => {
    const input = '---\nNo closing marker so this is not frontmatter';
    const result = parseFrontmatter(input);
    expect(result.frontmatter).toEqual({});
    expect(result.body).toBe(input);
  });

  test('handles empty string input', () => {
    const result = parseFrontmatter('');
    expect(result.frontmatter).toEqual({});
    expect(result.body).toBe('');
  });
});

// ---- buildFile ----------------------------------------------------------------

describe('buildFile', () => {
  test('produces valid frontmatter with --- delimiters', () => {
    const output = buildFile({ description: 'Hello world' }, 'Some body');
    expect(output).toBe('---\ndescription: Hello world\n---\nSome body');
  });

  test('roundtrips through parseFrontmatter', () => {
    const original = '---\ndescription: Check current stage\n---\n\nBody content here.';
    const parsed = parseFrontmatter(original);
    const rebuilt = buildFile(parsed.frontmatter, parsed.body);
    expect(rebuilt).toBe(original);
  });

  test('handles multiple frontmatter keys', () => {
    const output = buildFile(
      { description: 'Test', allowed_agents: 'claude' },
      'body'
    );
    expect(output).toContain('---\n');
    expect(output).toContain('description: Test');
    expect(output).toContain('allowed_agents: claude');
    expect(output).toEndWith('\n---\nbody');
  });

  test('handles empty frontmatter object', () => {
    const output = buildFile({}, 'Just a body');
    expect(output).toBe('---\n---\nJust a body');
  });

  test('handles empty body', () => {
    const output = buildFile({ description: 'X' }, '');
    expect(output).toBe('---\ndescription: X\n---\n');
  });

  test('quotes values that contain colons', () => {
    const output = buildFile({ description: 'A value with: colons' }, 'body');
    const reparsed = parseFrontmatter(output);
    expect(reparsed.frontmatter.description).toBe('A value with: colons');
  });

  test('rebuilds with different frontmatter while keeping body', () => {
    const original = '---\ndescription: Old description\n---\n\nOriginal body.';
    const parsed = parseFrontmatter(original);
    const rebuilt = buildFile({ description: 'New description' }, parsed.body);
    const reparsed = parseFrontmatter(rebuilt);
    expect(reparsed.frontmatter.description).toBe('New description');
    expect(reparsed.body).toBe(parsed.body);
  });
});

// ---- AGENT_ADAPTERS -------------------------------------------------------------

describe('AGENT_ADAPTERS', () => {
  test('contains all 8 agents', () => {
    const expected = [
      'claude-code',
      'cursor',
      'cline',
      'opencode',
      'github-copilot',
      'kilo-code',
      'roo-code',
      'codex',
    ];
    for (const agent of expected) {
      expect(AGENT_ADAPTERS[agent]).toBeDefined();
    }
  });

  test('each adapter has required properties', () => {
    for (const [_name, adapter] of Object.entries(AGENT_ADAPTERS)) {
      expect(typeof adapter.dir).toBe('function');
      expect(typeof adapter.extension).toBe('string');
      expect(typeof adapter.transformFrontmatter).toBe('function');
      expect(typeof adapter.baseDir).toBe('string');
    }
  });

  test('claude-code is marked as skip (canonical)', () => {
    expect(AGENT_ADAPTERS['claude-code'].skip).toBe(true);
  });
});

// ---- adaptForAgent — Tier 1 agents -----------------------------------------------

describe('adaptForAgent — Tier 1', () => {
  const fm = { description: 'Design intent', allowed_agents: 'claude' };
  const body = '\nPlan a feature from scratch.';

  test('claude-code returns null (skipped)', () => {
    const result = adaptForAgent('claude-code', fm, body, 'plan');
    expect(result).toBeNull();
  });

  // -- Cursor --
  test('cursor strips all frontmatter', () => {
    const result = adaptForAgent('cursor', fm, body, 'plan');
    const parsed = parseFrontmatter(result.content);
    expect(Object.keys(parsed.frontmatter)).toHaveLength(0);
  });

  test('cursor outputs to .cursor/commands/ with <name>.md', () => {
    const result = adaptForAgent('cursor', fm, body, 'plan');
    expect(result.dir).toBe('.cursor/commands/');
    expect(result.filename).toBe('plan.md');
  });

  test('cursor preserves body content', () => {
    const result = adaptForAgent('cursor', fm, body, 'plan');
    expect(result.content).toContain('Plan a feature from scratch.');
  });

  // -- Cline --
  test('cline strips all frontmatter', () => {
    const result = adaptForAgent('cline', fm, body, 'dev');
    const parsed = parseFrontmatter(result.content);
    expect(Object.keys(parsed.frontmatter)).toHaveLength(0);
  });

  test('cline outputs to .cline/workflows/', () => {
    const result = adaptForAgent('cline', fm, body, 'dev');
    expect(result.dir).toBe('.cline/workflows/');
    expect(result.filename).toBe('dev.md');
  });

  // -- OpenCode --
  test('opencode keeps only description', () => {
    const result = adaptForAgent('opencode', fm, body, 'plan');
    const parsed = parseFrontmatter(result.content);
    expect(parsed.frontmatter.description).toBe('Design intent');
    expect(parsed.frontmatter.allowed_agents).toBeUndefined();
  });

  test('opencode outputs to .opencode/commands/', () => {
    const result = adaptForAgent('opencode', fm, body, 'plan');
    expect(result.dir).toBe('.opencode/commands/');
    expect(result.filename).toBe('plan.md');
  });

  // -- GitHub Copilot --
  test('copilot adds name, keeps description, adds tools field', () => {
    const result = adaptForAgent('github-copilot', fm, body, 'plan');
    const parsed = parseFrontmatter(result.content);
    expect(parsed.frontmatter.name).toBe('plan');
    expect(parsed.frontmatter.description).toBe('Design intent');
    expect(parsed.frontmatter.tools).toBeDefined();
    expect(parsed.frontmatter.allowed_agents).toBeUndefined();
  });

  test('copilot uses .prompt.md extension', () => {
    const result = adaptForAgent('github-copilot', fm, body, 'plan');
    expect(result.filename).toBe('plan.prompt.md');
    expect(result.dir).toBe('.github/prompts/');
  });

  test('copilot preserves canonical tools field when present', () => {
    const fmWithTools = { description: 'Plan', tools: ['githubRepo', 'codebase'] };
    const result = adaptForAgent('github-copilot', fmWithTools, body, 'plan');
    const parsed = parseFrontmatter(result.content);
    expect(parsed.frontmatter.tools).toEqual(['githubRepo', 'codebase']);
  });

  test('copilot defaults tools to empty array when not in canonical', () => {
    const fmNoTools = { description: 'Plan' };
    const result = adaptForAgent('github-copilot', fmNoTools, body, 'plan');
    const parsed = parseFrontmatter(result.content);
    expect(parsed.frontmatter.tools).toEqual([]);
  });
});

// ---- adaptForAgent — Tier 2 agents -----------------------------------------------

describe('adaptForAgent — Tier 2', () => {
  const fm = { description: 'Run tests and lint' };
  const body = '\nValidate the code.';

  // -- Kilo Code --
  test('kilo-code keeps description and adds mode: code', () => {
    const result = adaptForAgent('kilo-code', fm, body, 'validate');
    const parsed = parseFrontmatter(result.content);
    expect(parsed.frontmatter.description).toBe('Run tests and lint');
    expect(parsed.frontmatter.mode).toBe('code');
  });

  test('kilo-code outputs to .kilocode/workflows/', () => {
    const result = adaptForAgent('kilo-code', fm, body, 'validate');
    expect(result.dir).toBe('.kilocode/workflows/');
    expect(result.filename).toBe('validate.md');
  });

  // -- Roo Code --
  test('roo-code keeps description and adds mode: code', () => {
    const result = adaptForAgent('roo-code', fm, body, 'validate');
    const parsed = parseFrontmatter(result.content);
    expect(parsed.frontmatter.description).toBe('Run tests and lint');
    expect(parsed.frontmatter.mode).toBe('code');
  });

  test('roo-code outputs to .roo/commands/', () => {
    const result = adaptForAgent('roo-code', fm, body, 'validate');
    expect(result.dir).toBe('.roo/commands/');
    expect(result.filename).toBe('validate.md');
  });

  // -- Codex --
  test('codex outputs to .codex/skills/<name>/ with SKILL.md', () => {
    const result = adaptForAgent('codex', fm, body, 'validate');
    expect(result.dir).toBe('.codex/skills/validate/');
    expect(result.filename).toBe('SKILL.md');
  });

  test('codex keeps description in frontmatter', () => {
    const result = adaptForAgent('codex', fm, body, 'validate');
    const parsed = parseFrontmatter(result.content);
    expect(parsed.frontmatter.description).toBe('Run tests and lint');
  });
});

// ---- adaptForAgent — edge cases ---------------------------------------------------

describe('adaptForAgent — edge cases', () => {
  test('throws for unknown agent name', () => {
    expect(() => adaptForAgent('unknown-agent', {}, 'body', 'plan')).toThrow();
  });

  test('handles empty frontmatter input', () => {
    const result = adaptForAgent('cursor', {}, 'body', 'plan');
    expect(result.content).toBe('body');
  });

  test('handles frontmatter with no description for copilot', () => {
    const result = adaptForAgent('github-copilot', {}, 'body', 'status');
    const parsed = parseFrontmatter(result.content);
    expect(parsed.frontmatter.name).toBe('status');
    expect(parsed.frontmatter.tools).toBeDefined();
  });

  test('opencode with no description produces empty frontmatter', () => {
    const result = adaptForAgent('opencode', { allowed_agents: 'claude' }, 'body', 'dev');
    const parsed = parseFrontmatter(result.content);
    expect(parsed.frontmatter.description).toBeUndefined();
    expect(parsed.frontmatter.allowed_agents).toBeUndefined();
  });

  test('preserves body across all non-skip agents', () => {
    const agents = ['cursor', 'cline', 'opencode', 'github-copilot', 'kilo-code', 'roo-code', 'codex'];
    const testBody = '\nSome important body content.';
    for (const agent of agents) {
      const result = adaptForAgent(agent, { description: 'X' }, testBody, 'plan');
      expect(result.content).toContain('Some important body content.');
    }
  });
});

// ---- syncCommands — CLI sync logic ------------------------------------------------

const fs = require('fs');
const path = require('path');
const os = require('os');
const { syncCommands } = require('../../scripts/sync-commands.js');

/**
 * Create a temp directory with a .claude/commands/ structure containing
 * the given command files. Returns the temp dir path.
 *
 * @param {Record<string, string>} commands - Map of command name to file content
 * @returns {string} Absolute path to the temp repo root
 */
function createTempRepo(commands) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-sync-test-'));
  const cmdDir = path.join(tmpDir, '.claude', 'commands');
  fs.mkdirSync(cmdDir, { recursive: true });
  for (const [name, content] of Object.entries(commands)) {
    fs.writeFileSync(path.join(cmdDir, `${name}.md`), content);
  }
  return tmpDir;
}

/**
 * Clean up a temp directory created by createTempRepo.
 *
 * @param {string} tmpDir
 */
function cleanupTempRepo(tmpDir) {
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

describe('syncCommands — dry-run mode', () => {
  test('prints planned writes without creating any files', () => {
    const tmpDir = createTempRepo({
      plan: '---\ndescription: Plan a feature\n---\n\nPlan body.',
    });
    try {
      const result = syncCommands({ dryRun: true, check: false, repoRoot: tmpDir });
      // Should report planned writes
      expect(result.planned.length).toBeGreaterThan(0);
      // Should NOT have written any agent directories
      const cursorDir = path.join(tmpDir, '.cursor', 'commands');
      expect(fs.existsSync(cursorDir)).toBe(false);
    } finally {
      cleanupTempRepo(tmpDir);
    }
  });

  test('planned entries contain agent, dir, filename, and content', () => {
    const tmpDir = createTempRepo({
      status: '---\ndescription: Check status\n---\n\nStatus body.',
    });
    try {
      const result = syncCommands({ dryRun: true, check: false, repoRoot: tmpDir });
      for (const entry of result.planned) {
        expect(typeof entry.agent).toBe('string');
        expect(typeof entry.dir).toBe('string');
        expect(typeof entry.filename).toBe('string');
        expect(typeof entry.content).toBe('string');
      }
    } finally {
      cleanupTempRepo(tmpDir);
    }
  });

  test('skips claude-code agent (canonical source)', () => {
    const tmpDir = createTempRepo({
      plan: '---\ndescription: Plan\n---\n\nBody.',
    });
    try {
      const result = syncCommands({ dryRun: true, check: false, repoRoot: tmpDir });
      const agentNames = result.planned.map((e) => e.agent);
      expect(agentNames).not.toContain('claude-code');
    } finally {
      cleanupTempRepo(tmpDir);
    }
  });
});

describe('syncCommands — default write mode', () => {
  test('creates agent directories and writes adapted files', () => {
    const tmpDir = createTempRepo({
      plan: '---\ndescription: Plan a feature\n---\n\nPlan body.',
    });
    try {
      const result = syncCommands({ dryRun: false, check: false, repoRoot: tmpDir });
      expect(result.written.length).toBeGreaterThan(0);
      // Check that at least one agent file was actually written
      const clineFile = path.join(tmpDir, '.cline', 'workflows', 'plan.md');
      expect(fs.existsSync(clineFile)).toBe(true);
      const content = fs.readFileSync(clineFile, 'utf8');
      expect(content).toContain('Plan body.');
    } finally {
      cleanupTempRepo(tmpDir);
    }
  });

  test('creates nested directories for cursor and codex', () => {
    const tmpDir = createTempRepo({
      dev: '---\ndescription: Develop\n---\n\nDev body.',
    });
    try {
      syncCommands({ dryRun: false, check: false, repoRoot: tmpDir });
      const cursorFile = path.join(tmpDir, '.cursor', 'commands', 'dev.md');
      const codexFile = path.join(tmpDir, '.codex', 'skills', 'dev', 'SKILL.md');
      expect(fs.existsSync(cursorFile)).toBe(true);
      expect(fs.existsSync(codexFile)).toBe(true);
    } finally {
      cleanupTempRepo(tmpDir);
    }
  });

  test('handles multiple command files', () => {
    const tmpDir = createTempRepo({
      plan: '---\ndescription: Plan\n---\n\nPlan body.',
      dev: '---\ndescription: Dev\n---\n\nDev body.',
    });
    try {
      const result = syncCommands({ dryRun: false, check: false, repoRoot: tmpDir });
      const nonSkipCount = Object.values(AGENT_ADAPTERS).filter((a) => !a.skip).length;
      expect(result.written.length).toBe(nonSkipCount * 2);
    } finally {
      cleanupTempRepo(tmpDir);
    }
  });
});

describe('syncCommands — check mode', () => {
  test('returns inSync=true when all files match', () => {
    const tmpDir = createTempRepo({
      plan: '---\ndescription: Plan\n---\n\nPlan body.',
    });
    try {
      // First, write files
      syncCommands({ dryRun: false, check: false, repoRoot: tmpDir });
      // Then, check — should be in sync
      const result = syncCommands({ dryRun: false, check: true, repoRoot: tmpDir });
      expect(result.inSync).toBe(true);
      expect(result.outOfSync.length).toBe(0);
      expect(result.staleFiles).toHaveLength(0);
      expect(result.manifestMissing).toBe(false);
    } finally {
      cleanupTempRepo(tmpDir);
    }
  });

  test('returns inSync=false when a file has been manually modified', () => {
    const tmpDir = createTempRepo({
      plan: '---\ndescription: Plan\n---\n\nPlan body.',
    });
    try {
      // Write files
      syncCommands({ dryRun: false, check: false, repoRoot: tmpDir });
      // Manually modify one file
      const clineFile = path.join(tmpDir, '.cline', 'workflows', 'plan.md');
      fs.writeFileSync(clineFile, 'Manually modified content');
      // Check — should detect out of sync
      const result = syncCommands({ dryRun: false, check: true, repoRoot: tmpDir });
      expect(result.inSync).toBe(false);
      expect(result.outOfSync.length).toBeGreaterThan(0);
      const outPaths = result.outOfSync.map((e) => e.filePath);
      expect(outPaths.some((p) => p.includes('cline'))).toBe(true);
    } finally {
      cleanupTempRepo(tmpDir);
    }
  });

  test('returns inSync=false when agent file is missing', () => {
    const tmpDir = createTempRepo({
      plan: '---\ndescription: Plan\n---\n\nPlan body.',
    });
    try {
      // Do NOT write files first — agent dirs don't exist
      const result = syncCommands({ dryRun: false, check: true, repoRoot: tmpDir });
      expect(result.inSync).toBe(false);
      expect(result.outOfSync.length).toBeGreaterThan(0);
    } finally {
      cleanupTempRepo(tmpDir);
    }
  });

  test('one agent in sync and one out of sync', () => {
    const tmpDir = createTempRepo({
      plan: '---\ndescription: Plan\n---\n\nPlan body.',
    });
    try {
      // Write all files
      syncCommands({ dryRun: false, check: false, repoRoot: tmpDir });
      // Modify only the opencode file
      const opencodeFile = path.join(tmpDir, '.opencode', 'commands', 'plan.md');
      fs.writeFileSync(opencodeFile, 'Modified opencode content');
      // Check
      const result = syncCommands({ dryRun: false, check: true, repoRoot: tmpDir });
      expect(result.inSync).toBe(false);
      // Only the modified file should be out of sync
      const outPaths = result.outOfSync.map((e) => e.filePath);
      expect(outPaths.some((p) => p.includes('opencode'))).toBe(true);
      // Other agents should still be in sync (verify count is small)
      expect(result.outOfSync.length).toBe(1);
    } finally {
      cleanupTempRepo(tmpDir);
    }
  });
});

describe('syncCommands — stale file detection', () => {
  test('returns staleFiles when a command is deleted from canonical source', () => {
    const tmpDir = createTempRepo({
      plan: '---\ndescription: Plan\n---\n\nPlan body.',
      dev: '---\ndescription: Dev\n---\n\nDev body.',
    });
    try {
      // Sync both commands
      syncCommands({ dryRun: false, check: false, repoRoot: tmpDir });
      // Delete 'dev' from canonical source
      fs.unlinkSync(path.join(tmpDir, '.claude', 'commands', 'dev.md'));
      // Check should detect stale dev files
      const result = syncCommands({ dryRun: false, check: true, repoRoot: tmpDir });
      expect(result.staleFiles.length).toBeGreaterThan(0);
      expect(result.inSync).toBe(false);
      // At least one stale file should reference 'dev'
      expect(result.staleFiles.some((f) => f.includes('dev'))).toBe(true);
    } finally {
      cleanupTempRepo(tmpDir);
    }
  });

  test('does not flag custom files as stale even with managed extension', () => {
    const tmpDir = createTempRepo({
      plan: '---\ndescription: Plan\n---\n\nPlan body.',
    });
    try {
      syncCommands({ dryRun: false, check: false, repoRoot: tmpDir });
      // Add a custom file with the SAME managed extension (.prompt.md) in an agent dir
      // This is the key test: manifest-based detection should NOT flag it
      const customFile = path.join(tmpDir, '.github', 'prompts', 'my-custom-guidelines.prompt.md');
      fs.writeFileSync(customFile, 'Custom prompt guidelines');
      const result = syncCommands({ dryRun: false, check: true, repoRoot: tmpDir });
      const stalePaths = result.staleFiles || [];
      expect(stalePaths.some((f) => f.includes('my-custom-guidelines'))).toBe(false);
    } finally {
      cleanupTempRepo(tmpDir);
    }
  });
});

describe('syncCommands — overwrite warning', () => {
  test('reports files that would be overwritten with different content', () => {
    const tmpDir = createTempRepo({
      plan: '---\ndescription: Plan\n---\n\nPlan body.',
    });
    try {
      // Write files initially
      syncCommands({ dryRun: false, check: false, repoRoot: tmpDir });
      // Manually modify a file
      const clineFile = path.join(tmpDir, '.cline', 'workflows', 'plan.md');
      fs.writeFileSync(clineFile, 'Manually modified content');
      // Write again — should report overwrite warnings
      const result = syncCommands({ dryRun: false, check: false, repoRoot: tmpDir });
      expect(result.overwritten.length).toBeGreaterThan(0);
      expect(result.overwritten.some((e) => e.filePath.includes('cline'))).toBe(true);
    } finally {
      cleanupTempRepo(tmpDir);
    }
  });

  test('no overwrite warnings when files match expected content', () => {
    const tmpDir = createTempRepo({
      plan: '---\ndescription: Plan\n---\n\nPlan body.',
    });
    try {
      // Write files
      syncCommands({ dryRun: false, check: false, repoRoot: tmpDir });
      // Write again — no modifications, so no warnings
      const result = syncCommands({ dryRun: false, check: false, repoRoot: tmpDir });
      expect(result.overwritten.length).toBe(0);
    } finally {
      cleanupTempRepo(tmpDir);
    }
  });
});

// Note: .clinerules flat-file migration tests removed — Cline workflows
// now go to .cline/workflows/, so migration is no longer needed.

describe('syncCommands — edge cases', () => {
  test('handles empty commands directory', () => {
    const tmpDir = createTempRepo({});
    try {
      const result = syncCommands({ dryRun: true, check: false, repoRoot: tmpDir });
      expect(result.planned.length).toBe(0);
    } finally {
      cleanupTempRepo(tmpDir);
    }
  });

  test('check mode returns empty=true when commands directory is empty', () => {
    const tmpDir = createTempRepo({});
    try {
      const result = syncCommands({ dryRun: false, check: true, repoRoot: tmpDir });
      expect(result.empty).toBe(true);
      expect(result.inSync).toBe(false);
    } finally {
      cleanupTempRepo(tmpDir);
    }
  });

  test('check mode returns manifestMissing when files in sync but no manifest', () => {
    const tmpDir = createTempRepo({
      plan: '---\ndescription: Plan\n---\n\nPlan body.',
    });
    try {
      // Write files (creates manifest), then delete manifest
      syncCommands({ dryRun: false, check: false, repoRoot: tmpDir });
      fs.unlinkSync(path.join(tmpDir, '.forge', 'sync-manifest.json'));
      // Check: files are in sync but manifest is missing
      const result = syncCommands({ dryRun: false, check: true, repoRoot: tmpDir });
      expect(result.manifestMissing).toBe(true);
      expect(result.inSync).toBe(false);
      expect(result.outOfSync.length).toBe(0);
    } finally {
      cleanupTempRepo(tmpDir);
    }
  });

  test('handles command file with no frontmatter', () => {
    const tmpDir = createTempRepo({
      simple: 'Just a body with no frontmatter.',
    });
    try {
      const result = syncCommands({ dryRun: false, check: false, repoRoot: tmpDir });
      expect(result.written.length).toBeGreaterThan(0);
    } finally {
      cleanupTempRepo(tmpDir);
    }
  });
});
