'use strict';

// Skill-accuracy lint (targeted lane). Enforces two dimensions that adversarial
// review repeatedly flagged one instance at a time on the batch-1 skills PR:
//   A. DOCUMENTATION — a command that coverage.json maps to a skill must actually
//      be documented in that skill's SKILL.md body (else the mapping is hollow:
//      the coverage gate passes but an agent routed there is not taught the command).
//   B. ROUTER PRECISION — a fixture a skill declares it should NOT trigger on
//      (should_trigger:false) must NOT be selected by the deterministic router
//      for that skill (else a keyword over-matches, e.g. "SonarCloud gate status").
// Both are STATIC (no command execution), so they run in the ~30s targeted lane.
//
// Not yet enforced here (need a prerequisite, tracked separately):
//   - flag reachability (the CLI has many parse paths — passthrough, per-command
//     allowlists, self-parsing handlers — so a naive check is ~45 false positives;
//     needs the parseFlags unification in 07c3daf6);
//   - full command-name routability (needs deterministic coverage-driven routing,
//     7920f747);
//   - functional smoke (display commands emit output) — needs an execution harness.

const { describe, test, expect, beforeEach, afterEach } = require('bun:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  auditCommandDocumentation,
  auditRouterPrecision,
  loadCoverageMap,
  resolveSkillsDir,
} = require('../lib/skill-eval');
const { loadSkillCatalog } = require('../lib/using-forge');

const ROOT = path.join(__dirname, '..');
const skillsDir = resolveSkillsDir(ROOT);

// Deterministic keyword-collision guards: each query must NOT route to the named skill.
// These are the exact over-matches surfaced during the batch-1 review (a bare `gate
// status` cue capturing a SonarCloud question; `worktree for` capturing a PR request).
const PRECISION_CASES = [
  { query: 'SonarCloud gate status for this PR', skill: 'gates' },
  { query: 'Open a pull request from the worktree for this feature.', skill: 'worktree' },
  { query: 'run validation in this worktree', skill: 'worktree' },
];

// ---------------------------------------------------------------------------
// Integration: the real shipped skills must satisfy both dimensions.
// ---------------------------------------------------------------------------
describe('skill accuracy — shipped skills', () => {
  test('every non-exempt mapped command is documented in its owning skill body', () => {
    const coverage = loadCoverageMap(skillsDir);
    expect(coverage).toBeTruthy();
    const violations = auditCommandDocumentation({ skillsDir, coverage });
    // A non-empty list means a coverage mapping is hollow: fix by documenting the
    // command in the owning skill body, or revert it to exempt with a reason.
    expect(violations).toEqual([]);
  });

  test('curated keyword-collision queries do not over-match their skill', () => {
    // loadSkillCatalog expects the ROOT that CONTAINS skills/, not the skills dir
    // itself — passing skillsDir yields an empty catalog and a vacuous no-op test.
    const catalog = loadSkillCatalog(ROOT);
    expect(catalog.length).toBeGreaterThan(0); // guard: never let this assertion no-op
    const violations = auditRouterPrecision({ cases: PRECISION_CASES, catalog });
    // A non-empty list means a curated keyword over-matches a phrase it should not own:
    // narrow the keyword (or add a more specific competing cue).
    expect(violations).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Unit: synthetic skills dir so the detectors are proven, not just asserted-empty.
// ---------------------------------------------------------------------------
describe('auditCommandDocumentation — detector', () => {
  let dir;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'skacc-')); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  function writeSkill(name, body) {
    fs.mkdirSync(path.join(dir, name), { recursive: true });
    fs.writeFileSync(path.join(dir, name, 'SKILL.md'), `---\nname: ${name}\ndescription: x\n---\n${body}\n`);
  }

  test('flags a hollow mapping (command absent from the owning skill body)', () => {
    writeSkill('issue-basics', 'Create and close issues here. `forge issue create`.');
    const coverage = { commands: { orphans: 'issue-basics' } };
    const v = auditCommandDocumentation({ skillsDir: dir, coverage });
    expect(v.map(x => x.command)).toContain('orphans');
  });

  test('passes when the command IS documented in the body', () => {
    writeSkill('issue-basics', 'Find `forge issue orphans` (dangling deps).');
    const coverage = { commands: { orphans: 'issue-basics' } };
    expect(auditCommandDocumentation({ skillsDir: dir, coverage })).toEqual([]);
  });

  test('a self-titled skill documents its own command implicitly', () => {
    writeSkill('plan', 'This skill designs a feature.'); // no literal "forge plan"
    const coverage = { commands: { plan: 'plan' } };
    expect(auditCommandDocumentation({ skillsDir: dir, coverage })).toEqual([]);
  });

  test('exempt entries (object values) are skipped', () => {
    writeSkill('issue-basics', 'issues here');
    const coverage = { commands: { orphans: { exempt: 'pending' } } };
    expect(auditCommandDocumentation({ skillsDir: dir, coverage })).toEqual([]);
  });
});

describe('auditRouterPrecision — detector', () => {
  test('flags a case that routes to the disclaimed skill', () => {
    // Inject a router that (wrongly) routes the 'status' query to gates.
    const route = (q) => ({ best: q === 'status' ? 'gates' : 'other' });
    const v = auditRouterPrecision({ cases: [{ query: 'status', skill: 'gates' }], catalog: [], route });
    expect(v.map(x => x.query)).toContain('status');
  });

  test('passes when the case routes elsewhere', () => {
    const route = () => ({ best: 'ship' });
    const cases = [{ query: 'open a pull request', skill: 'gates' }];
    expect(auditRouterPrecision({ cases, catalog: [], route })).toEqual([]);
  });

  test('ignores malformed cases', () => {
    const route = () => ({ best: 'gates' });
    expect(auditRouterPrecision({ cases: [null, { query: 'x' }, { skill: 'y' }], catalog: [], route })).toEqual([]);
  });
});
