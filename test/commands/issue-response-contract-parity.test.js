'use strict';

const { describe, test, expect } = require('bun:test');

const { runIssueSubcommand } = require('../../lib/commands/_issue');

// Response-contract parity regressions at the CLI seam (bin/forge.js -> _issue.js).
// The broker already returns the canonical issue-command-contract envelopes
// ({ ok, schema_version, command, data|error, next_commands }); these tests pin the
// CLI normalizer that converts them into the {success,output} shape the bin printer
// consumes. Two confirmed divergences from the Beads behavior the Kernel replaced:
//
//   BUG A — a failed kernel command collapsed to a plain { success:false, error }
//           (no forge.issue.error.v1 envelope on --json, exit code always 1).
//   BUG B — a successful envelope dropped `ok:true`, and a multi-id close returned a
//           BARE ARRAY instead of a single forge.issue.v1 envelope.
//
// Each test injects a fake runIssueOperation returning the broker contract shape so
// the assertions target the normalizer/aggregator, not the SQLite driver.
const KERNEL_OPTS = (runIssueOperation) => ({ issueBackend: 'kernel', runIssueOperation });

describe('kernel CLI response-contract parity (BUG A/B)', () => {
  // --- BUG B part 1: success envelope carries ok:true -----------------------
  test('a successful kernel mutation envelope sets ok:true in the printed output', async () => {
    const result = await runIssueSubcommand('create', ['--title', 'X', '--json'], '/repo', KERNEL_OPTS(
      async () => ({
        ok: true,
        schema_version: 'forge.issue.v1',
        command: 'issue.create',
        data: { id: 'k1', revision: 0 },
        next_commands: [],
      }),
    ));

    expect(result.success).toBe(true);
    const envelope = JSON.parse(result.output);
    expect(envelope.ok).toBe(true);
    expect(envelope.schema_version).toBe('forge.issue.v1');
    expect(envelope.command).toBe('issue.create');
    expect(envelope.data).toEqual({ id: 'k1', revision: 0 });
  });

  // --- BUG A: error envelope on --json + contract exit code -----------------
  test('a kernel error on --json emits the forge.issue.error.v1 envelope + propagates exit_code', async () => {
    const result = await runIssueSubcommand('close', ['nope', '--json'], '/repo', KERNEL_OPTS(
      async () => ({
        ok: false,
        schema_version: 'forge.issue.error.v1',
        command: 'issue.close',
        error: { code: 'FORGE_ISSUE_NOT_FOUND', message: 'Issue nope not found', exit_code: 3, retryable: false },
        next_commands: [],
      }),
    ));

    expect(result.success).toBe(false);
    expect(result.exitCode).toBe(3);
    const envelope = JSON.parse(result.output);
    expect(envelope.ok).toBe(false);
    expect(envelope.schema_version).toBe('forge.issue.error.v1');
    expect(envelope.command).toBe('issue.close');
    expect(envelope.error.code).toBe('FORGE_ISSUE_NOT_FOUND');
    expect(envelope.error.exit_code).toBe(3);
    expect(envelope.error.message).toBe('Issue nope not found');
  });

  test('a kernel error without --json propagates exit_code but emits no JSON envelope', async () => {
    const result = await runIssueSubcommand('close', ['nope'], '/repo', KERNEL_OPTS(
      async () => ({
        ok: false,
        schema_version: 'forge.issue.error.v1',
        command: 'issue.close',
        error: { code: 'FORGE_ISSUE_VALIDATION', message: 'bad input', exit_code: 6, retryable: false },
        next_commands: [],
      }),
    ));

    expect(result.success).toBe(false);
    expect(result.exitCode).toBe(6);
    expect(result.error).toBe('bad input');
    expect(result.output).toBeUndefined();
  });

  // --- BUG B part 2: multi-id close is ONE envelope, not a bare array -------
  test('multi-id kernel close returns a single forge.issue.v1 envelope (not a bare array)', async () => {
    const result = await runIssueSubcommand('close', ['k1', 'k2', '--json'], '/repo', KERNEL_OPTS(
      async (operation, args) => ({
        ok: true,
        schema_version: 'forge.issue.v1',
        command: 'issue.close',
        data: { id: args[0], revision: 1 },
        next_commands: [],
      }),
    ));

    expect(result.success).toBe(true);
    const envelope = JSON.parse(result.output);
    expect(Array.isArray(envelope)).toBe(false);
    expect(envelope.ok).toBe(true);
    expect(envelope.schema_version).toBe('forge.issue.v1');
    expect(envelope.command).toBe('issue.close');
    expect(Array.isArray(envelope.data.results)).toBe(true);
    expect(envelope.data.results.map(entry => entry.id)).toEqual(['k1', 'k2']);
    expect(envelope.data.results.every(entry => entry.ok === true)).toBe(true);
    expect(envelope.data.closed).toEqual(['k1', 'k2']);
  });

  test('multi-id kernel close with one failure: ok:false, per-id error, exit code propagated', async () => {
    const result = await runIssueSubcommand('close', ['k1', 'k2', '--json'], '/repo', KERNEL_OPTS(
      async (operation, args) => {
        if (args[0] === 'k2') {
          return {
            ok: false,
            schema_version: 'forge.issue.error.v1',
            command: 'issue.close',
            error: { code: 'FORGE_ISSUE_NOT_FOUND', message: 'Issue k2 not found', exit_code: 3, retryable: false },
            next_commands: [],
          };
        }
        return {
          ok: true,
          schema_version: 'forge.issue.v1',
          command: 'issue.close',
          data: { id: args[0], revision: 1 },
          next_commands: [],
        };
      },
    ));

    expect(result.success).toBe(false);
    expect(result.exitCode).toBe(3);
    const envelope = JSON.parse(result.output);
    expect(envelope.ok).toBe(false);
    expect(envelope.command).toBe('issue.close');
    const k1 = envelope.data.results.find(entry => entry.id === 'k1');
    const k2 = envelope.data.results.find(entry => entry.id === 'k2');
    expect(k1.ok).toBe(true);
    expect(k2.ok).toBe(false);
    expect(k2.error.code).toBe('FORGE_ISSUE_NOT_FOUND');
    expect(envelope.data.closed).toEqual(['k1']);
  });
});
