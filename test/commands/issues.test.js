'use strict';

const { describe, test, expect } = require('bun:test');

describe('forge issues command', () => {
  test('exports the canonical plural issues command module', () => {
    const issues = require('../../lib/commands/issues');

    expect(issues.name).toBe('issues');
    expect(typeof issues.description).toBe('string');
    expect(typeof issues.handler).toBe('function');
    expect(issues.usage).toContain('forge issues');
  });

  test('returns help text when no subcommand is provided', async () => {
    const issues = require('../../lib/commands/issues');

    const result = await issues.handler([], {}, '/repo');

    expect(result.success).toBe(true);
    expect(result.output).toContain('forge issues <subcommand>');
    expect(result.output).toContain('create');
    expect(result.output).toContain('list');
    expect(result.output).toContain('show');
    expect(result.output).toContain('close');
  });

  test('rejects unsupported subcommands with usage guidance', async () => {
    const issues = require('../../lib/commands/issues');

    const result = await issues.handler(['ready'], {}, '/repo');

    expect(result.success).toBe(false);
    expect(result.error).toContain('Unknown issue subcommand');
    expect(result.error).toContain('forge issues <subcommand>');
  });

  test('dispatches create, list, show, and close through the issue service', async () => {
    const issues = require('../../lib/commands/issues');
    const calls = [];
    const runIssueOperation = async (operation, args, projectRoot, deps) => {
      calls.push({ operation, args, projectRoot, deps });
      return { success: true, operation };
    };

    await expect(issues.handler(['create', '--title', 'New'], {}, '/repo', { runIssueOperation }))
      .resolves.toEqual({ success: true, operation: 'create' });
    await expect(issues.handler(['list', '--json'], {}, '/repo', { runIssueOperation }))
      .resolves.toEqual({ success: true, operation: 'list' });
    await expect(issues.handler(['show', 'forge-1'], {}, '/repo', { runIssueOperation }))
      .resolves.toEqual({ success: true, operation: 'show' });
    await expect(issues.handler(['close', 'forge-1'], {}, '/repo', { runIssueOperation }))
      .resolves.toEqual({ success: true, operation: 'close' });

    expect(calls).toHaveLength(4);
    expect(calls[0]).toEqual({
      operation: 'create',
      args: ['--title', 'New'],
      projectRoot: '/repo',
      deps: { runIssueOperation },
    });
    expect(calls[3]).toEqual({
      operation: 'close',
      args: ['forge-1'],
      projectRoot: '/repo',
      deps: { runIssueOperation },
    });
  });
});
