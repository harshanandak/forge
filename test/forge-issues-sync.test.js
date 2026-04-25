'use strict';

const { describe, expect, test } = require('bun:test');

const { createGitHubProjectionPlan } = require('../lib/issue-sync/project-github');

describe('forge issue write sync', () => {
  test('creates a GitHub projection plan only for shared field writes', () => {
    expect(createGitHubProjectionPlan('update', ['forge-1', '--priority', '2'])).toBeNull();
    expect(createGitHubProjectionPlan('close', ['--help'])).toBeNull();

    expect(createGitHubProjectionPlan('update', ['forge-1', '--title', 'Renamed'])).toEqual({
      operation: 'update',
      args: ['forge-1', '--title', 'Renamed'],
      fieldPaths: ['shared.title'],
    });

    expect(createGitHubProjectionPlan('update', ['forge-1', '--title=Renamed'])).toEqual({
      operation: 'update',
      args: ['forge-1', '--title=Renamed'],
      fieldPaths: ['shared.title'],
    });

    expect(createGitHubProjectionPlan('update', ['forge-1', '--labels=bug,triage'])).toEqual({
      operation: 'update',
      args: ['forge-1', '--labels=bug,triage'],
      fieldPaths: ['shared.labels'],
    });

    expect(createGitHubProjectionPlan('update', ['forge-1', '--claim'])).toEqual({
      operation: 'update',
      args: ['forge-1', '--claim'],
      fieldPaths: ['shared.assignees'],
    });
  });

  test('queues outbound projections only after a successful local write', async () => {
    const { runIssueOperation } = require('../lib/forge-issues');
    const calls = [];
    const queued = [];

    const result = await runIssueOperation('update', ['forge-1', '--title', 'Renamed'], '/repo', {
      createService: () => ({
        async run(operation, args, context) {
          calls.push({ phase: 'local', operation, args, context });
          return { success: true, output: 'local write ok' };
        },
      }),
      enqueueGitHubProjection: projection => {
        queued.push(projection);
      },
    });

    expect(result).toEqual({ success: true, output: 'local write ok' });
    expect(calls).toEqual([{
      phase: 'local',
      operation: 'update',
      args: ['forge-1', '--title', 'Renamed'],
      context: {
        projectRoot: '/repo',
        deps: expect.objectContaining({
          createService: expect.any(Function),
          enqueueGitHubProjection: expect.any(Function),
        }),
      },
    }]);
    expect(queued).toEqual([{
      operation: 'update',
      args: ['forge-1', '--title', 'Renamed'],
      fieldPaths: ['shared.title'],
    }]);
  });

  test('does not queue outbound projections for local-only writes', async () => {
    const { runIssueOperation } = require('../lib/forge-issues');
    const queued = [];

    const result = await runIssueOperation('update', ['forge-1', '--priority', '2'], '/repo', {
      createService: () => ({
        async run() {
          return { success: true, output: 'local write ok' };
        },
      }),
      enqueueGitHubProjection: projection => {
        queued.push(projection);
      },
    });

    expect(result).toEqual({ success: true, output: 'local write ok' });
    expect(queued).toEqual([]);
  });

  test('does not queue outbound projections for write help passthrough', async () => {
    const { runIssueOperation } = require('../lib/forge-issues');
    const queued = [];

    const result = await runIssueOperation('close', ['--help'], '/repo', {
      createService: () => ({
        async run() {
          return { success: true, output: 'bd close help output' };
        },
      }),
      enqueueGitHubProjection: projection => {
        queued.push(projection);
      },
    });

    expect(result).toEqual({ success: true, output: 'bd close help output' });
    expect(queued).toEqual([]);
  });
});
