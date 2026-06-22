'use strict';

const { describe, test, expect } = require('bun:test');

const { makeAliasCommand } = require('../../lib/commands/_issue');

const TIMEOUT = 5000;

function kernelOk(id) {
  return {
    ok: true,
    schema_version: '1.0.0',
    command: 'issue.close',
    data: { id, revision: 1 },
    next_commands: [],
  };
}

describe('B4a — kernel multi-id close loop (kernel-gated)', () => {
  test(
    'forge close a b c --kernel issues one kernel close per id, each with the id',
    async () => {
      const calls = [];
      const close = makeAliasCommand('close');

      const result = await close.handler(
        ['kap-10', 'kap-11', 'kap-12', '--reason=done'],
        {},
        '/repo',
        {
          useKernelBroker: true,
          runIssueOperation: async (operation, args) => {
            calls.push({ operation, args });
            const id = args.find(a => typeof a === 'string' && !a.startsWith('-'));
            return kernelOk(id);
          },
        },
      );

      // Three separate kernel close events — one per id.
      expect(calls).toHaveLength(3);
      expect(calls.map(c => c.operation)).toEqual(['close', 'close', 'close']);
      const closedIds = calls.map(c => c.args.find(a => !a.startsWith('-')));
      expect(closedIds).toEqual(['kap-10', 'kap-11', 'kap-12']);

      // Aggregate success because all three succeeded.
      expect(result.success).toBe(true);
      // Every id's envelope is preserved (not just the last).
      expect(Array.isArray(result._envelopes)).toBe(true);
      expect(result._envelopes).toHaveLength(3);
    },
    TIMEOUT,
  );

  test(
    'the --reason token rides along to EVERY per-id close call',
    async () => {
      const calls = [];
      const close = makeAliasCommand('close');

      await close.handler(
        ['kap-10', 'kap-11', '--reason=Merged on master'],
        {},
        '/repo',
        {
          useKernelBroker: true,
          runIssueOperation: async (operation, args) => {
            calls.push(args);
            const id = args.find(a => typeof a === 'string' && !a.startsWith('-'));
            return kernelOk(id);
          },
        },
      );

      // Each per-id call must carry the reason flag, not only the first.
      for (const args of calls) {
        const joined = args.join(' ');
        expect(joined).toContain('--reason');
        expect(joined).toContain('Merged on master');
      }
    },
    TIMEOUT,
  );

  test(
    'partial failure surfaces per-id errors and overall failure',
    async () => {
      const close = makeAliasCommand('close');

      const result = await close.handler(
        ['kap-10', 'kap-11', 'kap-12'],
        {},
        '/repo',
        {
          useKernelBroker: true,
          runIssueOperation: async (operation, args) => {
            const id = args.find(a => typeof a === 'string' && !a.startsWith('-'));
            if (id === 'kap-11') {
              return {
                ok: false,
                schema_version: '1.0.0',
                command: 'issue.close',
                error: { message: 'revision conflict on kap-11' },
                next_commands: [],
              };
            }
            return kernelOk(id);
          },
        },
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('kap-11');
    },
    TIMEOUT,
  );

  test(
    'single-id kernel close still works (no loop regression)',
    async () => {
      const calls = [];
      const close = makeAliasCommand('close');
      const result = await close.handler(['kap-10', '--reason=x'], {}, '/repo', {
        useKernelBroker: true,
        runIssueOperation: async (operation, args) => {
          calls.push(args);
          return kernelOk('kap-10');
        },
      });
      expect(calls).toHaveLength(1);
      expect(result.success).toBe(true);
    },
    TIMEOUT,
  );
});

describe('B4a — beads regression guard (loop MUST NOT apply to beads)', () => {
  test(
    'beads close a b c results in ONE runIssueOperation call with all ids',
    async () => {
      const calls = [];
      const close = makeAliasCommand('close');

      await close.handler(['forge-a', 'forge-b', 'forge-c'], {}, '/repo', {
        // No kernel backend → beads path. close is a WRITE op so it routes to
        // runIssueOperation, but bd fans out internally: ONE spawn for all ids.
        runIssueOperation: async (operation, args) => {
          calls.push({ operation, args });
          return { success: true, operation };
        },
      });

      expect(calls).toHaveLength(1);
      expect(calls[0].args).toEqual(['forge-a', 'forge-b', 'forge-c']);
    },
    TIMEOUT,
  );
});
