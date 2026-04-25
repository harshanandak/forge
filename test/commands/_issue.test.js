'use strict';

const { describe, test, expect } = require('bun:test');

const { buildBdArgs, makeAliasCommand } = require('../../lib/commands/_issue');

describe('forge issue helpers', () => {
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

  test('claim alias routes through the shared issue operation runner', async () => {
    const calls = [];
    const claim = makeAliasCommand('claim');

    const result = await claim.handler(['forge-abc'], {}, '/repo', {
      runIssueOperation: async (operation, args, projectRoot, deps) => {
        calls.push({ operation, args, projectRoot, deps });
        return { success: true, operation };
      },
    });

    expect(result).toEqual({ success: true, operation: 'update' });
    expect(calls).toEqual([{
      operation: 'update',
      args: ['forge-abc', '--claim'],
      projectRoot: '/repo',
      deps: {
        runIssueOperation: expect.any(Function),
      },
    }]);
  });
});
