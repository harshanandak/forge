'use strict';

const { describe, test, expect } = require('bun:test');

const {
  buildKernelIssueDeps,
  ensureKernelMigrated,
  resolveKernelDatabasePath,
} = require('../../lib/kernel/cli-broker-factory');

const TIMEOUT = 5000;

function fakeRuntime() {
  // Minimal in-memory stand-in honoring the bun:sqlite Database shape the driver
  // uses (selectBuiltinSQLiteRuntime → runtime.module.Database).
  class FakeDb {
    constructor() {
      this.statements = [];
    }
    exec(sql) {
      this.statements.push(sql);
    }
    query() {
      return { all: () => [], get: () => undefined, run: () => ({}) };
    }
    prepare() {
      return { all: () => [], get: () => undefined, run: () => ({}) };
    }
    close() {}
  }
  return { kind: 'bun', module: { Database: FakeDb } };
}

describe('buildKernelIssueDeps', () => {
  test(
    'returns kernel deps with useKernelBroker + an injected driver',
    () => {
      const deps = buildKernelIssueDeps({
        projectRoot: '/repo',
        databasePath: ':memory:',
        runtime: fakeRuntime(),
      });

      expect(deps.useKernelBroker).toBe(true);
      expect(deps.kernelDriver).toBeDefined();
      expect(typeof deps.kernelDriver.exec).toBe('function');
      expect(deps.kernelDatabasePath).toBe(':memory:');
    },
    TIMEOUT,
  );

  test(
    'defaults databasePath under .git/forge/kernel.sqlite when not supplied',
    () => {
      const deps = buildKernelIssueDeps({
        projectRoot: '/repo',
        gitCommonDir: '/repo/.git',
        runtime: fakeRuntime(),
      });

      expect(deps.kernelDatabasePath.replace(/\\/g, '/')).toContain('.git/forge/kernel.sqlite');
    },
    TIMEOUT,
  );

  test(
    'surfaces a clear error when no SQLite runtime is available',
    () => {
      // Force the builtin runtime selector to find nothing: requireModule throws
      // MODULE_NOT_FOUND for every candidate (bun:sqlite / node:sqlite).
      const missing = () => {
        const error = new Error("Cannot find module");
        error.code = 'MODULE_NOT_FOUND';
        throw error;
      };
      expect(() =>
        buildKernelIssueDeps({
          projectRoot: '/repo',
          databasePath: ':memory:',
          requireModule: missing,
        }),
      ).toThrow(/sqlite|runtime/i);
    },
    TIMEOUT,
  );
});

describe('ensureKernelMigrated', () => {
  test(
    'invokes broker.initialize once and returns its result',
    async () => {
      let calls = 0;
      const broker = {
        async initialize() {
          calls += 1;
          return { success: true, migrationsApplied: ['001'] };
        },
      };

      const result = await ensureKernelMigrated(broker);
      expect(calls).toBe(1);
      expect(result.success).toBe(true);
    },
    TIMEOUT,
  );

  test(
    'is idempotent — double call is safe and re-runs initialize (migrations idempotent)',
    async () => {
      let calls = 0;
      const broker = {
        async initialize() {
          calls += 1;
          return { success: true };
        },
      };

      await ensureKernelMigrated(broker);
      await ensureKernelMigrated(broker);
      // Per-invocation policy: each call re-runs initialize (migrations swallow
      // duplicate-column). Double call must not throw.
      expect(calls).toBe(2);
    },
    TIMEOUT,
  );

  test(
    'throws a clear error when broker lacks initialize',
    async () => {
      await expect(ensureKernelMigrated({})).rejects.toThrow(/initialize/i);
    },
    TIMEOUT,
  );
});

describe('resolveKernelDatabasePath', () => {
  test(
    'prefers an explicit databasePath',
    () => {
      const p = resolveKernelDatabasePath({
        projectRoot: '/repo',
        databasePath: '/custom/k.sqlite',
      });
      expect(p).toBe('/custom/k.sqlite');
    },
    TIMEOUT,
  );

  test(
    'derives from gitCommonDir when no explicit path',
    () => {
      const p = resolveKernelDatabasePath({
        projectRoot: '/repo',
        gitCommonDir: '/repo/.git',
      });
      expect(p.replace(/\\/g, '/')).toBe('/repo/.git/forge/kernel.sqlite');
    },
    TIMEOUT,
  );
});
