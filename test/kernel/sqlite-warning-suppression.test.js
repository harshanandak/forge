'use strict';

// node:sqlite emits a one-time ExperimentalWarning at require time. The driver must
// swallow ONLY that SQLite warning (so CLI stdout stays clean) while letting every
// other warning through, and must always restore process.emitWarning.

const { describe, test, expect } = require('bun:test');
const { requireSqliteRuntimeModule } = require('../../lib/kernel/sqlite-driver.js');

describe('requireSqliteRuntimeModule', () => {
  test('drops the node:sqlite SQLite warning but forwards unrelated warnings', () => {
    const original = process.emitWarning;
    const forwarded = [];
    const spy = (warning) => { forwarded.push(String(warning)); };
    process.emitWarning = spy;

    try {
      const fakeModule = { DatabaseSync: function () {} };
      const requireModule = (id) => {
        expect(id).toBe('node:sqlite');
        // Simulate Node's require-time warnings.
        process.emitWarning('SQLite is an experimental feature and might change at any time');
        process.emitWarning('some unrelated deprecation');
        return fakeModule;
      };

      const result = requireSqliteRuntimeModule(requireModule, 'node:sqlite');
      expect(result).toBe(fakeModule);
      // SQLite warning suppressed; the unrelated one passed through to the spy.
      expect(forwarded).toEqual(['some unrelated deprecation']);
      // Helper restored whatever emitWarning was installed when it was called.
      expect(process.emitWarning).toBe(spy);
    } finally {
      process.emitWarning = original;
    }
  });

  test('passes non-node:sqlite ids straight through without touching emitWarning', () => {
    const original = process.emitWarning;
    const fakeBun = { Database: function () {} };
    const result = requireSqliteRuntimeModule(() => fakeBun, 'bun:sqlite');
    expect(result).toBe(fakeBun);
    expect(process.emitWarning).toBe(original);
  });
});
