'use strict';

const { describe, test, expect } = require('bun:test');

const claims = require('../../lib/commands/claims');

// Issue 7dc229d4: `forge claims` is the active-lease read alias. It routes through
// the shared runIssueOperation seam with the `claims` operation (like blocked/stale),
// so the kernel driver's active-lease read is what ultimately answers it.
describe('forge claims command', () => {
  test('exports the claims alias command', () => {
    expect(claims.name).toBe('claims');
    expect(typeof claims.description).toBe('string');
    expect(typeof claims.handler).toBe('function');
  });

  test('routes through the shared issue operation runner with the claims op', async () => {
    const calls = [];

    const result = await claims.handler(['--json'], {}, '/repo', {
      useKernelBroker: true,
      runIssueOperation: async (operation, args, projectRoot, deps) => {
        calls.push({ operation, args, projectRoot, deps });
        return {
          ok: true,
          schema_version: 'forge.issue.v1',
          command: 'issue.claims',
          data: { claims: [], count: 0 },
          next_commands: [],
        };
      },
    });

    expect(result.success).toBe(true);
    expect(result.operation).toBe('claims');
    expect(calls).toHaveLength(1);
    expect(calls[0].operation).toBe('claims');
    expect(calls[0].args).toEqual(['--json']);
  });
});
