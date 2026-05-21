'use strict';

const { describe, expect, test } = require('bun:test');

describe('BeadsIssueAdapter', () => {
  test('implements the IssueAdapter contract', () => {
    const { validateIssueAdapter } = require('../lib/issue-adapter');
    const { BeadsIssueAdapter } = require('../lib/adapters/beads-issue-adapter');

    const adapter = new BeadsIssueAdapter();
    expect(adapter.id).toBe('beads');
    expect(adapter.kind).toBe('issue');
    expect(validateIssueAdapter(adapter)).toEqual({ valid: true, errors: [] });
  });

  test('delegates issue operations to the Beads command surface', async () => {
    const { BeadsIssueAdapter } = require('../lib/adapters/beads-issue-adapter');
    const calls = [];
    const adapter = new BeadsIssueAdapter({
      runBeadsOperation: async (operation, args, context, deps) => {
        calls.push({ operation, args, context, deps });
        return { success: true, operation, output: `${operation}:ok` };
      },
    });
    const context = { projectRoot: '/repo', deps: { marker: 'test' } };

    await expect(adapter.create(['Issue title'], context)).resolves.toMatchObject({ operation: 'create' });
    await expect(adapter.list(['--json'], context)).resolves.toMatchObject({ operation: 'list' });
    await expect(adapter.read(['forge-1'], context)).resolves.toMatchObject({ operation: 'show' });
    await expect(adapter.update(['forge-1', '--title', 'Renamed'], context)).resolves.toMatchObject({ operation: 'update' });
    await expect(adapter.close(['forge-1'], context)).resolves.toMatchObject({ operation: 'close' });
    await expect(adapter.comment(['forge-1', 'note'], context)).resolves.toMatchObject({ operation: 'comment' });

    expect(calls.map(call => [call.operation, call.args])).toEqual([
      ['create', ['Issue title']],
      ['list', ['--json']],
      ['show', ['forge-1']],
      ['update', ['forge-1', '--title', 'Renamed']],
      ['close', ['forge-1']],
      ['comment', ['forge-1', 'note']],
    ]);
    expect(calls[0].context).toBe(context);
    expect(calls[0].deps).toEqual({ marker: 'test' });
  });

  test('requires a configured Beads operation runner', () => {
    const { BeadsIssueAdapter } = require('../lib/adapters/beads-issue-adapter');
    const adapter = new BeadsIssueAdapter();

    expect(() => adapter.run('list')).toThrow(TypeError);
    expect(() => adapter.run('list')).toThrow('runBeadsOperation is not configured on this adapter');
  });

  test('maps comments to bd comments add arguments in the default Beads backend', async () => {
    const { createBeadsIssueBackend } = require('../lib/forge-issues');
    const calls = [];
    const backend = createBeadsIssueBackend({
      isBeadsInitialized: () => true,
      runBdCommand: async (args, projectRoot) => {
        calls.push({ args, projectRoot });
        return { code: 0, stdout: 'comment added', stderr: '' };
      },
    });

    await expect(backend.comment(['forge-1', 'handoff note'], { projectRoot: '/repo' })).resolves.toEqual({
      success: true,
      operation: 'comment',
      output: 'comment added',
      stderr: '',
    });
    expect(calls).toEqual([{
      args: ['comments', 'add', 'forge-1', 'handoff note'],
      projectRoot: '/repo',
    }]);
  });

  test('top-level issue service uses BeadsIssueAdapter by default', async () => {
    const { runIssueOperation } = require('../lib/forge-issues');
    const calls = [];

    const result = await runIssueOperation('show', ['forge-1'], '/repo', {
      isBeadsInitialized: () => true,
      runBdCommand: async (args, projectRoot) => {
        calls.push({ args, projectRoot });
        return { code: 0, stdout: '{"id":"forge-1"}', stderr: '' };
      },
    });

    expect(result).toEqual({
      success: true,
      operation: 'show',
      output: '{"id":"forge-1"}',
      stderr: '',
    });
    expect(calls).toEqual([{ args: ['show', 'forge-1'], projectRoot: '/repo' }]);
  });
});
