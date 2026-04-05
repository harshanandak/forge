'use strict';

const { describe, test, expect } = require('bun:test');

const issue = require('../../lib/commands/issue');
const create = require('../../lib/commands/create');
const claim = require('../../lib/commands/claim');
const { buildBdArgs } = require('../../lib/commands/_issue');

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

  test('buildBdArgs maps create to bd create passthrough', () => {
    expect(buildBdArgs('create', ['--title', 'Test', '--type', 'feature']))
      .toEqual(['create', '--title', 'Test', '--type', 'feature']);
  });

  test('buildBdArgs maps claim to bd update --claim', () => {
    expect(buildBdArgs('claim', ['forge-abc']))
      .toEqual(['update', 'forge-abc', '--claim']);
  });

  test('buildBdArgs rejects claim without an issue id', () => {
    expect(buildBdArgs('claim', [])).toEqual({
      error: 'Missing issue id. Usage: forge claim <id> [bd-update-flags]',
    });
  });

  test('issue handler dispatches to create subcommand', async () => {
    const calls = [];
    const result = await issue.handler(
      ['create', '--title', 'Test issue', '--type', 'feature'],
      {},
      '/fake/root',
      {
        _exec: (command, args, opts) => {
          calls.push({ command, args, opts });
        },
      }
    );

    expect(result).toEqual({ success: true, subcommand: 'create' });
    expect(calls).toEqual([{
      command: 'bd',
      args: ['create', '--title', 'Test issue', '--type', 'feature'],
      opts: { cwd: '/fake/root', stdio: 'inherit' },
    }]);
  });

  test('claim alias dispatches to bd update --claim', async () => {
    const calls = [];
    const result = await claim.handler(['forge-abc'], {}, '/fake/root', {
      _exec: (command, args, opts) => {
        calls.push({ command, args, opts });
      },
    });

    expect(result).toEqual({ success: true, subcommand: 'claim' });
    expect(calls).toEqual([{
      command: 'bd',
      args: ['update', 'forge-abc', '--claim'],
      opts: { cwd: '/fake/root', stdio: 'inherit' },
    }]);
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
