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

  test('preserves backend method binding during operation dispatch', async () => {
    const { createIssueService } = require('../lib/forge-issues');

    class TestBackend {
      constructor() {
        this.prefix = 'backend-bound';
      }

      async show(args) {
        return {
          success: true,
          output: `${this.prefix}:${args[0]}`,
        };
      }
    }

    const service = createIssueService({ backend: new TestBackend() });

    await expect(service.run('show', ['forge-123'], { projectRoot: '/repo' })).resolves.toEqual({
      success: true,
      output: 'backend-bound:forge-123',
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
      .resolves.toEqual({ success: true, operation: 'create', output: 'mocked create output', stderr: '' });
    await expect(backend.list(['--json'], { projectRoot: '/repo' }))
      .resolves.toEqual({ success: true, operation: 'list', output: 'mocked list output', stderr: '' });
    await expect(backend.show(['forge-1'], { projectRoot: '/repo' }))
      .resolves.toEqual({ success: true, operation: 'show', output: 'mocked show output', stderr: '' });
    await expect(backend.close(['forge-1'], { projectRoot: '/repo' }))
      .resolves.toEqual({ success: true, operation: 'close', output: 'mocked close output', stderr: '' });
    await expect(backend.update(['forge-1', '--title', 'Renamed'], { projectRoot: '/repo' }))
      .resolves.toEqual({ success: true, operation: 'update', output: 'mocked update output', stderr: '' });

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

  test('default beads backend treats empty show payloads as not-found failures', async () => {
    const { createBeadsIssueBackend } = require('../lib/forge-issues');

    const backend = createBeadsIssueBackend({
      isBeadsInitialized: () => true,
      runBdCommand: async () => ({
        code: 0,
        stdout: '[]',
        stderr: '',
      }),
    });

    await expect(backend.show(['forge-missing', '--json'], { projectRoot: '/repo' })).resolves.toEqual({
      success: false,
      error: 'Issue not found: forge-missing',
    });
  });

  test('default beads backend captures successful show output for downstream consumers', async () => {
    const { createBeadsIssueBackend } = require('../lib/forge-issues');
    const writes = [];
    let childRef;

    const backend = createBeadsIssueBackend({
      isBeadsInitialized: () => true,
      spawn: (_command, _args, _options) => {
        const events = {};
        const stdoutHandlers = {};
        const stderrHandlers = {};
        childRef = {
          stdout: {
            setEncoding() {},
            on(event, handler) {
              stdoutHandlers[event] = handler;
            },
          },
          stderr: {
            setEncoding() {},
            on(event, handler) {
              stderrHandlers[event] = handler;
            },
          },
          on(event, handler) {
            events[event] = handler;
          },
          emitSuccess() {
            stdoutHandlers.data?.('{"id":"forge-1"}');
            events.close?.(0);
          },
        };

        return childRef;
      },
      stdout: { write: chunk => writes.push({ stream: 'stdout', chunk }) },
      stderr: { write: chunk => writes.push({ stream: 'stderr', chunk }) },
    });

    const promise = backend.show(['forge-1', '--json'], { projectRoot: '/repo' });
    childRef.emitSuccess();

    await expect(promise).resolves.toEqual({
      success: true,
      operation: 'show',
      output: '{"id":"forge-1"}',
      stderr: '',
    });

    expect(writes).toEqual([]);
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
      stderr: '',
    });

    expect(calls).toEqual([{
      args: ['create', '--help'],
      projectRoot: '/repo',
    }]);
  });

  test('default beads backend streams successful stderr passthrough output', async () => {
    const { createBeadsIssueBackend } = require('../lib/forge-issues');
    const writes = [];
    let childRef;

    const backend = createBeadsIssueBackend({
      isBeadsInitialized: () => true,
      spawn: (_command, _args, _options) => {
        const events = {};
        const stdoutHandlers = {};
        const stderrHandlers = {};
        childRef = {
          stdout: {
            setEncoding() {},
            on(event, handler) {
              stdoutHandlers[event] = handler;
            },
          },
          stderr: {
            setEncoding() {},
            on(event, handler) {
              stderrHandlers[event] = handler;
            },
          },
          on(event, handler) {
            events[event] = handler;
          },
          emitSuccess() {
            stdoutHandlers.data?.('visible stdout\n');
            stderrHandlers.data?.('visible stderr\n');
            events.close?.(0);
          },
        };

        return childRef;
      },
      stdout: { write: chunk => writes.push({ stream: 'stdout', chunk }) },
      stderr: { write: chunk => writes.push({ stream: 'stderr', chunk }) },
    });

    const promise = backend.list([], { projectRoot: '/repo' });
    childRef.emitSuccess();

    await expect(promise).resolves.toEqual({
      success: true,
      operation: 'list',
      output: '',
      stderr: '',
    });

    expect(writes).toEqual([
      { stream: 'stdout', chunk: 'visible stdout\n' },
      { stream: 'stderr', chunk: 'visible stderr\n' },
    ]);
  });

  test('default beads backend does not emit captured stdout before returning it', async () => {
    const { createBeadsIssueBackend } = require('../lib/forge-issues');
    const writes = [];
    let childRef;

    const backend = createBeadsIssueBackend({
      isBeadsInitialized: () => true,
      spawn: (_command, _args, _options) => {
        const events = {};
        const stdoutHandlers = {};
        const stderrHandlers = {};
        childRef = {
          stdout: {
            setEncoding() {},
            on(event, handler) {
              stdoutHandlers[event] = handler;
            },
          },
          stderr: {
            setEncoding() {},
            on(event, handler) {
              stderrHandlers[event] = handler;
            },
          },
          on(event, handler) {
            events[event] = handler;
          },
          emitSuccess() {
            stdoutHandlers.data?.('captured stdout\n');
            events.close?.(0);
          },
        };

        return childRef;
      },
      stdout: { write: chunk => writes.push({ stream: 'stdout', chunk }) },
      stderr: { write: chunk => writes.push({ stream: 'stderr', chunk }) },
    });

    const promise = backend.create(['--help'], { projectRoot: '/repo' });
    childRef.emitSuccess();

    await expect(promise).resolves.toEqual({
      success: true,
      operation: 'create',
      output: 'captured stdout\n',
      stderr: '',
    });

    expect(writes).toEqual([]);
  });
});
