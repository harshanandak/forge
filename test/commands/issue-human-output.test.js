'use strict';

// Kernel issue a9bbd065 (0.1.0 critical path): `forge ready`, `forge list`, and
// `forge show` default to a HUMAN-readable text rendering; the forge.issue.v1
// JSON contract is opt-in via --json (or FORGE_JSON=1). This is a deliberate,
// maintainer-approved breaking change to the default output ahead of the 0.1.0
// API freeze — the kernel contract itself is byte-identical behind --json.

const { describe, test, expect } = require('bun:test');

const { createIssueSubcommand } = require('../../lib/commands/_issue');

const UUID = 'a9bbd065-cbbc-43a4-879d-ae49ab265992';

const READY_ENVELOPE = {
  ok: true,
  schema_version: 'forge.issue.v1',
  command: 'issue.ready',
  data: {
    issues: [
      { id: UUID, title: 'Human-first output', type: 'task', status: 'open', priority: 'P1' },
    ],
    count: 1,
  },
  next_commands: ['forge issue claim <id>'],
};

function kernelOpts(envelope, env = {}) {
  return {
    issueBackend: 'kernel',
    env,
    runIssueOperation: async (operation) => ({ ...envelope, command: `issue.${operation}` }),
  };
}

describe('human-first default output (ready/list/show)', () => {
  test('ready without --json renders text, not the JSON envelope', async () => {
    const ready = createIssueSubcommand('ready');
    const result = await ready.handler([], {}, '/repo', kernelOpts(READY_ENVELOPE));

    expect(result.success).toBe(true);
    expect(result.output).toContain('a9bbd065');
    expect(result.output).toContain('Human-first output');
    expect(result.output).not.toContain('"schema_version"');
    expect(() => JSON.parse(result.output)).toThrow();
  });

  test('ready with --json keeps the exact forge.issue.v1 envelope', async () => {
    const ready = createIssueSubcommand('ready');
    const result = await ready.handler(['--json'], {}, '/repo', kernelOpts(READY_ENVELOPE));

    const parsed = JSON.parse(result.output);
    expect(parsed.ok).toBe(true);
    expect(parsed.schema_version).toBe('forge.issue.v1');
    expect(parsed.command).toBe('issue.ready');
    expect(parsed.data.issues).toHaveLength(1);
    expect(parsed.next_commands).toEqual(['forge issue claim <id>']);
  });

  test('FORGE_JSON=1 restores the contract output without a flag', async () => {
    const ready = createIssueSubcommand('ready');
    const result = await ready.handler([], {}, '/repo', kernelOpts(READY_ENVELOPE, { FORGE_JSON: '1' }));

    const parsed = JSON.parse(result.output);
    expect(parsed.schema_version).toBe('forge.issue.v1');
  });

  test('list without --json renders text', async () => {
    const list = createIssueSubcommand('list');
    const result = await list.handler([], {}, '/repo', kernelOpts({
      ...READY_ENVELOPE,
      command: 'issue.list',
    }));

    expect(result.output).toContain('Human-first output');
    expect(result.output).not.toContain('"schema_version"');
  });

  test('show without --json renders the detail view with the FULL id', async () => {
    const show = createIssueSubcommand('show');
    const result = await show.handler([UUID], {}, '/repo', kernelOpts({
      ok: true,
      schema_version: 'forge.issue.v1',
      command: 'issue.show',
      data: {
        id: UUID,
        title: 'Human-first output',
        body: 'Body text.',
        type: 'task',
        status: 'open',
        priority: 'P1',
        labels: [],
        dependencies: [],
        dependents: [],
        blocked: false,
        claimed_by: null,
        comments: [],
      },
      next_commands: [],
    }));

    expect(result.output).toContain(UUID);
    expect(result.output).toContain('Body text.');
    expect(result.output).not.toContain('"schema_version"');
  });

  test('a verified:false read-back surfaces a WARNING line in human mode', async () => {
    const show = createIssueSubcommand('show');
    const result = await show.handler([UUID], {}, '/repo', kernelOpts({
      ok: true,
      schema_version: 'forge.issue.v1',
      command: 'issue.show',
      data: { id: UUID, title: 'T', type: 'task', status: 'open', priority: 'P1' },
      next_commands: [],
      verified: false,
      mismatches: ['title: expected "A", read back "B"'],
    }));

    expect(result.output).toContain('WARNING');
    expect(result.output).toContain('read back "B"');
  });

  test('mutations keep the JSON envelope when NON-interactive (scripts/pipes get the contract)', async () => {
    const create = createIssueSubcommand('create');
    const result = await create.handler(['--title', 'X'], {}, '/repo', {
      issueBackend: 'kernel',
      env: {},
      isInteractive: false, // piped / CI → machine-parseable envelope (842a8be7)
      resolveRuntimeGraph: () => ({ gates: [{ id: 'gate.issue_verify', enabled: false }] }),
      runIssueOperation: async () => ({
        ok: true,
        schema_version: 'forge.issue.v1',
        command: 'issue.create',
        data: { id: UUID },
        next_commands: [],
      }),
    });

    const parsed = JSON.parse(result.output);
    expect(parsed.command).toBe('issue.create');
  });

  test('mutations render a human confirmation when INTERACTIVE (TTY)', async () => {
    const create = createIssueSubcommand('create');
    const result = await create.handler(['--title', 'X'], {}, '/repo', {
      issueBackend: 'kernel',
      env: {},
      isInteractive: true, // interactive terminal → clean confirmation, not raw JSON
      resolveRuntimeGraph: () => ({ gates: [{ id: 'gate.issue_verify', enabled: false }] }),
      runIssueOperation: async () => ({
        ok: true,
        schema_version: 'forge.issue.v1',
        command: 'issue.create',
        data: { id: UUID, title: 'X' },
        next_commands: [],
      }),
    });

    expect(result.output).toContain('✓ Created');
    // The confirmation uses the readable handle `<slug>-<short-id>` (kernel 1db53c60),
    // so it carries the 8-char short id rather than the full UUID.
    expect(result.output).toContain(`x-${UUID.slice(0, 8)}`);
    expect(() => JSON.parse(result.output)).toThrow(); // not JSON in interactive mode
  });

  test('a Beads-shaped {success,output} read result still passes through unchanged', async () => {
    const list = createIssueSubcommand('list');
    const result = await list.handler([], {}, '/repo', {
      env: {},
      runIssueOperation: async () => ({ success: true, output: 'beads text' }),
    });

    expect(result).toEqual({ success: true, output: 'beads text' });
  });
});
