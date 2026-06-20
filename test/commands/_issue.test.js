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

  test('read aliases route through the shared issue operation runner for Kernel backends', async () => {
    const calls = [];
    const list = makeAliasCommand('list');

    const result = await list.handler(['--json'], {}, '/repo', {
      useKernelBroker: true,
      runIssueOperation: async (operation, args, projectRoot, deps) => {
        calls.push({ operation, args, projectRoot, deps });
        return { success: true, operation, output: '[]' };
      },
    });

    expect(result).toEqual({ success: true, operation: 'list', output: '[]' });
    expect(calls).toEqual([{
      operation: 'list',
      args: ['--json'],
      projectRoot: '/repo',
      deps: {
        useKernelBroker: true,
        runIssueOperation: expect.any(Function),
      },
    }]);
  });

  test('buildBdArgs maps comment to bd comments add passthrough', () => {
    expect(buildBdArgs('comment', ['forge-abc', 'handoff note']))
      .toEqual(['comments', 'add', 'forge-abc', 'handoff note']);
  });

  test('buildBdArgs maps Kernel contract read commands to Beads-compatible passthroughs', () => {
    expect(buildBdArgs('search', ['kernel contract', '--json']))
      .toEqual(['search', 'kernel contract', '--json']);
    expect(buildBdArgs('stats', ['--json']))
      .toEqual(['status', '--json']);
  });

  test('buildBdArgs maps dependency add and remove to bd dep subcommands', () => {
    expect(buildBdArgs('dep', ['add', 'forge-work', 'forge-blocker']))
      .toEqual(['dep', 'add', 'forge-work', 'forge-blocker']);
    expect(buildBdArgs('dep', ['remove', 'forge-work', 'forge-blocker']))
      .toEqual(['dep', 'remove', 'forge-work', 'forge-blocker']);
    expect(buildBdArgs('dep', ['cycle', 'forge-work'])).toEqual({
      error: 'Unsupported dependency action: cycle. Usage: forge issue dep <add|remove> <issue-id> <blocks-issue-id>',
    });
  });

  test('nested dependency commands route through the shared runner with operation names', async () => {
    const calls = [];
    const issue = require('../../lib/commands/issue');

    const result = await issue.handler(['dep', 'add', 'forge-work', 'forge-blocker'], {}, '/repo', {
      runIssueOperation: async (operation, args, projectRoot, deps) => {
        calls.push({ operation, args, projectRoot, deps });
        return { success: true, operation };
      },
    });

    expect(result).toEqual({ success: true, operation: 'dep.add' });
    expect(calls).toEqual([{
      operation: 'dep.add',
      args: ['forge-work', 'forge-blocker'],
      projectRoot: '/repo',
      deps: {
        runIssueOperation: expect.any(Function),
      },
    }]);
  });

  test('Kernel claim and release commands route to Kernel operations', async () => {
    const calls = [];
    const claim = makeAliasCommand('claim');
    const release = makeAliasCommand('release');
    const opts = {
      useKernelBroker: true,
      runIssueOperation: async (operation, args, projectRoot) => {
        calls.push({ operation, args, projectRoot });
        return { success: true, operation };
      },
    };

    await expect(claim.handler(['forge-abc'], {}, '/repo', opts))
      .resolves.toEqual({ success: true, operation: 'claim' });
    await expect(release.handler(['forge-abc'], {}, '/repo', opts))
      .resolves.toEqual({ success: true, operation: 'release' });

    expect(calls).toEqual([
      { operation: 'claim', args: ['forge-abc'], projectRoot: '/repo' },
      { operation: 'release', args: ['forge-abc'], projectRoot: '/repo' },
    ]);
  });

  test('release command reports Kernel-only behavior without a Kernel backend', async () => {
    const release = makeAliasCommand('release');

    await expect(release.handler(['forge-abc'], {}, '/repo')).resolves.toEqual({
      success: false,
      error: 'forge release <id> is defined for the Kernel issue backend; Beads passthrough has no verified release operation.',
    });
  });
});

describe('issue backend resolution from env/config', () => {
  test('FORGE_ISSUE_BACKEND=kernel injects issueBackend into the runner deps', async () => {
    const calls = [];
    const create = makeAliasCommand('create');

    const result = await create.handler(['--title', 'Smoke'], {}, '/repo', {
      env: { FORGE_ISSUE_BACKEND: 'kernel' },
      runIssueOperation: async (operation, args, projectRoot, deps) => {
        calls.push({ operation, args, projectRoot, deps });
        return { ok: true, command: operation, data: { id: 'k1' } };
      },
    });

    // The kernel contract {ok,data,...} is normalized into the {success,output}
    // shape the CLI result printer understands.
    expect(result.success).toBe(true);
    expect(result.operation).toBe('create');
    expect(JSON.parse(result.output)).toEqual({ id: 'k1' });
    expect(calls).toHaveLength(1);
    expect(calls[0].operation).toBe('create');
    expect(calls[0].deps.issueBackend).toBe('kernel');
  });

  test('no backend signal leaves opts untouched and routes through beads', async () => {
    const calls = [];
    const create = makeAliasCommand('create');

    const result = await create.handler(['--title', 'Smoke'], {}, '/repo', {
      env: {},
      runIssueOperation: async (operation, args, projectRoot, deps) => {
        calls.push({ operation, args, projectRoot, deps });
        return { success: true, operation };
      },
    });

    expect(result).toEqual({ success: true, operation: 'create' });
    expect(calls).toHaveLength(1);
    expect(calls[0].deps).not.toHaveProperty('issueBackend');
  });

  test('an explicit opts.issueBackend is preserved (not overwritten by the resolver)', async () => {
    const calls = [];
    const ready = makeAliasCommand('ready');

    await ready.handler([], {}, '/repo', {
      issueBackend: 'kernel',
      env: { FORGE_ISSUE_BACKEND: 'beads' },
      runIssueOperation: async (operation, args, projectRoot, deps) => {
        calls.push({ deps });
        return { ok: true, command: operation, data: { issues: [] } };
      },
    });

    expect(calls[0].deps.issueBackend).toBe('kernel');
  });

  test('a kernel error contract is normalized into a {success:false,error} result', async () => {
    const show = makeAliasCommand('show');

    const result = await show.handler(['nope'], {}, '/repo', {
      issueBackend: 'kernel',
      env: {},
      runIssueOperation: async (operation) => ({
        ok: false,
        command: operation,
        error: { code: 'FORGE_ISSUE_NOT_FOUND', message: 'Issue nope not found', exit_code: 4, retryable: false },
        next_commands: [],
      }),
    });

    expect(result).toEqual({ success: false, error: 'Issue nope not found' });
  });

  test('a Beads-shaped {success,output} result passes through unchanged', async () => {
    // `create` is a write subcommand, so it always routes through the shared
    // runner — letting us assert the normalizer leaves a {success,output} result
    // byte-identical (only the contract {ok,...} shape is transformed).
    const create = makeAliasCommand('create');

    const result = await create.handler(['--title', 'X'], {}, '/repo', {
      env: {},
      runIssueOperation: async (operation) => ({ success: true, operation, output: 'created', stderr: '' }),
    });

    expect(result).toEqual({ success: true, operation: 'create', output: 'created', stderr: '' });
  });
});
