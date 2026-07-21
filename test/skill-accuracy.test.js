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

  test('no should_trigger:false fixture routes to its own skill', () => {
    const catalog = loadSkillCatalog(skillsDir);
    const violations = auditRouterPrecision({ skillsDir, catalog });
    // A non-empty list means a keyword over-matches a case the skill disclaims:
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
  let dir;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'skacc-')); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  function writeSkillWithFixtures(name, fixtures) {
    fs.mkdirSync(path.join(dir, name, 'evals'), { recursive: true });
    fs.writeFileSync(path.join(dir, name, 'SKILL.md'), `---\nname: ${name}\ndescription: x\n---\nbody\n`);
    fs.writeFileSync(path.join(dir, name, 'evals', 'evals.json'), JSON.stringify(fixtures));
  }

  test('flags a should_trigger:false fixture that the router routes to the skill', () => {
    writeSkillWithFixtures('gates', [
      { query: 'disable the gate', should_trigger: true },
      { query: 'status', should_trigger: false },
    ]);
    const catalog = [{ name: 'gates', description: '' }];
    // Inject a router that (wrongly) routes the disclaimed 'status' query to gates.
    const route = (q) => ({ best: q === 'status' ? 'gates' : 'other' });
    const v = auditRouterPrecision({ skillsDir: dir, catalog, route });
    expect(v.map(x => x.query)).toContain('status');
  });

  test('passes when disclaimed fixtures route elsewhere', () => {
    writeSkillWithFixtures('gates', [
      { query: 'disable the gate', should_trigger: true },
      { query: 'open a pull request', should_trigger: false },
    ]);
    const catalog = [{ name: 'gates', description: '' }];
    const route = (q) => ({ best: q === 'open a pull request' ? 'ship' : 'gates' });
    expect(auditRouterPrecision({ skillsDir: dir, catalog, route })).toEqual([]);
  });
});
