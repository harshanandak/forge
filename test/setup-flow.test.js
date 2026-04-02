/**
 * Tests for setup flow — verifies loadAndSetupCanonicalCommands and
 * related setup functions in lib/commands/setup.js.
 */

const fs = require('node:fs');
const path = require('node:path');
const { describe, test, expect } = require('bun:test');

const setupPath = path.resolve(__dirname, '..', 'lib', 'commands', 'setup.js');
const setupSource = fs.readFileSync(setupPath, 'utf8');

describe('setup flow', () => {
  test('setup.js exports loadAndSetupCanonicalCommands', () => {
    const setup = require(setupPath);
    expect(typeof setup.loadAndSetupCanonicalCommands).toBe('function');
  });

  test('setup.js exports detectConfiguredAgents', () => {
    const setup = require(setupPath);
    expect(typeof setup.detectConfiguredAgents).toBe('function');
  });

  test('setup.js exports removeAgentFiles', () => {
    const setup = require(setupPath);
    expect(typeof setup.removeAgentFiles).toBe('function');
  });

  test('setup.js exports parseSetupFlags', () => {
    const setup = require(setupPath);
    expect(typeof setup.parseSetupFlags).toBe('function');
  });

  test('setup.js exports getWorkflowCommands', () => {
    const setup = require(setupPath);
    expect(typeof setup.getWorkflowCommands).toBe('function');
  });

  test('setup.js exports workflow runtime asset helpers', () => {
    const setup = require(setupPath);
    expect(typeof setup.getWorkflowRuntimeAssets).toBe('function');
    expect(typeof setup.findMissingWorkflowRuntimeAssets).toBe('function');
  });

  test('getWorkflowCommands prefers commands/ over .claude/commands/', () => {
    // The source should show fallback logic
    expect(setupSource).toContain("path.join(packageDir, 'commands')");
    expect(setupSource).toContain('existsSync(canonicalDir)');
  });

  test('workflow runtime asset list covers shipped helper dependencies', () => {
    const setup = require(setupPath);
    const assets = setup.getWorkflowRuntimeAssets();
    expect(assets).toContain('scripts/smart-status.sh');
    expect(assets).toContain('scripts/forge-team/index.sh');
    expect(assets).toContain('.claude/scripts/greptile-resolve.sh');
  });

  test('loadAndSetupCanonicalCommands is used in executeSetup', () => {
    const match = setupSource.match(
      /function executeSetup[\s\S]*?(?=\n(?:async )?function |module\.exports|\n\/\*\*\n)/
    );
    expect(match).not.toBeNull();
    expect(match[0]).toContain('loadAndSetupCanonicalCommands');
  });

  test('loadAndSetupCanonicalCommands is used in quickSetup', () => {
    const match = setupSource.match(
      /(?:async )?function quickSetup[\s\S]*?(?=\n(?:async )?function |\n\/\/ Helper:)/
    );
    expect(match).not.toBeNull();
    expect(match[0]).toContain('loadAndSetupCanonicalCommands');
  });
});

describe('parseSetupFlags', () => {
  const { parseSetupFlags } = require(setupPath);

  test('parses --agents flag', () => {
    const flags = parseSetupFlags(['--agents', 'cursor,cline']);
    expect(flags.agents).toBe('cursor,cline');
  });

  test('parses --agents=value syntax', () => {
    const flags = parseSetupFlags(['--agents=cursor']);
    expect(flags.agents).toBe('cursor');
  });

  test('parses space-separated agents until the next flag', () => {
    const flags = parseSetupFlags(['--agents', 'claude', 'cursor', '--keep']);
    expect(flags.agents).toBe('claude,cursor');
    expect(flags.keep).toBe(true);
  });

  test('does not consume the next flag as an agent token', () => {
    const flags = parseSetupFlags(['--agents', 'claude', '--detect']);
    expect(flags.agents).toBe('claude');
    expect(flags.detect).toBe(true);
  });

  test('parses --all flag', () => {
    const flags = parseSetupFlags(['--all']);
    expect(flags.all).toBe(true);
  });

  test('parses --detect flag', () => {
    const flags = parseSetupFlags(['--detect']);
    expect(flags.detect).toBe(true);
  });

  test('parses --keep flag', () => {
    const flags = parseSetupFlags(['--keep']);
    expect(flags.keep).toBe(true);
  });

  test('parses --yes sets nonInteractive', () => {
    const flags = parseSetupFlags(['--yes']);
    expect(flags.yes).toBe(true);
    expect(flags.nonInteractive).toBe(true);
  });

  test('parses -y shorthand', () => {
    const flags = parseSetupFlags(['-y']);
    expect(flags.yes).toBe(true);
  });

  test('parses --dry-run flag', () => {
    const flags = parseSetupFlags(['--dry-run']);
    expect(flags.dryRun).toBe(true);
  });

  test('defaults all flags to false/null', () => {
    const flags = parseSetupFlags([]);
    expect(flags.agents).toBeNull();
    expect(flags.all).toBe(false);
    expect(flags.detect).toBe(false);
    expect(flags.keep).toBe(false);
    expect(flags.yes).toBe(false);
    expect(flags.force).toBe(false);
    expect(flags.verbose).toBe(false);
    expect(flags.dryRun).toBe(false);
    expect(flags.quick).toBe(false);
  });
});

describe('detectConfiguredAgents', () => {
  const { detectConfiguredAgents } = require(setupPath);

  test('detects agents in repo root (at least claude-code)', () => {
    const repoRoot = path.resolve(__dirname, '..');
    const agents = detectConfiguredAgents(repoRoot);
    // .claude/commands/ exists in the repo
    expect(agents).toContain('claude-code');
  });

  test('returns empty array for empty directory', () => {
    const os = require('node:os');
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-detect-'));
    try {
      const agents = detectConfiguredAgents(tmpDir);
      expect(agents).toEqual([]);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe('findMissingWorkflowRuntimeAssets', () => {
  const { findMissingWorkflowRuntimeAssets } = require(setupPath);

  test('reports missing workflow assets for command-capable setups', () => {
    const os = require('node:os');
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-runtime-assets-'));
    try {
      const missing = findMissingWorkflowRuntimeAssets(tmpDir, ['claude']);
      expect(missing).toContain('scripts/smart-status.sh');
      expect(missing).toContain('.claude/scripts/greptile-resolve.sh');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe('removeAgentFiles', () => {
  const { removeAgentFiles } = require(setupPath);

  test('rejects invalid agent names (OWASP A03)', () => {
    const result = removeAgentFiles('/tmp', '../etc', null);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0]).toContain('Invalid agent name');
  });

  test('rejects unknown agent names', () => {
    const result = removeAgentFiles('/tmp', 'nonexistent-agent', null);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0]).toContain('Unknown agent');
  });

  test('returns empty arrays when no manifest provided', () => {
    const result = removeAgentFiles('/tmp', 'cursor', null);
    expect(result.removed).toEqual([]);
    expect(result.errors).toEqual([]);
  });
});
