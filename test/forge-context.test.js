const { describe, test, expect } = require('bun:test');

const { ForgeContext } = require('../lib/forge-context');

describe('ForgeContext', () => {
  test('defaults every flag off and projectRoot to cwd', () => {
    const context = new ForgeContext();

    expect(context.projectRoot).toBe(process.cwd());
    expect(context.forceMode).toBe(false);
    expect(context.verboseMode).toBe(false);
    expect(context.nonInteractive).toBe(false);
    expect(context.symlinkOnly).toBe(false);
    expect(context.pkgManager).toBe('npm');
    expect(context.actionLog).toEqual([]);
    expect(context.packageDir).toBe('');
  });

  test('carries supplied options through', () => {
    const actionLog = [{ file: 'AGENTS.md', action: 'created' }];
    const context = new ForgeContext({
      projectRoot: '/tmp/project',
      forceMode: true,
      verboseMode: true,
      nonInteractive: true,
      symlinkOnly: true,
      pkgManager: 'bun',
      actionLog,
      packageDir: '/tmp/forge',
    });

    expect(context.projectRoot).toBe('/tmp/project');
    expect(context.forceMode).toBe(true);
    expect(context.verboseMode).toBe(true);
    expect(context.nonInteractive).toBe(true);
    expect(context.symlinkOnly).toBe(true);
    expect(context.pkgManager).toBe('bun');
    expect(context.actionLog).toBe(actionLog);
    expect(context.packageDir).toBe('/tmp/forge');
  });

  test('carries no syncEnabled field — the --sync scaffold flag was removed', () => {
    expect(new ForgeContext()).not.toHaveProperty('syncEnabled');
    expect(new ForgeContext({ syncEnabled: true })).not.toHaveProperty('syncEnabled');
  });
});
