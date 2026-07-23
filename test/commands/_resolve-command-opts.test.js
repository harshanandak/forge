'use strict';

const { describe, test, expect } = require('bun:test');

const {
  resolveCommandOpts,
  ISSUE_COMMANDS,
  stripSelectorTokens,
} = require('../../lib/commands/_resolve-command-opts');
const { SUBCOMMANDS } = require('../../lib/commands/_issue');

const TIMEOUT = 5000;

describe('stripSelectorTokens — consume + remove --kernel / --issue-backend', () => {
  test('removes --kernel boolean flag from args', () => {
    const { args, flags } = stripSelectorTokens(['kap-10', '--kernel', '--reason=x']);
    expect(args).toEqual(['kap-10', '--reason=x']);
    expect(flags.kernel).toBe(true);
  });

  test('removes --issue-backend kernel (space form) and its value', () => {
    const { args, flags } = stripSelectorTokens(['kap-10', '--issue-backend', 'kernel']);
    expect(args).toEqual(['kap-10']);
    expect(flags.issueBackend).toBe('kernel');
  });

  test('removes --issue-backend=kernel (= form)', () => {
    const { args, flags } = stripSelectorTokens(['kap-10', '--issue-backend=kernel']);
    expect(args).toEqual(['kap-10']);
    expect(flags.issueBackend).toBe('kernel');
  });

  test('strips a retired backend value too (validation happens downstream)', () => {
    // Stripping is unconditional so the value can never leak into the args as a
    // positional issue id; resolveFlagBackend is what rejects it.
    const { args, flags } = stripSelectorTokens(['kap-10', '--issue-backend=beads']);
    expect(args).toEqual(['kap-10']);
    expect(flags.issueBackend).toBe('beads');
  });

  test('leaves non-selector flags (e.g. --reason) untouched', () => {
    const { args } = stripSelectorTokens(['a', 'b', '--reason=Merged on master']);
    expect(args).toEqual(['a', 'b', '--reason=Merged on master']);
  });

  test('throws when --issue-backend (space form) is followed by a flag, not a value', () => {
    // Without the guard this would swallow `--reason=x` as the backend value and
    // silently fall back to the default backend.
    expect(() => stripSelectorTokens(['kap-10', '--issue-backend', '--reason=x']))
      .toThrow(/--issue-backend requires a value/);
  });

  test('throws when --issue-backend (space form) has no following value', () => {
    expect(() => stripSelectorTokens(['kap-10', '--issue-backend']))
      .toThrow(/--issue-backend requires a value/);
  });

  test('throws when --issue-backend= (= form) value is empty', () => {
    expect(() => stripSelectorTokens(['kap-10', '--issue-backend=']))
      .toThrow(/--issue-backend requires a value/);
  });
});

describe('resolveCommandOpts — issue commands', () => {
  test(
    'default (no flag/env) → kernel deps assembled, args unchanged',
    async () => {
      const built = [];
      const { commandOpts, args } = await resolveCommandOpts('close', ['kap-10', '--reason=x'], {
        env: {},
        projectRoot: '/repo',
        // Inject the factory so the test does not touch a real SQLite runtime.
        buildKernelIssueDeps: (opts) => {
          built.push(opts);
          return { useKernelBroker: true, kernelDriver: { exec() {} }, kernelDatabasePath: ':memory:' };
        },
      });
      expect(commandOpts.issueBackend).toBe('kernel');
      expect(commandOpts.useKernelBroker).toBe(true);
      expect(commandOpts.kernelDriver).toBeDefined();
      expect(args).toEqual(['kap-10', '--reason=x']);
      expect(built).toHaveLength(1);
    },
    TIMEOUT,
  );

  test(
    '--issue-backend beads (space form) is a hard error with the migrate pointer',
    async () => {
      await expect(
        resolveCommandOpts('close', ['kap-10', '--issue-backend', 'beads', '--reason=x'], {
          env: {},
          projectRoot: '/repo',
          buildKernelIssueDeps: () => ({ useKernelBroker: true }),
        }),
      ).rejects.toThrow(/forge migrate --from beads/);
    },
    TIMEOUT,
  );

  test(
    '--issue-backend=BEADS (= form, any case) is a hard error with the migrate pointer',
    async () => {
      await expect(
        resolveCommandOpts('close', ['kap-10', '--issue-backend=BEADS'], {
          env: {},
          projectRoot: '/repo',
          buildKernelIssueDeps: () => ({ useKernelBroker: true }),
        }),
      ).rejects.toThrow(/no longer supported[\s\S]*forge migrate --from beads/);
    },
    TIMEOUT,
  );

  test(
    'FORGE_ISSUE_BACKEND=beads env warns and still resolves to the kernel',
    async () => {
      // Env/config are ambient (a stale shell profile, an old .forge/config.yaml), so
      // they warn + fall back rather than hard-fail the command.
      const { commandOpts } = await resolveCommandOpts('close', ['kap-10'], {
        env: { FORGE_ISSUE_BACKEND: 'beads' },
        projectRoot: '/repo',
        buildKernelIssueDeps: () => ({ useKernelBroker: true, kernelDriver: { exec() {} } }),
      });
      expect(commandOpts.issueBackend).toBe('kernel');
      expect(commandOpts.useKernelBroker).toBe(true);
    },
    TIMEOUT,
  );

  test(
    '--kernel flag → kernel deps assembled, selector token stripped from args',
    async () => {
      const built = [];
      const { commandOpts, args } = await resolveCommandOpts('close', ['kap-10', '--kernel', '--reason=x'], {
        env: {},
        projectRoot: '/repo',
        // Inject the factory so the test does not touch a real SQLite runtime.
        buildKernelIssueDeps: (opts) => {
          built.push(opts);
          return { useKernelBroker: true, kernelDriver: { exec() {} }, kernelDatabasePath: ':memory:' };
        },
      });

      expect(commandOpts.useKernelBroker).toBe(true);
      expect(commandOpts.kernelDriver).toBeDefined();
      expect(commandOpts.issueBackend).toBe('kernel');
      // selector token removed; the real close args remain
      expect(args).toEqual(['kap-10', '--reason=x']);
      expect(built).toHaveLength(1);
    },
    TIMEOUT,
  );

  test(
    'FORGE_ISSUE_BACKEND=kernel env → kernel deps (no flag needed)',
    async () => {
      const { commandOpts } = await resolveCommandOpts('close', ['kap-10'], {
        env: { FORGE_ISSUE_BACKEND: 'kernel' },
        projectRoot: '/repo',
        buildKernelIssueDeps: () => ({ useKernelBroker: true, kernelDriver: { exec() {} } }),
      });
      expect(commandOpts.useKernelBroker).toBe(true);
      expect(commandOpts.issueBackend).toBe('kernel');
    },
    TIMEOUT,
  );

  test(
    'non-issue commands get an empty opts object and untouched args',
    async () => {
      const { commandOpts, args } = await resolveCommandOpts('validate', ['--kernel'], {
        env: {},
        projectRoot: '/repo',
      });
      expect(commandOpts).toEqual({});
      expect(args).toEqual(['--kernel']);
    },
    TIMEOUT,
  );

  test(
    'ISSUE_COMMANDS includes the alias verbs and the issue grouping command',
    () => {
      for (const verb of ['close', 'create', 'update', 'claim', 'release', 'comment', 'show', 'list', 'ready', 'blocked', 'stale', 'orphans', 'lint', 'issue']) {
        expect(ISSUE_COMMANDS.has(verb)).toBe(true);
      }
    },
    TIMEOUT,
  );

  test(
    'every SUBCOMMANDS verb is in ISSUE_COMMANDS (structural drift guard)',
    () => {
      // ISSUE_COMMANDS is hand-maintained and decoupled from the SUBCOMMANDS spec in
      // _issue.js. A verb present in SUBCOMMANDS but missing here never gets kernel
      // deps assembled (no driver/broker on opts), so it would fail at dispatch with
      // no failing test to catch it. Fail CI on that drift.
      for (const verb of Object.keys(SUBCOMMANDS)) {
        expect(ISSUE_COMMANDS.has(verb)).toBe(true);
      }
    },
    TIMEOUT,
  );

  test(
    'conflicting --kernel + --issue-backend beads rejects (surfaced to the user)',
    async () => {
      await expect(
        resolveCommandOpts('close', ['kap-10', '--kernel', '--issue-backend', 'beads'], {
          env: {},
          projectRoot: '/repo',
          buildKernelIssueDeps: () => ({ useKernelBroker: true }),
        }),
      ).rejects.toThrow(/conflict|mutually.exclusive/i);
    },
    TIMEOUT,
  );
});
