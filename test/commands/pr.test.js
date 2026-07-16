'use strict';

/**
 * Tests for the `pr` noun command surface (P2, kernel issue 6ab3f30c).
 *
 * `pr` is one memorable surface over the EXISTING ship/preflight/shepherd/merge
 * commands: every subcommand delegates to the same standalone handler, not a
 * reimplementation. The bare `forge ship`/`preflight`/`shepherd`/`merge` commands
 * stay registered, so nothing that already calls them breaks. These tests pin
 * that `pr <sub>` forwards args + flags + projectRoot + opts BYTE-IDENTICALLY to
 * the delegate handler (the hard back-compat invariant) — especially the
 * flag-rich `pr shepherd <pr> --pull --json` passthrough.
 */

const { describe, test, expect } = require('bun:test');

const pr = require('../../lib/commands/pr');
const ship = require('../../lib/commands/ship');
const preflight = require('../../lib/commands/preflight');
const shepherd = require('../../lib/commands/shepherd');
const merge = require('../../lib/commands/merge');

// Swap a delegate module's handler for a spy for the duration of `fn`, then
// restore it. pr.js reads `<module>.handler` at dispatch time, so the spy is what
// the subcommand routes to — letting us assert the exact forwarded arguments
// without touching the network (gh/git).
async function withSpy(mod, fn) {
  const calls = [];
  const original = mod.handler;
  mod.handler = async (...args) => {
    calls.push(args);
    return { success: true, output: 'spy-ok' };
  };
  try {
    await fn(calls);
  } finally {
    mod.handler = original;
  }
  return calls;
}

describe('forge pr command surface (6ab3f30c)', () => {
  test('exports the registry command contract', () => {
    expect(pr.name).toBe('pr');
    expect(typeof pr.description).toBe('string');
    expect(pr.description.length).toBeGreaterThan(0);
    expect(pr.description.length).toBeLessThanOrEqual(1024);
    expect(typeof pr.handler).toBe('function');
    expect(pr.usage).toContain('pr');
  });

  test('no subcommand lists the available subcommands', async () => {
    const result = await pr.handler([], {}, '/root');
    expect(result.success).toBe(true);
    for (const sub of ['ship', 'preflight', 'shepherd', 'merge']) {
      expect(result.output).toContain(sub);
    }
  });

  test('--help lists the available subcommands', async () => {
    const result = await pr.handler(['--help'], {}, '/root');
    expect(result.success).toBe(true);
    expect(result.output).toContain('ship');
    expect(result.output).toContain('shepherd');
  });

  test('an unknown subcommand fails and points at the surface', async () => {
    const result = await pr.handler(['frobnicate'], {}, '/root');
    expect(result.success).toBe(false);
    expect(result.error).toContain('frobnicate');
    expect(result.error).toContain('ship');
  });

  test('pr ship forwards the slug + title + flags to the ship handler', async () => {
    const calls = await withSpy(ship, async () => {
      await pr.handler(['ship', 'my-slug', 'My Title'], { dryRun: true }, '/root', { env: {} });
    });
    expect(calls).toHaveLength(1);
    // subcommand token consumed; positional args + flags/root/opts forwarded intact.
    expect(calls[0][0]).toEqual(['my-slug', 'My Title']);
    expect(calls[0][1]).toEqual({ dryRun: true });
    expect(calls[0][2]).toBe('/root');
    expect(calls[0][3]).toEqual({ env: {} });
  });

  test('pr preflight forwards to the preflight handler (opts become injectable deps)', async () => {
    const calls = await withSpy(preflight, async () => {
      await pr.handler(['preflight'], { all: true }, '/root', { log: 'x' });
    });
    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toEqual([]);
    expect(calls[0][1]).toEqual({ all: true });
    expect(calls[0][3]).toEqual({ log: 'x' });
  });

  test('pr shepherd <pr> --pull --json passes flags through BYTE-IDENTICALLY to the shepherd handler', async () => {
    // The hard invariant: shepherd parses --pull/--json/--bundle out of `args`
    // itself, so pr must forward every token after the subcommand untouched.
    const calls = await withSpy(shepherd, async () => {
      await pr.handler(['shepherd', '123', '--pull', '--json'], {}, '/root', { gh: 'g' });
    });
    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toEqual(['123', '--pull', '--json']);
    expect(calls[0][2]).toBe('/root');
    expect(calls[0][3]).toEqual({ gh: 'g' });
  });

  test('pr shepherd events <pr> --since <seq> forwards the events subcommand shape', async () => {
    const calls = await withSpy(shepherd, async () => {
      await pr.handler(['shepherd', 'events', '123', '--since', '5', '--json'], {}, '/root');
    });
    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toEqual(['events', '123', '--since', '5', '--json']);
  });

  test('pr merge --auto <pr> forwards to the merge handler', async () => {
    const calls = await withSpy(merge, async () => {
      await pr.handler(['merge', '--auto', '456'], {}, '/root');
    });
    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toEqual(['--auto', '456']);
  });
});
