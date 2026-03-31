'use strict';

const path = require('node:path');
const { describe, test, expect } = require('bun:test');

describe('rollback command', () => {
  const mod = require('../../lib/commands/rollback');

  // ── Registry compliance ──────────────────────────────────────────────
  test('exports name === "rollback"', () => {
    expect(mod.name).toBe('rollback');
  });

  test('exports a description string', () => {
    expect(typeof mod.description).toBe('string');
    expect(mod.description.length).toBeGreaterThan(0);
  });

  test('exports a handler function', () => {
    expect(typeof mod.handler).toBe('function');
  });

  // ── Validation functions ─────────────────────────────────────────────
  test('validateRollbackInput rejects invalid method', () => {
    const result = mod.validateRollbackInput('invalid', 'HEAD');
    expect(result.valid).toBe(false);
    expect(result.error).toContain('Invalid method');
  });

  test('validateRollbackInput accepts valid commit method with HEAD', () => {
    const result = mod.validateRollbackInput('commit', 'HEAD');
    expect(result.valid).toBe(true);
  });

  test('validateRollbackInput accepts valid commit hash', () => {
    const result = mod.validateRollbackInput('commit', 'abc123');
    expect(result.valid).toBe(true);
  });

  test('validateRollbackInput rejects invalid commit hash', () => {
    const result = mod.validateRollbackInput('commit', 'not-a-hash!!!');
    expect(result.valid).toBe(false);
  });

  test('validateRollbackInput validates partial method with valid paths', () => {
    // Use path.resolve to get a platform-appropriate absolute root
    const root = path.resolve('/project');
    const result = mod.validateRollbackInput('partial', 'src/index.js, lib/utils.js', root);
    expect(result.valid).toBe(true);
  });

  test('validateRollbackInput rejects partial paths with shell metacharacters', () => {
    const result = mod.validateRollbackInput('partial', 'src/index.js; rm -rf /', '/project');
    expect(result.valid).toBe(false);
  });

  test('validateRollbackInput validates branch range', () => {
    const result = mod.validateRollbackInput('branch', 'abc123..def456');
    expect(result.valid).toBe(true);
  });

  test('validateRollbackInput rejects branch range without ..', () => {
    const result = mod.validateRollbackInput('branch', 'abc123');
    expect(result.valid).toBe(false);
  });

  // ── extractUserSections ──────────────────────────────────────────────
  test('extractUserSections returns empty object when file does not exist', () => {
    const mockFs = { existsSync: () => false };
    const result = mod.extractUserSections('/fake/path', { _fs: mockFs });
    expect(result).toEqual({});
  });

  test('extractUserSections extracts USER:START/END sections', () => {
    const content = 'before<!-- USER:START -->custom stuff<!-- USER:END -->after';
    const mockFs = {
      existsSync: () => true,
      readFileSync: () => content,
      readdirSync: () => [],
    };
    const result = mod.extractUserSections('/fake/AGENTS.md', { _fs: mockFs });
    expect(result.user_0).toBe('custom stuff');
  });

  // ── preserveUserSections ─────────────────────────────────────────────
  test('preserveUserSections restores USER sections in file content', () => {
    let writtenContent = null;
    const mockFs = {
      existsSync: () => true,
      readFileSync: () => 'before<!-- USER:START -->old<!-- USER:END -->after',
      writeFileSync: (_p, content) => { writtenContent = content; },
      mkdirSync: () => {},
    };
    mod.preserveUserSections('/fake/AGENTS.md', { user_0: 'restored' }, { _fs: mockFs });
    expect(writtenContent).toContain('<!-- USER:START -->restored<!-- USER:END -->');
  });

  // ── performRollback ──────────────────────────────────────────────────
  test('performRollback returns false for invalid input', async () => {
    const result = await mod.performRollback('invalid', 'HEAD', false, '/project', {});
    expect(result).toBe(false);
  });

  test('performRollback returns false when working dir is dirty', async () => {
    const mockExec = (_cmd, _args, _opts) => {
      return Buffer.from('M  dirty-file.js\n');
    };
    const mockFs = { existsSync: () => true, readFileSync: () => '' };
    const result = await mod.performRollback('commit', 'HEAD', false, '/project', {
      _exec: mockExec,
      _fs: mockFs,
    });
    expect(result).toBe(false);
  });

  test('performRollback dry-run commit succeeds without git side-effects', async () => {
    let execCalls = [];
    const mockExec = (cmd, args, _opts) => {
      execCalls.push({ cmd, args });
      // git status --porcelain -> clean
      if (cmd === 'git' && args[0] === 'status') return Buffer.from('');
      // git diff-tree
      if (cmd === 'git' && args[0] === 'diff-tree') return Buffer.from('file.js\n');
      return Buffer.from('');
    };
    const mockFs = { existsSync: () => false };
    const result = await mod.performRollback('commit', 'abc123', true, '/project', {
      _exec: mockExec,
      _fs: mockFs,
    });
    expect(result).toBe(true);
    // Should NOT have called git revert (dry run)
    const revertCalls = execCalls.filter(c => c.args && c.args.includes('revert'));
    expect(revertCalls.length).toBe(0);
  });

  // ── showRollbackMenu ─────────────────────────────────────────────────
  test('showRollbackMenu is exported as a function', () => {
    expect(typeof mod.showRollbackMenu).toBe('function');
  });

  // ── handler dispatches to showRollbackMenu or performRollback ────────
  test('handler with --method and --target calls performRollback', async () => {
    // Use invalid method to quickly check dispatch without needing git mocks
    const result = await mod.handler([], { '--method': 'invalid', '--target': 'HEAD' }, '/project', {});
    expect(result.success).toBe(false);
  });
});
