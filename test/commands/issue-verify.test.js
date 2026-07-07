'use strict';

const { describe, test, expect, beforeEach, afterEach } = require('bun:test');
const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');

const { runIssueSubcommand } = require('../../lib/commands/_issue');
const { getDefaultRuntimeGraph, getResolvedRuntimeGraph } = require('../../lib/core/runtime-graph');

// Check-after-write verification at the _issue.js command boundary
// (kernel issue 5f928cd0, epic 1390e1d1). After a successful kernel mutation the
// boundary re-reads through the SAME injected runner and asserts the intended
// delta landed, emitting `verified` + `mismatches` in the envelope. Warn-mode
// only: a mismatch NEVER turns a successful write into a failure. Justified by
// two proven "ok:true lied" bugs: 145d9ad1 (close --reason/closed_at dropped in
// the kernel_issues projection) and d71a824b (idempotent claim replay telling a
// losing agent it won).
//
// Every test injects a fake runIssueOperation (same seam as the response-contract
// parity tests) so the assertions target the boundary verify loop, not SQLite.

// A recording runner: `handlers` maps operation name -> impl. Calls are recorded
// so tests can assert whether (and how) the read-back happened.
function makeRunner(handlers) {
  const calls = [];
  const runner = async (operation, args, projectRoot, deps) => {
    calls.push({ operation, args });
    const handler = handlers[operation];
    if (!handler) throw new Error(`unexpected operation: ${operation}`);
    return handler(operation, args, projectRoot, deps);
  };
  return { runner, calls };
}

function okEnvelope(command, data) {
  return {
    ok: true,
    schema_version: 'forge.issue.v1',
    command,
    data,
    next_commands: [],
  };
}

const KERNEL_OPTS = (runIssueOperation) => ({ issueBackend: 'kernel', env: {}, runIssueOperation });

// Silence + capture the boundary's console.warn warnings.
let warnings;
const originalWarn = console.warn;
beforeEach(() => {
  warnings = [];
  console.warn = (...args) => { warnings.push(args.join(' ')); };
});
afterEach(() => {
  console.warn = originalWarn;
});

describe('gate.issue_verify registration (runtime graph)', () => {
  test('gate.issue_verify is a default-ON, UNLOCKED gate in the default graph', () => {
    const graph = getDefaultRuntimeGraph();
    const gate = graph.gates.find(candidate => candidate.id === 'gate.issue_verify');
    expect(gate).toBeDefined();
    expect(gate.enabled).toBe(true);
    expect(gate.locked).toBe(false);
    expect(gate.requires).toEqual([]);
  });

  test('workflow.gates["gate.issue_verify"].enabled=false disables it via the resolver (zero new toggle code)', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'forge-issue-verify-'));
    try {
      mkdirSync(path.join(root, '.forge'), { recursive: true });
      writeFileSync(
        path.join(root, '.forge', 'config.yaml'),
        'workflow:\n  gates:\n    gate.issue_verify:\n      enabled: false\n',
      );
      const graph = getResolvedRuntimeGraph({ projectRoot: root });
      const gate = graph.gates.find(candidate => candidate.id === 'gate.issue_verify');
      expect(gate.enabled).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('check-after-write verification (gate.issue_verify, warn mode)', () => {
  // --- create ---------------------------------------------------------------
  test('create: read-back confirms requested title/type -> verified:true, mismatches []', async () => {
    const { runner, calls } = makeRunner({
      create: () => okEnvelope('issue.create', { id: 'k1', revision: 0 }),
      show: () => okEnvelope('issue.show', { id: 'k1', title: 'X', type: 'bug', status: 'open' }),
    });

    const result = await runIssueSubcommand('create', ['--title', 'X', '--type', 'bug', '--json'], '/repo', KERNEL_OPTS(runner));

    expect(result.success).toBe(true);
    const envelope = JSON.parse(result.output);
    expect(envelope.ok).toBe(true);
    expect(envelope.verified).toBe(true);
    expect(envelope.mismatches).toEqual([]);
    expect(calls.map(call => call.operation)).toEqual(['create', 'show']);
    expect(calls[1].args[0]).toBe('k1');
    expect(warnings).toHaveLength(0);
  });

  test('create: read-back missing the requested title -> verified:false + named mismatch, write still succeeds', async () => {
    const { runner } = makeRunner({
      create: () => okEnvelope('issue.create', { id: 'k1', revision: 0 }),
      show: () => okEnvelope('issue.show', { id: 'k1', title: 'k1', type: 'task' }),
    });

    const result = await runIssueSubcommand('create', ['--title', 'X', '--json'], '/repo', KERNEL_OPTS(runner));

    expect(result.success).toBe(true);
    expect(result.exitCode).toBeUndefined();
    const envelope = JSON.parse(result.output);
    expect(envelope.ok).toBe(true);
    expect(envelope.verified).toBe(false);
    expect(envelope.mismatches.some(entry => entry.startsWith('title:'))).toBe(true);
    expect(warnings.length).toBeGreaterThan(0);
    expect(warnings.join('\n')).toContain('gate.issue_verify');
  });

  // --- update ---------------------------------------------------------------
  test('update: requested fields present in the read-back -> verified:true (priority normalized to its P-label)', async () => {
    const { runner } = makeRunner({
      update: () => okEnvelope('issue.update', { id: 'k1', revision: 2 }),
      show: () => okEnvelope('issue.show', { id: 'k1', title: 'T', status: 'in_progress', priority: 'P1' }),
    });

    const result = await runIssueSubcommand(
      'update',
      ['k1', '--status', 'in_progress', '--priority', '1', '--json'],
      '/repo',
      KERNEL_OPTS(runner),
    );

    const envelope = JSON.parse(result.output);
    expect(envelope.verified).toBe(true);
    expect(envelope.mismatches).toEqual([]);
  });

  test('update: a requested field that did not land -> verified:false + named mismatch', async () => {
    const { runner } = makeRunner({
      update: () => okEnvelope('issue.update', { id: 'k1', revision: 2 }),
      show: () => okEnvelope('issue.show', { id: 'k1', status: 'open' }),
    });

    const result = await runIssueSubcommand('update', ['k1', '--status', 'in_progress', '--json'], '/repo', KERNEL_OPTS(runner));

    const envelope = JSON.parse(result.output);
    expect(envelope.verified).toBe(false);
    expect(envelope.mismatches.some(entry => entry.startsWith('status:'))).toBe(true);
    expect(result.success).toBe(true);
  });

  // --- close (regression trap for 145d9ad1) ----------------------------------
  test('close --reason: terminal status + closed_at + close_reason present -> verified:true', async () => {
    const { runner } = makeRunner({
      close: () => okEnvelope('issue.close', { id: 'k1', revision: 3 }),
      show: () => okEnvelope('issue.show', {
        id: 'k1', status: 'done', closed_at: '2026-07-07T00:00:00Z', close_reason: 'shipped',
      }),
    });

    const result = await runIssueSubcommand('close', ['k1', '--reason', 'shipped', '--json'], '/repo', KERNEL_OPTS(runner));

    const envelope = JSON.parse(result.output);
    expect(envelope.verified).toBe(true);
    expect(envelope.mismatches).toEqual([]);
  });

  test('close --reason: projection drops close_reason/closed_at -> verified:false naming both (145d9ad1 trap), exit stays success', async () => {
    const { runner } = makeRunner({
      close: () => okEnvelope('issue.close', { id: 'k1', revision: 3 }),
      show: () => okEnvelope('issue.show', { id: 'k1', status: 'done', closed_at: null, close_reason: null }),
    });

    const result = await runIssueSubcommand('close', ['k1', '--reason', 'shipped', '--json'], '/repo', KERNEL_OPTS(runner));

    expect(result.success).toBe(true);
    expect(result.exitCode).toBeUndefined();
    const envelope = JSON.parse(result.output);
    expect(envelope.ok).toBe(true);
    expect(envelope.verified).toBe(false);
    expect(envelope.mismatches.some(entry => entry.startsWith('closed_at:'))).toBe(true);
    expect(envelope.mismatches.some(entry => entry.startsWith('close_reason:'))).toBe(true);
    expect(warnings.join('\n')).toContain('close_reason');
  });

  test('close: non-terminal status in the read-back -> verified:false', async () => {
    const { runner } = makeRunner({
      close: () => okEnvelope('issue.close', { id: 'k1', revision: 3 }),
      show: () => okEnvelope('issue.show', { id: 'k1', status: 'open', closed_at: '2026-07-07T00:00:00Z' }),
    });

    const result = await runIssueSubcommand('close', ['k1', '--json'], '/repo', KERNEL_OPTS(runner));

    const envelope = JSON.parse(result.output);
    expect(envelope.verified).toBe(false);
    expect(envelope.mismatches.some(entry => entry.startsWith('status:'))).toBe(true);
  });

  // --- claim (regression trap for d71a824b phantom-claim) --------------------
  test('claim: owns confirms the live lease -> verified:true (read-back via owns, not show)', async () => {
    const { runner, calls } = makeRunner({
      claim: () => okEnvelope('claim', { id: 'k1', revision: 0, claim_id: 'lease-1' }),
      owns: () => okEnvelope('issue.owns', { id: 'k1', owned: true, claimed_by: 'agent-a' }),
    });

    const result = await runIssueSubcommand('claim', ['k1', '--json'], '/repo', KERNEL_OPTS(runner));

    const envelope = JSON.parse(result.output);
    expect(envelope.verified).toBe(true);
    expect(envelope.mismatches).toEqual([]);
    expect(calls.map(call => call.operation)).toEqual(['claim', 'owns']);
  });

  test('claim: duplicate-replay ok:true but owns says another actor holds the lease -> verified:false (d71a824b trap)', async () => {
    const { runner } = makeRunner({
      claim: () => okEnvelope('claim', { id: 'k1', revision: 0, claim_id: 'lease-1' }),
      owns: () => okEnvelope('issue.owns', { id: 'k1', owned: false, claimed_by: 'someone-else' }),
    });

    const result = await runIssueSubcommand('claim', ['k1', '--json'], '/repo', KERNEL_OPTS(runner));

    expect(result.success).toBe(true);
    const envelope = JSON.parse(result.output);
    expect(envelope.verified).toBe(false);
    expect(envelope.mismatches.join(' ')).toContain('someone-else');
    expect(warnings.length).toBeGreaterThan(0);
  });

  test('top-level `forge claim` routes through the boundary and is verified (no inlined bypass)', async () => {
    const claimCommand = require('../../lib/commands/claim');
    const { runner, calls } = makeRunner({
      claim: () => okEnvelope('claim', { id: 'k1', revision: 0, claim_id: 'lease-1' }),
      owns: () => okEnvelope('issue.owns', { id: 'k1', owned: true, claimed_by: 'agent-a' }),
    });

    const result = await claimCommand.handler(['k1', '--json'], {}, '/repo', KERNEL_OPTS(runner));

    expect(result.success).toBe(true);
    const envelope = JSON.parse(result.output);
    expect(envelope.verified).toBe(true);
    expect(calls.map(call => call.operation)).toEqual(['claim', 'owns']);
  });

  // --- comment (clean read path: show returns comments with ids) -------------
  test('comment: minted comment_id found in the re-read comments -> verified:true', async () => {
    const { runner } = makeRunner({
      comment: () => okEnvelope('issue.comment', { id: 'k1', revision: 1, comment_id: 'c9' }),
      show: () => okEnvelope('issue.show', { id: 'k1', comments: [{ id: 'c9', body: 'note' }] }),
    });

    const result = await runIssueSubcommand('comment', ['k1', 'note', '--json'], '/repo', KERNEL_OPTS(runner));

    const envelope = JSON.parse(result.output);
    expect(envelope.verified).toBe(true);
  });

  test('comment: minted comment_id missing from the re-read -> verified:false', async () => {
    const { runner } = makeRunner({
      comment: () => okEnvelope('issue.comment', { id: 'k1', revision: 1, comment_id: 'c9' }),
      show: () => okEnvelope('issue.show', { id: 'k1', comments: [] }),
    });

    const result = await runIssueSubcommand('comment', ['k1', 'note', '--json'], '/repo', KERNEL_OPTS(runner));

    const envelope = JSON.parse(result.output);
    expect(envelope.verified).toBe(false);
    expect(envelope.mismatches.join(' ')).toContain('c9');
  });

  // --- kernel batch close: per-id verify -------------------------------------
  test('multi-id close: each closed id is verified; one projection drop flips the envelope to verified:false', async () => {
    const { runner } = makeRunner({
      close: (_operation, args) => okEnvelope('issue.close', { id: args[0], revision: 1 }),
      show: (_operation, args) => (args[0] === 'k1'
        ? okEnvelope('issue.show', { id: 'k1', status: 'done', closed_at: '2026-07-07T00:00:00Z', close_reason: 'batch' })
        : okEnvelope('issue.show', { id: 'k2', status: 'done', closed_at: null, close_reason: null })),
    });

    const result = await runIssueSubcommand('close', ['k1', 'k2', '--reason', 'batch', '--json'], '/repo', KERNEL_OPTS(runner));

    expect(result.success).toBe(true);
    const envelope = JSON.parse(result.output);
    expect(envelope.ok).toBe(true);
    expect(envelope.verified).toBe(false);
    const k1 = envelope.data.results.find(entry => entry.id === 'k1');
    const k2 = envelope.data.results.find(entry => entry.id === 'k2');
    expect(k1.verified).toBe(true);
    expect(k2.verified).toBe(false);
    expect(envelope.mismatches.some(entry => entry.startsWith('k2:'))).toBe(true);
  });

  // --- never break the write path --------------------------------------------
  test('verify read throws -> write still succeeds with verified:null and a warning, mismatches omitted', async () => {
    const { runner } = makeRunner({
      create: () => okEnvelope('issue.create', { id: 'k1', revision: 0 }),
      show: () => { throw new Error('projection read exploded'); },
    });

    const result = await runIssueSubcommand('create', ['--title', 'X', '--json'], '/repo', KERNEL_OPTS(runner));

    expect(result.success).toBe(true);
    const envelope = JSON.parse(result.output);
    expect(envelope.ok).toBe(true);
    expect(envelope.verified).toBe(null);
    expect(envelope.mismatches).toBeUndefined();
    expect(warnings.length).toBeGreaterThan(0);
  });

  test('verify read returns an error contract -> verified:null, write untouched', async () => {
    const { runner } = makeRunner({
      close: () => okEnvelope('issue.close', { id: 'k1', revision: 1 }),
      show: () => ({
        ok: false,
        schema_version: 'forge.issue.error.v1',
        command: 'issue.show',
        error: { code: 'FORGE_ISSUE_NOT_FOUND', message: 'gone', exit_code: 3, retryable: false },
        next_commands: [],
      }),
    });

    const result = await runIssueSubcommand('close', ['k1', '--json'], '/repo', KERNEL_OPTS(runner));

    expect(result.success).toBe(true);
    const envelope = JSON.parse(result.output);
    expect(envelope.verified).toBe(null);
  });

  test('a FAILED mutation is never verified (no read-back, no verified key)', async () => {
    const { runner, calls } = makeRunner({
      close: () => ({
        ok: false,
        schema_version: 'forge.issue.error.v1',
        command: 'issue.close',
        error: { code: 'FORGE_ISSUE_NOT_FOUND', message: 'Issue nope not found', exit_code: 3, retryable: false },
        next_commands: [],
      }),
    });

    const result = await runIssueSubcommand('close', ['nope', '--json'], '/repo', KERNEL_OPTS(runner));

    expect(result.success).toBe(false);
    expect(result.exitCode).toBe(3);
    expect(calls.map(call => call.operation)).toEqual(['close']);
    const envelope = JSON.parse(result.output);
    expect(envelope.verified).toBeUndefined();
  });

  // --- toggle: disabled gate skips the read-back entirely --------------------
  test('disabled gate.issue_verify -> no read-back, envelope has no verified key', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'forge-issue-verify-off-'));
    try {
      mkdirSync(path.join(root, '.forge'), { recursive: true });
      writeFileSync(
        path.join(root, '.forge', 'config.yaml'),
        'workflow:\n  gates:\n    gate.issue_verify:\n      enabled: false\n',
      );
      const { runner, calls } = makeRunner({
        create: () => okEnvelope('issue.create', { id: 'k1', revision: 0 }),
      });

      const result = await runIssueSubcommand('create', ['--title', 'X', '--json'], root, KERNEL_OPTS(runner));

      expect(result.success).toBe(true);
      expect(calls.map(call => call.operation)).toEqual(['create']);
      const envelope = JSON.parse(result.output);
      expect(envelope.verified).toBeUndefined();
      expect(envelope.mismatches).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // --- reads and the Beads path stay untouched --------------------------------
  test('reads (show) are never verified', async () => {
    const { runner, calls } = makeRunner({
      show: () => okEnvelope('issue.show', { id: 'k1', title: 'X' }),
    });

    await runIssueSubcommand('show', ['k1', '--json'], '/repo', KERNEL_OPTS(runner));

    expect(calls.map(call => call.operation)).toEqual(['show']);
  });

  test('the Beads path passes through byte-identical (no verify, no extra ops)', async () => {
    const calls = [];
    const result = await runIssueSubcommand('close', ['forge-abc'], '/repo', {
      env: {},
      runIssueOperation: async (operation) => {
        calls.push(operation);
        return { success: true, operation };
      },
    });

    expect(result).toEqual({ success: true, operation: 'close' });
    expect(calls).toEqual(['close']);
  });
});
