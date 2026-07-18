'use strict';

const { describe, test, expect } = require('bun:test');
const path = require('node:path');

const { routeSkill, loadSkillCatalog, parseFrontmatter } = require('../lib/using-forge');
const skillCommand = require('../lib/commands/skill');

const repoRoot = path.resolve(__dirname, '..');
const catalog = loadSkillCatalog(repoRoot);

describe('using-forge router (forge skill for)', () => {
  test('the canonical catalog loads and covers Forge stage skills', () => {
    const names = catalog.map(s => s.name);
    expect(catalog.length).toBeGreaterThan(0);
    for (const expected of ['plan', 'dev', 'validate', 'ship', 'review', 'verify']) {
      expect(names).toContain(expected);
    }
  });

  test.each([
    ['add a feature', 'plan'],
    ['scope a new feature', 'plan'],
    ['fix a failing test', 'dev'],
    ['implement the parser task', 'dev'],
    ['run the tests and lint', 'validate'],
    ['open a PR', 'ship'],
    ['push the branch and open a pull request', 'ship'],
    ['address PR feedback from coderabbit', 'review'],
    ['post-merge health check', 'verify'],
    ['what should I work on next', 'triage-ready'],
    ['where am I in the workflow', 'status'],
  ])('routes %j to %j', (situation, expected) => {
    const result = routeSkill(situation, { catalog });
    expect(result.best).toBe(expected);
    expect(result.unknown).toBe(false);
    expect(result.matches[0].why).toBeTruthy();
  });

  test('an unknown / non-actionable situation degrades gracefully', () => {
    const result = routeSkill('xyzzy plugh nonsense', { catalog });
    expect(result.best).toBeNull();
    expect(result.unknown).toBe(true);
    expect(result.matches).toEqual([]);
  });

  test('empty situation is safe and returns unknown', () => {
    const result = routeSkill('', { catalog });
    expect(result.unknown).toBe(true);
    expect(result.best).toBeNull();
  });

  test('routing is deterministic (same input, same output)', () => {
    const a = routeSkill('open a PR', { catalog });
    const b = routeSkill('open a PR', { catalog });
    expect(a).toEqual(b);
  });
});

describe('forge skill command', () => {
  test('forge skill for "<situation>" --json returns a machine-readable result', () => {
    const res = skillCommand.handler(['for', 'open a PR', '--json'], {}, repoRoot);
    expect(res.success).toBe(true);
    const parsed = JSON.parse(res.output);
    expect(parsed.best).toBe('ship');
    expect(parsed.unknown).toBe(false);
    expect(Array.isArray(parsed.matches)).toBe(true);
  });

  test('text mode names the best skill and the announce line', () => {
    const res = skillCommand.handler(['for', 'add a feature'], {}, repoRoot);
    expect(res.success).toBe(true);
    expect(res.output).toContain('plan');
    expect(res.output).toContain('Announce:');
  });

  test('multi-word unquoted situation is joined from positional args', () => {
    const res = skillCommand.handler(['for', 'run', 'the', 'tests', '--json'], {}, repoRoot);
    const parsed = JSON.parse(res.output);
    expect(parsed.best).toBe('validate');
  });

  test('missing situation errors with usage', () => {
    const res = skillCommand.handler(['for'], {}, repoRoot);
    expect(res.success).toBe(false);
    expect(res.error).toContain('Usage: forge skill for');
  });

  test('unknown verb errors and lists supported verbs', () => {
    const res = skillCommand.handler(['bogus'], {}, repoRoot);
    expect(res.success).toBe(false);
    expect(res.error).toContain('Supported: for');
  });

  test('exports the standard command interface', () => {
    expect(skillCommand.name).toBe('skill');
    expect(typeof skillCommand.description).toBe('string');
    expect(typeof skillCommand.handler).toBe('function');
  });
});

describe('parseFrontmatter', () => {
  test('extracts name and flattens a folded description block', () => {
    const raw = [
      '---',
      'name: demo',
      'description: >',
      '  first line',
      '  second line',
      'allowed-tools: Read',
      '---',
      '# body',
    ].join('\n');
    const fm = parseFrontmatter(raw);
    expect(fm.name).toBe('demo');
    expect(fm.description).toBe('first line second line');
  });
});
