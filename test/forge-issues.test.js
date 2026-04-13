'use strict';

const { describe, test, expect } = require('bun:test');

describe('forge issue service contract', () => {
  test('exports service factory and operation runner', () => {
    const forgeIssues = require('../lib/forge-issues');

    expect(typeof forgeIssues.createIssueService).toBe('function');
    expect(typeof forgeIssues.createBeadsIssueBackend).toBe('function');
    expect(typeof forgeIssues.runIssueOperation).toBe('function');
  });

  test('routes supported operations through the configured backend', async () => {
    const { createIssueService } = require('../lib/forge-issues');
    const calls = [];
    const backend = {
      async create(args, context) {
        calls.push({ operation: 'create', args, context });
        return { success: true, operation: 'create' };
      },
      async list(args, context) {
        calls.push({ operation: 'list', args, context });
        return { success: true, operation: 'list' };
      },
      async show(args, context) {
        calls.push({ operation: 'show', args, context });
        return { success: true, operation: 'show' };
      },
      async close(args, context) {
        calls.push({ operation: 'close', args, context });
        return { success: true, operation: 'close' };
      },
      async update(args, context) {
        calls.push({ operation: 'update', args, context });
        return { success: true, operation: 'update' };
      },
    };

    const service = createIssueService({ backend });
    const context = { projectRoot: '/repo', deps: { source: 'test' } };

    await expect(service.run('create', ['--title', 'Test'], context))
      .resolves.toEqual({ success: true, operation: 'create' });
    await expect(service.run('list', ['--json'], context))
      .resolves.toEqual({ success: true, operation: 'list' });
    await expect(service.run('show', ['forge-123'], context))
      .resolves.toEqual({ success: true, operation: 'show' });
    await expect(service.run('close', ['forge-123'], context))
      .resolves.toEqual({ success: true, operation: 'close' });
    await expect(service.run('update', ['forge-123', '--title', 'Renamed'], context))
      .resolves.toEqual({ success: true, operation: 'update' });

    expect(calls).toHaveLength(5);
    expect(calls[0]).toEqual({
      operation: 'create',
      args: ['--title', 'Test'],
      context,
    });
    expect(calls[4]).toEqual({
      operation: 'update',
      args: ['forge-123', '--title', 'Renamed'],
      context,
    });
  });

  test('rejects unsupported operations with a forge-level error', async () => {
    const { createIssueService } = require('../lib/forge-issues');

    const service = createIssueService({
      backend: {
        async list() {
          return { success: true };
        },
      },
    });

    await expect(service.run('ready', [], { projectRoot: '/repo' })).resolves.toEqual({
      success: false,
      error: 'Unsupported issue operation: ready',
    });
  });

  test('uses dependency injection in the top-level operation runner', async () => {
    const { runIssueOperation } = require('../lib/forge-issues');
    const calls = [];

    const result = await runIssueOperation('show', ['forge-456'], '/repo', {
      createService: () => ({
        async run(operation, args, context) {
          calls.push({ operation, args, context });
          return { success: true, output: 'ok' };
        },
      }),
      marker: 'injected',
    });

    expect(result).toEqual({ success: true, output: 'ok' });
    expect(calls).toEqual([{
      operation: 'show',
      args: ['forge-456'],
      context: {
        projectRoot: '/repo',
        deps: { createService: expect.any(Function), marker: 'injected' },
      },
    }]);
  });

  test('default beads backend rejects issue operations when beads is not initialized', async () => {
    const { createBeadsIssueBackend } = require('../lib/forge-issues');

    const backend = createBeadsIssueBackend({
      isBeadsInitialized: () => false,
    });

    await expect(backend.list([], { projectRoot: '/repo' })).resolves.toEqual({
      success: false,
      error: 'Beads is not initialized in this project. Run forge setup before using forge issues.',
    });
  });

  test('default beads backend executes bd with mapped arguments', async () => {
    const { createBeadsIssueBackend } = require('../lib/forge-issues');
    const calls = [];

    const backend = createBeadsIssueBackend({
      isBeadsInitialized: () => true,
      runBdCommand: async (args, projectRoot) => {
        calls.push({ args, projectRoot });
        return { code: 0, stdout: `mocked ${args[0]} output`, stderr: '' };
      },
    });

    await expect(backend.create(['--title', 'New issue'], { projectRoot: '/repo' }))
      .resolves.toEqual({ success: true, operation: 'create', output: 'mocked create output' });
    await expect(backend.list(['--json'], { projectRoot: '/repo' }))
      .resolves.toEqual({ success: true, operation: 'list', output: 'mocked list output' });
    await expect(backend.show(['forge-1'], { projectRoot: '/repo' }))
      .resolves.toEqual({ success: true, operation: 'show', output: 'mocked show output' });
    await expect(backend.close(['forge-1'], { projectRoot: '/repo' }))
      .resolves.toEqual({ success: true, operation: 'close', output: 'mocked close output' });
    await expect(backend.update(['forge-1', '--title', 'Renamed'], { projectRoot: '/repo' }))
      .resolves.toEqual({ success: true, operation: 'update', output: 'mocked update output' });

    expect(calls).toEqual([
      {
        args: ['create', '--title', 'New issue'],
        projectRoot: '/repo',
      },
      {
        args: ['list', '--json'],
        projectRoot: '/repo',
      },
      {
        args: ['show', 'forge-1'],
        projectRoot: '/repo',
      },
      {
        args: ['close', 'forge-1'],
        projectRoot: '/repo',
      },
      {
        args: ['update', 'forge-1', '--title', 'Renamed'],
        projectRoot: '/repo',
      },
    ]);
  });

  test('default beads backend translates missing bd binary into a forge-level error', async () => {
    const { createBeadsIssueBackend } = require('../lib/forge-issues');

    const backend = createBeadsIssueBackend({
      isBeadsInitialized: () => true,
      runBdCommand: async () => {
        const error = new Error('spawn bd ENOENT');
        error.code = 'ENOENT';
        throw error;
      },
    });

    await expect(backend.show(['forge-1'], { projectRoot: '/repo' })).resolves.toEqual({
      success: false,
      error: 'Beads (bd) command not found. Install or initialize Beads before using forge issues.',
    });
  });

  test('default beads backend treats zero-exit bd soft failures as forge-level errors', async () => {
    const { createBeadsIssueBackend } = require('../lib/forge-issues');

    const backend = createBeadsIssueBackend({
      isBeadsInitialized: () => true,
      runBdCommand: async () => ({
        code: 0,
        stdout: 'Error resolving/updating forge-missing: issue not found',
        stderr: '',
      }),
    });

    await expect(backend.update(['forge-missing', '--title', 'Renamed'], { projectRoot: '/repo' })).resolves.toEqual({
      success: false,
      error: 'Error resolving/updating forge-missing: issue not found',
    });
  });

  test('default beads backend bypasses init checks for bd help passthrough', async () => {
    const { createBeadsIssueBackend } = require('../lib/forge-issues');
    const calls = [];

    const backend = createBeadsIssueBackend({
      isBeadsInitialized: () => false,
      runBdCommand: async (args, projectRoot) => {
        calls.push({ args, projectRoot });
        return {
          code: 0,
          stdout: 'bd create help output',
          stderr: '',
        };
      },
    });

    await expect(backend.create(['--help'], { projectRoot: '/repo' })).resolves.toEqual({
      success: true,
      operation: 'create',
      output: 'bd create help output',
    });

    expect(calls).toEqual([{
      args: ['create', '--help'],
      projectRoot: '/repo',
    }]);
  });
});
