'use strict';

const { describe, test, expect } = require('bun:test');

const {
  normalizeIssueResult,
  makeAliasCommand,
} = require('../../lib/commands/_issue');

const TIMEOUT = 5000;

describe('normalizeIssueResult — kernel envelope → dispatcher shape', () => {
  test('maps ok:true to success:true and renders data as output', () => {
    const raw = {
      ok: true,
      schema_version: '1.0.0',
      command: 'issue.close',
      data: { id: 'kap-10', revision: 2 },
      next_commands: [{ command: 'issue.show', args: ['kap-10'] }],
    };

    const result = normalizeIssueResult(raw);

    expect(result.success).toBe(true);
    expect(typeof result.output).toBe('string');
    expect(result.output).toContain('kap-10');
    // Envelope must be preserved (contract: never drop next_commands/schema_version).
    expect(result._envelope).toBe(raw);
    expect(result._envelope.next_commands).toEqual(raw.next_commands);
    expect(result._envelope.schema_version).toBe('1.0.0');
  });

  test('maps ok:false to success:false with the kernel error message', () => {
    const raw = {
      ok: false,
      schema_version: '1.0.0',
      command: 'issue.close',
      error: { message: 'revision conflict', code: 'conflict' },
      next_commands: [],
    };

    const result = normalizeIssueResult(raw);

    expect(result.success).toBe(false);
    expect(result.error).toBe('revision conflict');
    expect(result._envelope).toBe(raw);
  });

  test('beads-shaped { success, output } passes through unchanged', () => {
    const raw = { success: true, output: 'closed forge-abc', operation: 'close' };
    const result = normalizeIssueResult(raw);
    expect(result).toBe(raw);
  });

  test('a beads failure { success:false, error } passes through unchanged', () => {
    const raw = { success: false, error: 'bd not initialized' };
    const result = normalizeIssueResult(raw);
    expect(result).toBe(raw);
  });

  test('null/undefined input is returned as-is (no throw)', () => {
    expect(normalizeIssueResult(undefined)).toBeUndefined();
    expect(normalizeIssueResult(null)).toBeNull();
  });

  test('renders the full envelope as JSON output when --json semantics requested', () => {
    const raw = {
      ok: true,
      schema_version: '1.0.0',
      command: 'issue.show',
      data: { id: 'kap-10', status: 'open' },
      next_commands: [],
    };
    const result = normalizeIssueResult(raw, { json: true });
    const parsed = JSON.parse(result.output);
    expect(parsed.schema_version).toBe('1.0.0');
    expect(parsed.next_commands).toEqual([]);
    expect(parsed.data.id).toBe('kap-10');
  });
});

describe('runIssueSubcommand routes kernel returns through the shim', () => {
  test(
    'kernel close return is normalized to dispatcher shape',
    async () => {
      const close = makeAliasCommand('close');
      const envelope = {
        ok: true,
        schema_version: '1.0.0',
        command: 'issue.close',
        data: { id: 'kap-10', revision: 1 },
        next_commands: [],
      };

      const result = await close.handler(['kap-10'], {}, '/repo', {
        useKernelBroker: true,
        runIssueOperation: async () => envelope,
      });

      expect(result.success).toBe(true);
      expect(result._envelope).toBe(envelope);
    },
    TIMEOUT,
  );

  test(
    'beads close return is untouched (no kernel backend)',
    async () => {
      const close = makeAliasCommand('close');
      const result = await close.handler(['forge-abc'], {}, '/repo', {
        runIssueOperation: async () => ({ success: true, operation: 'close' }),
      });
      expect(result).toEqual({ success: true, operation: 'close' });
    },
    TIMEOUT,
  );
});
