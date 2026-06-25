'use strict';

const { describe, test, expect } = require('bun:test');

const { executeCommand } = require('../../lib/commands/_registry');

const TIMEOUT = 5000;

function registryWith(handler) {
  return new Map([
    ['probe', { name: 'probe', description: 'probe', handler }],
  ]);
}

describe('executeCommand — opts/commandOpts threading (T2)', () => {
  test(
    'forwards options.commandOpts to the handler as the 4th argument',
    async () => {
      let received;
      const commands = registryWith(async (args, flags, projectRoot, opts) => {
        received = { args, flags, projectRoot, opts };
        return { success: true };
      });

      await executeCommand(commands, 'probe', ['x'], { f: 1 }, '/repo', {
        commandOpts: { useKernelBroker: true, issueBackend: 'kernel' },
      });

      expect(received.args).toEqual(['x']);
      expect(received.flags).toEqual({ f: 1 });
      expect(received.projectRoot).toBe('/repo');
      expect(received.opts).toEqual({ useKernelBroker: true, issueBackend: 'kernel' });
    },
    TIMEOUT,
  );

  test(
    'passes an empty object as the 4th arg when no commandOpts supplied (backward-compat)',
    async () => {
      let received;
      const commands = registryWith(async (_args, _flags, _projectRoot, opts) => {
        received = opts;
        return { success: true };
      });

      await executeCommand(commands, 'probe', [], {}, '/repo');

      expect(received).toEqual({});
    },
    TIMEOUT,
  );

  test(
    'existing 3-arg handlers are unaffected (ignore the 4th arg)',
    async () => {
      const commands = registryWith(async (args, _flags, projectRoot) => ({
        success: true,
        echo: `${args.join(',')}|${projectRoot}`,
      }));

      const result = await executeCommand(commands, 'probe', ['a', 'b'], {}, '/repo', {
        commandOpts: { useKernelBroker: true },
      });

      expect(result).toEqual({ success: true, echo: 'a,b|/repo' });
    },
    TIMEOUT,
  );

  test(
    'unknown command still returns the standard error shape',
    async () => {
      const commands = registryWith(async () => ({ success: true }));
      const result = await executeCommand(commands, 'nope', [], {}, '/repo', {
        commandOpts: { useKernelBroker: true },
      });
      expect(result.success).toBe(false);
      expect(result.error).toContain('nope');
    },
    TIMEOUT,
  );
});
