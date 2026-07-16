/**
 * Tests for the declarative command-alias module (lib/commands/_aliases.js).
 *
 * P0 of the command-surface unification: generalise the hardcoded
 * ISSUE_ALIAS_COMMANDS allowlist into a declarative map that supports visible
 * aliases, hidden (back-compat) aliases, and an opt-in deprecation hint — while
 * keeping every existing top-level verb routing byte-identically.
 */

const { describe, test, expect } = require('bun:test');
const aliases = require('../../lib/commands/_aliases');

// The 13 bare verbs that ISSUE_ALIAS_COMMANDS hid from help before P0. The map
// MUST seed exactly these so back-compat is provably identical.
const LEGACY_ISSUE_ALIASES = [
  'create', 'update', 'claim', 'close', 'show', 'list',
  'ready', 'blocked', 'stale', 'orphans', 'lint', 'claims', 'issues',
];

describe('command aliases — declarative map', () => {
  test('passthroughAliasNames() equals the migrated ISSUE_ALIAS_COMMANDS set (bd flag-passthrough back-compat)', () => {
    // The bd flag-passthrough set — the aliases bin/forge.js skips global flag
    // parsing for — is exactly the issue-canonical aliases, unchanged by P1.
    expect([...aliases.passthroughAliasNames()].sort()).toEqual([...LEGACY_ISSUE_ALIASES].sort());
  });

  test('aliasNames() is a superset of the legacy issue aliases (map also holds P1 memory shortcuts)', () => {
    const all = new Set(aliases.aliasNames());
    for (const name of LEGACY_ISSUE_ALIASES) {
      expect(all.has(name)).toBe(true);
    }
  });

  test('every seed alias resolves to a canonical "issue <sub>" form', () => {
    for (const name of LEGACY_ISSUE_ALIASES) {
      const descriptor = aliases.resolveAlias(name);
      expect(descriptor).toBeDefined();
      expect(typeof descriptor.canonical).toBe('string');
      expect(descriptor.canonical.startsWith('issue ')).toBe(true);
    }
  });

  test('resolveAlias returns undefined for a non-alias', () => {
    expect(aliases.resolveAlias('definitely-not-an-alias')).toBeUndefined();
  });

  test('isAlias reflects membership', () => {
    expect(aliases.isAlias('create')).toBe(true);
    expect(aliases.isAlias('status')).toBe(false);
  });
});

describe('command aliases — memory noun shortcuts (P1, febf7690)', () => {
  // The memory noun (add/recall/search/insights) shipped in PR #392 (issue
  // 25362344). P1 wires remember/recall/insights as VISIBLE back-compat shortcuts
  // of the canonical `memory <sub>` form. The canonical WRITE verb is `memory add`
  // (there is no `save`).
  const MEMORY_SHORTCUTS = {
    remember: 'memory add',
    recall: 'memory recall',
    insights: 'memory insights',
  };

  test('remember/recall/insights are VISIBLE, non-deprecated aliases of a memory subcommand', () => {
    for (const [name, canonical] of Object.entries(MEMORY_SHORTCUTS)) {
      const descriptor = aliases.resolveAlias(name);
      expect(descriptor).toBeDefined();
      expect(descriptor.canonical).toBe(canonical);
      expect(descriptor.visible).toBe(true);
      expect(descriptor.deprecated).toBeUndefined();
      expect(aliases.isVisibleAlias(name)).toBe(true);
      expect(aliases.isHiddenAlias(name)).toBe(false);
    }
  });

  test('visibleAliasNames() lists exactly the memory shortcuts', () => {
    expect([...aliases.visibleAliasNames()].sort()).toEqual(Object.keys(MEMORY_SHORTCUTS).sort());
  });

  test('memory shortcuts are NOT in the bd flag-passthrough set (keeps -p / --help byte-identical)', () => {
    const passthrough = new Set(aliases.passthroughAliasNames());
    for (const name of Object.keys(MEMORY_SHORTCUTS)) {
      expect(passthrough.has(name)).toBe(false);
    }
  });

  test('a registered memory shortcut is never rewritten (byte-identical dispatch)', () => {
    // remember/recall/insights keep their own command files, so resolveDispatch
    // is a strict no-op — dispatch is identical to before P1.
    for (const name of Object.keys(MEMORY_SHORTCUTS)) {
      const out = aliases.resolveDispatch(name, [name, 'foo', '--json'], () => true);
      expect(out.redirected).toBe(false);
      expect(out.command).toBe(name);
      expect(out.args).toEqual([name, 'foo', '--json']);
    }
  });

  test('an unregistered memory shortcut would route to its memory subcommand', () => {
    const out = aliases.resolveDispatch('recall', ['recall', 'bun', '--limit', '3'], () => false);
    expect(out.redirected).toBe(true);
    expect(out.command).toBe('memory');
    expect(out.args).toEqual(['memory', 'recall', 'bun', '--limit', '3']);
  });
});

describe('command aliases — visible vs hidden', () => {
  test('isHidden() respects the visible flag on a descriptor', () => {
    expect(aliases.isHidden({ visible: false })).toBe(true);
    expect(aliases.isHidden({ visible: true })).toBe(false);
    expect(aliases.isHidden(undefined)).toBe(false);
  });

  test('all seed aliases are hidden — help hides exactly the legacy set', () => {
    for (const name of LEGACY_ISSUE_ALIASES) {
      expect(aliases.isHiddenAlias(name)).toBe(true);
    }
    expect(aliases.isHiddenAlias('status')).toBe(false);
  });

  test('help filter keeps non-aliases and drops hidden aliases', () => {
    // Simulate the help-rendering filter at bin/forge.js:2616.
    const commandNames = ['status', 'create', 'issue', 'ready', 'push'];
    const shown = commandNames.filter(name => !aliases.isHiddenAlias(name));
    // Hidden aliases (create, ready) are dropped; real commands remain.
    expect(shown).toEqual(['status', 'issue', 'push']);
  });
});

describe('command aliases — deprecation hint (opt-in, stderr)', () => {
  const deprecated = { canonical: 'gate doc', visible: false, deprecated: true };
  const resolve = () => deprecated;

  test('shouldWarn requires BOTH the env flag and a deprecated descriptor', () => {
    expect(aliases.shouldWarn(deprecated, { FORGE_DEPRECATION_WARNINGS: '1' })).toBe(true);
    expect(aliases.shouldWarn(deprecated, {})).toBe(false);
    expect(aliases.shouldWarn({ visible: false }, { FORGE_DEPRECATION_WARNINGS: '1' })).toBe(false);
    expect(aliases.shouldWarn(undefined, { FORGE_DEPRECATION_WARNINGS: '1' })).toBe(false);
  });

  test('renderHint names the canonical form', () => {
    const hint = aliases.renderHint('doc-gate', deprecated);
    expect(hint).toContain('doc-gate');
    expect(hint).toContain('gate doc');
  });

  test('maybeWarnDeprecation writes to stderr only when the env flag is set', () => {
    const writes = [];
    const stderr = { write: (s) => { writes.push(s); return true; } };

    // Flag OFF → silent (default; must never corrupt stdout/scripts).
    const off = aliases.maybeWarnDeprecation('doc-gate', { env: {}, stderr, resolve });
    expect(off).toBe(false);
    expect(writes).toEqual([]);

    // Flag ON → one stderr line.
    const on = aliases.maybeWarnDeprecation('doc-gate', {
      env: { FORGE_DEPRECATION_WARNINGS: '1' }, stderr, resolve,
    });
    expect(on).toBe(true);
    expect(writes.length).toBe(1);
    expect(writes[0]).toContain('gate doc');
    expect(writes[0].endsWith('\n')).toBe(true);
  });

  test('non-deprecated seed aliases never warn, even with the flag set', () => {
    const writes = [];
    const stderr = { write: (s) => { writes.push(s); return true; } };
    const fired = aliases.maybeWarnDeprecation('create', {
      env: { FORGE_DEPRECATION_WARNINGS: '1' }, stderr,
    });
    expect(fired).toBe(false);
    expect(writes).toEqual([]);
  });
});

describe('command aliases — dispatch resolution', () => {
  test('a registered command is never rewritten (identical dispatch)', () => {
    const isRegistered = () => true;
    const out = aliases.resolveDispatch('create', ['create', '--json'], isRegistered);
    expect(out.redirected).toBe(false);
    expect(out.command).toBe('create');
    expect(out.args).toEqual(['create', '--json']);
  });

  test('an unregistered alias resolves to its canonical noun handler', () => {
    const isRegistered = () => false; // simulate a future phase where the bare file is gone
    const out = aliases.resolveDispatch('create', ['create', 'ABC-1', '--json'], isRegistered);
    expect(out.redirected).toBe(true);
    expect(out.command).toBe('issue');
    expect(out.args).toEqual(['issue', 'create', 'ABC-1', '--json']);
  });

  test('a non-alias is never rewritten', () => {
    const out = aliases.resolveDispatch('bogus', ['bogus', 'x'], () => false);
    expect(out.redirected).toBe(false);
    expect(out.command).toBe('bogus');
    expect(out.args).toEqual(['bogus', 'x']);
  });
});
