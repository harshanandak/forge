'use strict';

const { describe, test, expect } = require('bun:test');

const skillCommand = require('../../lib/commands/skill');

// The `forge skill` noun routes a situation to the best-fit Forge skill via the deterministic
// router (lib/using-forge). The catalog is read from the Forge PACKAGE root (getPackageRoot),
// which in this dev checkout is the repo root — so routing resolves against the real skills/.
describe('forge skill command', () => {
  test('forge skill for "<situation>" --json returns a machine-readable result', () => {
    const res = skillCommand.handler(['for', 'open a PR', '--json'], {});
    expect(res.success).toBe(true);
    const parsed = JSON.parse(res.output);
    expect(parsed.best).toBe('ship');
    expect(parsed.unknown).toBe(false);
    expect(Array.isArray(parsed.matches)).toBe(true);
  });

  test('text mode names the best skill and the announce line', () => {
    const res = skillCommand.handler(['for', 'add a feature'], {});
    expect(res.success).toBe(true);
    expect(res.output).toContain('plan');
    expect(res.output).toContain('Announce:');
  });

  test('multi-word unquoted situation is joined from positional args', () => {
    const res = skillCommand.handler(['for', 'run', 'the', 'tests', '--json'], {});
    const parsed = JSON.parse(res.output);
    expect(parsed.best).toBe('validate');
  });

  test('missing situation errors with usage', () => {
    const res = skillCommand.handler(['for'], {});
    expect(res.success).toBe(false);
    expect(res.error).toContain('Usage: forge skill for');
  });

  test('unknown verb errors and lists supported verbs', () => {
    const res = skillCommand.handler(['bogus'], {});
    expect(res.success).toBe(false);
    expect(res.error).toContain('Supported: for');
  });

  test('exports the standard command interface', () => {
    expect(skillCommand.name).toBe('skill');
    expect(typeof skillCommand.description).toBe('string');
    expect(typeof skillCommand.handler).toBe('function');
  });
});
