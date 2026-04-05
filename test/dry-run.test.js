const { describe, test, expect, beforeEach, afterEach } = require('bun:test');
const { ActionCollector } = require('../lib/setup-utils');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { prepareMockSetupTools } = require('./helpers/setup-command-harness');

// Helper: create a unique temp directory for each test
function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'forge-dry-run-'));
}

// Helper: remove temp directory recursively
function rmTmpDir(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch (_err) {
    // Ignore cleanup errors on Windows
  }
}

// Helper: run forge CLI as subprocess and capture output
async function runForge(args, cwd) {
  const forgeBin = path.resolve(__dirname, '..', 'bin', 'forge.js');
  const mockToolsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-setup-tools-'));
  const mockBinDir = prepareMockSetupTools(mockToolsRoot);
  const inheritedPath = process.env.PATH || process.env.Path || '';
  const proc = globalThis.Bun.spawn(['bun', 'run', forgeBin, ...args], {
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
    env: {
      ...process.env,
      // Force non-interactive to avoid prompts
      CI: '1',
      PATH: `${mockBinDir}${path.delimiter}${inheritedPath}`,
      Path: `${mockBinDir}${path.delimiter}${inheritedPath}`,
    },
  });

  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;

  rmTmpDir(mockToolsRoot);

  return { stdout, stderr, exitCode };
}

// Helper: list all files/dirs created in a directory (recursive)
function listAllEntries(dir) {
  const entries = [];
  if (!fs.existsSync(dir)) return entries;

  const items = fs.readdirSync(dir, { withFileTypes: true });
  for (const item of items) {
    const fullPath = path.join(dir, item.name);
    entries.push(item.name);
    if (item.isDirectory()) {
      const sub = listAllEntries(fullPath);
      for (const s of sub) {
        entries.push(path.join(item.name, s));
      }
    }
  }
  return entries;
}

// ============================================================
// 1. ActionCollector integration — unit tests
// ============================================================
describe('ActionCollector dry-run integration', () => {
  let collector;

  beforeEach(() => {
    collector = new ActionCollector();
  });

  test('collects actions for a mock setup and print() includes all entries', () => {
    // Simulate what --dry-run would collect
    collector.add('create', 'AGENTS.md', 'Copy workflow documentation');
    collector.add('create', '.claude/settings.json', 'Create Claude agent settings');
    collector.add('create', '.cursor/rules/', 'Create Cursor rules directory');
    collector.add('skip', '.github/workflows/', 'Already exists');

    const actions = collector.list();
    expect(actions).toHaveLength(4);

    // Verify print() output contains the right icons and paths
    const lines = [];
    const originalWrite = process.stdout.write;
    process.stdout.write = (chunk) => {
      lines.push(chunk.toString());
      return true;
    };

    try {
      collector.print();
    } finally {
      process.stdout.write = originalWrite;
    }

    const output = lines.join('');
    expect(output).toContain('[+]');
    expect(output).toContain('AGENTS.md');
    expect(output).toContain('.claude/settings.json');
    expect(output).toContain('.cursor/rules/');
    expect(output).toContain('[-]');
    expect(output).toContain('.github/workflows/');
  });

  test('filtering actions by agent name returns only matching entries', () => {
    // Simulate collecting actions for multiple agents
    collector.add('create', '.claude/settings.json', 'Claude settings');
    collector.add('create', '.claude/commands/plan.md', 'Claude plan command');
    collector.add('create', '.cursor/rules/forge.mdc', 'Cursor rules');
    collector.add('create', 'AGENTS.md', 'Shared workflow doc');

    // Filter for Claude-only actions
    const claudeActions = collector.list().filter(
      a => a.path.includes('.claude') || !a.path.startsWith('.')
    );
    // Should include .claude/* and AGENTS.md but not .cursor/*
    const paths = claudeActions.map(a => a.path);
    expect(paths).toContain('.claude/settings.json');
    expect(paths).toContain('.claude/commands/plan.md');
    expect(paths).toContain('AGENTS.md');
    expect(paths).not.toContain('.cursor/rules/forge.mdc');
  });
});

// ============================================================
// 2. --dry-run does not create any files
// ============================================================
describe('--dry-run flag', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    rmTmpDir(tmpDir);
  });

  test('--dry-run does not create any files in target directory', async () => {
    const { stdout, stderr, exitCode } = await runForge(
      ['setup', '--dry-run', '--yes', '--path', tmpDir],
      tmpDir
    );

    // Should exit successfully
    expect(exitCode).toBe(0);

    // stdout should contain dry-run indication
    const combined = stdout + stderr;
    expect(combined.toLowerCase()).toContain('dry');

    // Target directory should remain empty (no files created)
    const entries = listAllEntries(tmpDir);
    expect(entries).toHaveLength(0);
  }, 30000);

  test('--dry-run outputs planned actions to stdout', async () => {
    const { stdout, exitCode } = await runForge(
      ['setup', '--dry-run', '--yes', '--path', tmpDir],
      tmpDir
    );

    expect(exitCode).toBe(0);

    // Should list planned file operations
    expect(stdout).toContain('AGENTS.md');
  }, 30000);
});

// ============================================================
// 3. --dry-run + --agents=claude only lists Claude-related files
// ============================================================
describe('--dry-run with --agents filter', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    rmTmpDir(tmpDir);
  });

  test('--dry-run --agents=claude only lists Claude-related files', async () => {
    const { stdout, exitCode } = await runForge(
      ['setup', '--dry-run', '--agents=claude', '--path', tmpDir],
      tmpDir
    );

    expect(exitCode).toBe(0);

    // Should mention .claude paths
    expect(stdout).toContain('.claude');

    // Should NOT mention .cursor paths (cursor not selected)
    expect(stdout).not.toContain('.cursor');
  }, 30000);
});

// ============================================================
// 4. --agents=claude,cursor installs ONLY .claude/ and .cursor/ dirs
// ============================================================
describe('--agents flag filtering', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    rmTmpDir(tmpDir);
  });

  test('--agents=claude,cursor installs only .claude/ and .cursor/ agent dirs', async () => {
    const { exitCode } = await runForge(
      ['setup', '--agents=claude,cursor', '--yes', '--skip-external', '--path', tmpDir],
      tmpDir
    );

    expect(exitCode).toBe(0);

    const entries = listAllEntries(tmpDir);
    const entrySet = new Set(entries);

    // Should have .claude and .cursor directories
    expect(entrySet.has('.claude') || entries.some(e => e.startsWith('.claude'))).toBe(true);
    expect(entrySet.has('.cursor') || entries.some(e => e.startsWith('.cursor'))).toBe(true);

    // Should NOT have other agent dirs like .github/copilot or .windsurf etc.
    // (Only .claude and .cursor agent-specific dirs should exist)
    const agentDirs = entries.filter(e =>
      e.startsWith('.windsurf') || e.startsWith('.cline') || e.startsWith('.roo')
    );
    expect(agentDirs).toHaveLength(0);
  }, 30000);
});

// ============================================================
// 5. --agents=invalid exits with error listing valid agent names
// ============================================================
describe('--agents validation', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    rmTmpDir(tmpDir);
  });

  test('--agents=invalid exits with error listing valid agent names', async () => {
    const { stdout, stderr, exitCode } = await runForge(
      ['setup', '--agents=invalid', '--path', tmpDir],
      tmpDir
    );

    // Should exit with non-zero
    expect(exitCode).not.toBe(0);

    // Output should mention available/valid agents
    const combined = stdout + stderr;
    const lower = combined.toLowerCase();
    expect(lower).toContain('available') || expect(lower).toContain('valid');

    // Should list at least 'claude' as a valid agent name
    expect(combined).toContain('claude');
  }, 30000);
});
