'use strict';

const { describe, test, expect } = require('bun:test');
const path = require('node:path');

const { routeSkill, loadSkillCatalog, loadDispatchText, parseFrontmatter } = require('../lib/using-forge');

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

  test('catalog + dispatch text load from the PACKAGE root with no argument (works outside a source checkout)', () => {
    // The BLOCKER fix: skills are read from the Forge package (getPackageRoot), not projectRoot.
    // With no override, both resolve against the packaged canonical skills/.
    expect(loadSkillCatalog().length).toBeGreaterThan(0);
    expect(loadDispatchText().length).toBeGreaterThan(0);
    // An explicit override that has no skills/ yields an empty catalog (honest, no throw).
    expect(loadSkillCatalog(path.join(__dirname, 'no-such-skills-root'))).toEqual([]);
    expect(loadDispatchText(path.join(__dirname, 'no-such-skills-root'))).toBe('');
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

  test('an empty/unavailable catalog returns no matches (never fabricates skill names)', () => {
    // Even a strong curated-keyword situation must NOT return a skill the catalog does not have.
    const result = routeSkill('open a PR', { catalog: [] });
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

  test('single-word keywords match on a WORD BOUNDARY, not as a substring', () => {
    // Regression: bare "lease" must NOT fire inside "please" (was misrouting to claim-safety).
    const misleading = routeSkill('please review this commit', { catalog });
    expect(misleading.best).not.toBe('claim-safety');
    // The real word "lease" still routes to claim-safety (boundary match keeps the keyword working).
    const real = routeSkill('claim the issue and hold the lease', { catalog });
    expect(real.best).toBe('claim-safety');
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
