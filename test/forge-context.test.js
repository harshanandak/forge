'use strict';

const { describe, test, expect } = require('bun:test');

describe('ForgeContext', () => {
  const { ForgeContext } = require('../lib/forge-context');

  test('exports ForgeContext class', () => {
    expect(typeof ForgeContext).toBe('function');
  });

  test('constructor sets defaults when no options given', () => {
    const ctx = new ForgeContext();
    expect(ctx.projectRoot).toBe(process.cwd());
    expect(ctx.forceMode).toBe(false);
    expect(ctx.verboseMode).toBe(false);
    expect(ctx.nonInteractive).toBe(false);
    expect(ctx.symlinkOnly).toBe(false);
    expect(ctx.syncEnabled).toBe(false);
    expect(ctx.pkgManager).toBe('npm');
    expect(Array.isArray(ctx.actionLog)).toBe(true);
    expect(ctx.actionLog.length).toBe(0);
    expect(ctx.packageDir).toBe('');
  });

  test('constructor accepts overrides for every property', () => {
    const log = ['step1'];
    const ctx = new ForgeContext({
      projectRoot: '/my/project',
      forceMode: true,
      verboseMode: true,
      nonInteractive: true,
      symlinkOnly: true,
      syncEnabled: true,
      pkgManager: 'bun',
      actionLog: log,
      packageDir: '/pkg',
    });
    expect(ctx.projectRoot).toBe('/my/project');
    expect(ctx.forceMode).toBe(true);
    expect(ctx.verboseMode).toBe(true);
    expect(ctx.nonInteractive).toBe(true);
    expect(ctx.symlinkOnly).toBe(true);
    expect(ctx.syncEnabled).toBe(true);
    expect(ctx.pkgManager).toBe('bun');
    expect(ctx.actionLog).toBe(log);
    expect(ctx.packageDir).toBe('/pkg');
  });

  test('properties are mutable (can be reassigned after construction)', () => {
    const ctx = new ForgeContext();
    ctx.forceMode = true;
    ctx.pkgManager = 'bun';
    ctx.projectRoot = '/changed';
    expect(ctx.forceMode).toBe(true);
    expect(ctx.pkgManager).toBe('bun');
    expect(ctx.projectRoot).toBe('/changed');
  });

  test('actionLog default is an independent array per instance', () => {
    const a = new ForgeContext();
    const b = new ForgeContext();
    a.actionLog.push('x');
    expect(b.actionLog.length).toBe(0);
  });

  test('partial options only override specified fields', () => {
    const ctx = new ForgeContext({ forceMode: true });
    expect(ctx.forceMode).toBe(true);
    expect(ctx.verboseMode).toBe(false);
    expect(ctx.pkgManager).toBe('npm');
    expect(ctx.projectRoot).toBe(process.cwd());
  });
});
