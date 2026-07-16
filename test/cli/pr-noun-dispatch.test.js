'use strict';

/**
 * CLI-level back-compat guard for the `pr` noun (P2, kernel issue 6ab3f30c).
 *
 * The hard invariant: invoking a command through its canonical noun form
 * (`forge pr <sub>`) must behave BYTE-IDENTICALLY to the bare verb — same stdout,
 * stderr, and exit code — because it routes to the SAME handler. This spawns the
 * real CLI (not the in-process handler) so it also exercises the dispatch-layer
 * stage-enforcement path that `pr ship` must share with bare `ship`.
 *
 * These invocations run against THIS repo checkout with intentionally-invalid
 * inputs so they fail fast and deterministically without any network mutation.
 */

const { describe, test, expect } = require('bun:test');
const { spawnSync } = require('node:child_process');
const path = require('node:path');

const CLI = path.join(__dirname, '../../bin/forge.js');

function run(argv) {
  const result = spawnSync(process.execPath, [CLI, ...argv], {
    encoding: 'utf8',
    timeout: 30000,
  });
  // spawnSync signals a timeout (or spawn failure) with `error` set and a null
  // status. Fail loudly instead of comparing null==null, which would let a
  // double-timeout silently pass the equality assertions below.
  if (result.error) {
    throw new Error(`forge ${argv.join(' ')} failed to run: ${result.error.message}`);
  }
  if (result.status === null) {
    throw new Error(`forge ${argv.join(' ')} did not exit with an integer status (killed by signal ${result.signal})`);
  }
  return { status: result.status, out: result.stdout || '', err: result.stderr || '' };
}

// Each pair: the bare verb invocation vs its canonical `pr <sub>` form. The two
// MUST produce identical stdout+stderr+exit. Inputs are chosen to fail before any
// network mutation (nonexistent slug / PR number).
const EQUIVALENT_INVOCATIONS = [
  { name: 'ship (stage — must share stage-entry enforcement)', bare: ['ship', 'nonexistent-slug-xyz'], noun: ['pr', 'ship', 'nonexistent-slug-xyz'] },
  // Global flag BETWEEN the noun and the stage must still route through the stage
  // path (the rewrite scans past global flags, not just dispatchArgv[1]).
  { name: 'ship with a global flag before the stage', bare: ['ship', '--path', '.', 'nonexistent-slug-xyz'], noun: ['pr', '--path', '.', 'ship', 'nonexistent-slug-xyz'] },
  { name: 'shepherd --pull --json (flag passthrough)', bare: ['shepherd', '999999', '--pull', '--json'], noun: ['pr', 'shepherd', '999999', '--pull', '--json'] },
  { name: 'shepherd events (subcommand shape passthrough)', bare: ['shepherd', 'events', '999999', '--since', '1', '--json'], noun: ['pr', 'shepherd', 'events', '999999', '--since', '1', '--json'] },
  { name: 'merge --auto (fail-closed preview)', bare: ['merge', '--auto', '999999'], noun: ['pr', 'merge', '--auto', '999999'] },
];

describe('pr noun CLI dispatch — byte-identical back-compat (6ab3f30c)', () => {
  for (const { name, bare, noun } of EQUIVALENT_INVOCATIONS) {
    // Two real CLI spawns per case (kernel/git/gh resolution) — allow ample time.
    test(`forge ${noun.join(' ')} == forge ${bare.join(' ')} — ${name}`, () => {
      const b = run(bare);
      const n = run(noun);
      expect(n.status).toBe(b.status);
      expect(n.out).toBe(b.out);
      expect(n.err).toBe(b.err);
    }, 60000);
  }

  test('gate doc == doc-gate (folds under the gate noun)', () => {
    const b = run(['doc-gate', 'detect']);
    const n = run(['gate', 'doc', 'detect']);
    expect(n.status).toBe(b.status);
    expect(n.out).toBe(b.out);
    expect(n.err).toBe(b.err);
  }, 60000);

  test('forge --help shows pr as a noun and ship/preflight in Shortcuts', () => {
    const help = run(['--help']);
    expect(help.out).toContain('ship');
    expect(help.out).toContain('preflight');
    expect(help.out).toMatch(/Shortcuts/);
    // pr is enumerated as a base noun in Additional commands.
    expect(help.out).toMatch(/\bpr\b/);
  }, 30000);
});
