'use strict';

const { describe, test, expect } = require('bun:test');

const issue = require('../../lib/commands/issue');
const create = require('../../lib/commands/create');
const claim = require('../../lib/commands/claim');
describe('forge issue command surface', () => {
  test('exports the canonical issue command module', () => {
    expect(issue.name).toBe('issue');
    expect(typeof issue.description).toBe('string');
    expect(typeof issue.handler).toBe('function');
  });

  test('exports top-level create alias', () => {
    expect(create.name).toBe('create');
    expect(typeof create.handler).toBe('function');
  });

  test('exports top-level claim alias', () => {
    expect(claim.name).toBe('claim');
    expect(typeof claim.handler).toBe('function');
  });

  test('issue handler dispatches to create subcommand', async () => {
    const calls = [];
    const result = await issue.handler(
      ['create', '--title', 'Test issue', '--type', 'feature'],
      {},
      '/fake/root',
      {
        runIssueOperation: async (operation, args, projectRoot) => {
          calls.push({ operation, args, projectRoot });
          return { success: true, subcommand: 'create' };
        },
      }
    );

    expect(result).toEqual({ success: true, subcommand: 'create' });
    expect(calls).toEqual([{
      operation: 'create',
      args: ['--title', 'Test issue', '--type', 'feature'],
      projectRoot: '/fake/root',
    }]);
  });

  test('claim alias dispatches to bd update --claim', async () => {
    const calls = [];
    const result = await claim.handler(['forge-abc'], {}, '/fake/root', {
      runIssueOperation: async (operation, args, projectRoot) => {
        calls.push({ operation, args, projectRoot });
        return { success: true, subcommand: 'claim' };
      },
    });

    expect(result).toEqual({ success: true, subcommand: 'claim' });
    expect(calls).toEqual([{
      operation: 'update',
      args: ['forge-abc', '--claim'],
      projectRoot: '/fake/root',
    }]);
  });

  test('issue handler returns help text as success', async () => {
    const result = await issue.handler([], {}, '/fake/root');

    expect(result.success).toBe(true);
    expect(result.output).toContain('forge issue <subcommand>');
  });

  test('issue handler returns help for invalid subcommand', async () => {
    const result = await issue.handler(['explode'], {}, '/fake/root');

    expect(result.success).toBe(false);
    expect(result.error).toContain('Unknown issue subcommand');
    expect(result.error).toContain('forge issue <subcommand>');
  });

  test('issue handler surfaces missing bd binary clearly', async () => {
    const result = await issue.handler(['list'], {}, '/fake/root', {
      _exec: () => {
        const error = new Error('spawn bd ENOENT');
        error.code = 'ENOENT';
        throw error;
      },
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('Beads (bd) command not found');
  });
});
