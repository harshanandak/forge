const { describe, test, expect } = require('bun:test');
const path = require('path');
const fs = require('fs');
const os = require('os');

const { beadsHealthCheck } = require('../lib/beads-health-check');

/**
 * Helper: create a mock _exec function.
 * @param {Object} overrides - Keys are 'create'|'close'|'sync', values are
 *   { output: string } or { error: Error } to control behavior per step.
 * @returns {Function} Mock exec function compatible with execFileSync signature.
 */
function createMockExec(overrides = {}) {
  return function mockExec(cmd, args, _opts) {
    const subcommand = args[0]; // 'create', 'close', 'sync'

    if (subcommand === 'create') {
      if (overrides.create && overrides.create.error) {
        throw overrides.create.error;
      }
      return overrides.create?.output ?? 'Created issue: forge-0001\n';
    }

    if (subcommand === 'close') {
      if (overrides.close && overrides.close.error) {
        throw overrides.close.error;
      }
      return overrides.close?.output ?? 'Closed issue: forge-0001\n';
    }

    if (subcommand === 'sync') {
      if (overrides.sync && overrides.sync.error) {
        throw overrides.sync.error;
      }
      return overrides.sync?.output ?? 'Synced 1 issue\n';
    }

    return '';
  };
}

describe('beadsHealthCheck', () => {
  /** @type {string} */
  let tmpDir;

  // Create a fresh temp dir with a .beads/issues.jsonl for each test
  function setupTmpDir(issueLines = []) {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'beads-health-'));
    const beadsDir = path.join(tmpDir, '.beads');
    fs.mkdirSync(beadsDir, { recursive: true });
    const jsonlPath = path.join(beadsDir, 'issues.jsonl');
    fs.writeFileSync(jsonlPath, issueLines.join('\n') + (issueLines.length ? '\n' : ''));
    return tmpDir;
  }

  test('full successful flow returns healthy=true', () => {
    const projectRoot = setupTmpDir([
      JSON.stringify({ id: 'forge-0001', title: 'Setup verification', status: 'open' }),
      JSON.stringify({ id: 'forge-0002', title: 'Real issue', status: 'open' })
    ]);

    const mockExec = createMockExec({
      create: { output: 'Created issue: forge-0001\n' },
      close: { output: 'Closed issue: forge-0001\n' },
      sync: { output: 'Synced 1 issue\n' }
    });

    const result = beadsHealthCheck(projectRoot, { _exec: mockExec });

    expect(result.healthy).toBe(true);
    expect(result.failedStep).toBeNull();
    expect(result.error).toBeNull();

    // Verify cleanup: the test issue line should be removed, real issue kept
    const jsonlPath = path.join(projectRoot, '.beads', 'issues.jsonl');
    const remaining = fs.readFileSync(jsonlPath, 'utf8').trim();
    const lines = remaining.split('\n').filter(Boolean);
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]).id).toBe('forge-0002');
  });

  test('bd create fails returns failedStep=create, healthy=false', () => {
    const projectRoot = setupTmpDir();

    const mockExec = createMockExec({
      create: { error: new Error('bd: command not found') }
    });

    const result = beadsHealthCheck(projectRoot, { _exec: mockExec });

    expect(result.healthy).toBe(false);
    expect(result.failedStep).toBe('create');
    expect(result.error).toBe('bd: command not found');
  });

  test('bd close fails returns failedStep=close, healthy=false', () => {
    const projectRoot = setupTmpDir([
      JSON.stringify({ id: 'forge-0001', title: 'Setup verification', status: 'open' })
    ]);

    const mockExec = createMockExec({
      create: { output: 'Created issue: forge-0001\n' },
      close: { error: new Error('Failed to close issue') }
    });

    const result = beadsHealthCheck(projectRoot, { _exec: mockExec });

    expect(result.healthy).toBe(false);
    expect(result.failedStep).toBe('close');
    expect(result.error).toBe('Failed to close issue');
  });

  test('bd sync fails still returns healthy=true (warning only)', () => {
    const projectRoot = setupTmpDir([
      JSON.stringify({ id: 'forge-0001', title: 'Setup verification', status: 'open' })
    ]);

    const mockExec = createMockExec({
      create: { output: 'Created issue: forge-0001\n' },
      close: { output: 'Closed issue: forge-0001\n' },
      sync: { error: new Error('fatal: no remote configured') }
    });

    const result = beadsHealthCheck(projectRoot, { _exec: mockExec });

    expect(result.healthy).toBe(true);
    expect(result.failedStep).toBeNull();
    expect(result.warning).toContain('sync');
  });

  test('cleanup removes only the test issue line from JSONL', () => {
    const issueLines = [
      JSON.stringify({ id: 'forge-0042', title: 'Setup verification', status: 'open' }),
      JSON.stringify({ id: 'forge-0099', title: 'Real bug', status: 'open' }),
      JSON.stringify({ id: 'forge-0100', title: 'Another real issue', status: 'in_progress' })
    ];
    const projectRoot = setupTmpDir(issueLines);

    const mockExec = createMockExec({
      create: { output: 'Created issue: forge-0042\n' },
      close: { output: 'Closed issue: forge-0042\n' },
      sync: { output: 'Synced\n' }
    });

    const result = beadsHealthCheck(projectRoot, { _exec: mockExec });

    expect(result.healthy).toBe(true);

    // Verify the JSONL file
    const jsonlPath = path.join(projectRoot, '.beads', 'issues.jsonl');
    const remaining = fs.readFileSync(jsonlPath, 'utf8').trim();
    const lines = remaining.split('\n').filter(Boolean);
    expect(lines).toHaveLength(2);

    const ids = lines.map(l => JSON.parse(l).id);
    expect(ids).toContain('forge-0099');
    expect(ids).toContain('forge-0100');
    expect(ids).not.toContain('forge-0042');
  });

  test('cleanup failure still returns healthy=true with warning', () => {
    // Use a projectRoot that does NOT have a .beads dir, so cleanup will fail
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'beads-health-noclean-'));

    const mockExec = createMockExec({
      create: { output: 'Created issue: forge-0001\n' },
      close: { output: 'Closed issue: forge-0001\n' },
      sync: { output: 'Synced\n' }
    });

    const result = beadsHealthCheck(projectRoot, { _exec: mockExec });

    expect(result.healthy).toBe(true);
    expect(result.failedStep).toBeNull();
    // Should have a warning about cleanup
    expect(result.warning).toBeDefined();
  });

  test('parses issue ID from various bd create output formats', () => {
    const projectRoot = setupTmpDir([
      JSON.stringify({ id: 'forge-abc1', title: 'Setup verification', status: 'open' })
    ]);

    // Test with different output format
    const mockExec = createMockExec({
      create: { output: '  Created issue: forge-abc1  \n' },
      close: { output: 'Closed issue: forge-abc1\n' },
      sync: { output: 'Synced\n' }
    });

    const result = beadsHealthCheck(projectRoot, { _exec: mockExec });

    expect(result.healthy).toBe(true);
    expect(result.failedStep).toBeNull();
  });
});
