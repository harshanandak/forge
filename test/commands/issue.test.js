'use strict';

const { describe, test, expect } = require('bun:test');

const issue = require('../../lib/commands/issue');
const create = require('../../lib/commands/create');
const claim = require('../../lib/commands/claim');
const comment = require('../../lib/commands/comment');
const release = require('../../lib/commands/release');
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

  test('exports top-level comment alias', () => {
    expect(comment.name).toBe('comment');
    expect(typeof comment.handler).toBe('function');
  });

  test('exports top-level release alias', () => {
    expect(release.name).toBe('release');
    expect(typeof release.handler).toBe('function');
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

  test('claim alias dispatches the claim operation through the shared runner', async () => {
    // De-bead: the claim->`update --claim` translation moved into the beads backend
    // (test/forge-issues.test.js). At the command surface, claim routes the `claim`
    // operation with the raw args; the active backend performs any translation.
    const calls = [];
    const result = await claim.handler(['forge-abc'], {}, '/fake/root', {
      runIssueOperation: async (operation, args, projectRoot) => {
        calls.push({ operation, args, projectRoot });
        return { success: true, subcommand: 'claim' };
      },
    });

    expect(result).toEqual({ success: true, subcommand: 'claim' });
    expect(calls).toEqual([{
      operation: 'claim',
      args: ['forge-abc'],
      projectRoot: '/fake/root',
    }]);
  });

  test('issue handler returns help text as success', async () => {
    const result = await issue.handler([], {}, '/fake/root');

    expect(result.success).toBe(true);
    expect(result.output).toContain('forge issue <subcommand>');
    expect(result.output).toContain('search');
    expect(result.output).toContain('stats');
    expect(result.output).toContain('dep');
  });

  test('issue handler returns help for invalid subcommand', async () => {
    const result = await issue.handler(['explode'], {}, '/fake/root');

    expect(result.success).toBe(false);
    expect(result.error).toContain('Unknown issue subcommand');
    expect(result.error).toContain('forge issue <subcommand>');
  });

  test('issue handler surfaces a backend error (e.g. missing bd binary) clearly', async () => {
    // The bd-binary handling now lives in the beads backend (forge-issues runBdCommand
    // / extractErrorMessage); the command surface simply propagates the backend's
    // {success:false,error}. Inject the runner to assert the error reaches the caller.
    const result = await issue.handler(['list'], {}, '/fake/root', {
      runIssueOperation: async () => ({
        success: false,
        error: 'Beads (bd) command not found. Install or initialize Beads before using forge issues.',
      }),
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('Beads (bd) command not found');
  });
});
