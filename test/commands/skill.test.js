'use strict';

const { describe, test, expect } = require('bun:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const skillCommand = require('../../lib/commands/skill');

const repoRoot = path.resolve(__dirname, '../..');

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

  test('unknown verb error advertises every supported verb (for, eval, scores)', () => {
    const res = skillCommand.handler(['bogus'], {});
    expect(res.success).toBe(false);
    // Tightened: the old `toContain('Supported: for')` passed trivially once the list grew.
    expect(res.error).toContain('eval');
    expect(res.error).toContain('scores');
  });

  test('exports the standard command interface', () => {
    expect(skillCommand.name).toBe('skill');
    expect(typeof skillCommand.description).toBe('string');
    expect(typeof skillCommand.handler).toBe('function');
  });
});

// ── forge skill scores (read-only) ────────────────────────────────────────────
describe('forge skill scores', () => {
  test('--json against the dev checkout returns scorecards + a gate + drift', () => {
    const res = skillCommand.handler(['scores', '--json'], {}, repoRoot);
    expect(res.success).toBe(true);
    const parsed = JSON.parse(res.output);
    expect(Object.keys(parsed.scorecards).length).toBeGreaterThan(0);
    expect(typeof parsed.gate.passed).toBe('boolean');
    expect(Array.isArray(parsed.drift)).toBe(true);
  });

  test('text mode renders the league-table header and a gate verdict line', () => {
    const res = skillCommand.handler(['scores'], {}, repoRoot);
    expect(res.success).toBe(true);
    expect(res.output).toContain('COMPOSITE');
    expect(res.output).toMatch(/CI gate: (PASS|FAIL)/);
  });

  // Finding A (consumer-repo resolution): a real installed project has no root skills/, and the
  // command MUST fall back to the packaged Forge skills instead of erroring.
  test('falls back to the packaged skills root when cwd has no skills/ (no mirror check)', () => {
    const consumer = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-scores-consumer-'));
    try {
      const res = skillCommand.handler(['scores', '--json'], {}, consumer);
      expect(res.success).toBe(true);
      const parsed = JSON.parse(res.output);
      expect(Object.keys(parsed.scorecards).length).toBeGreaterThan(0);
      // Packaged-root path: no mirror ships, so the mirror check is omitted -> no mirror drift.
      expect(parsed.drift.every(d => d.where !== 'mirror')).toBe(true);
    } finally {
      fs.rmSync(consumer, { recursive: true, force: true });
    }
  });

  // Finding: mirror drift must be gated by CONTEXT (which root was resolved), not by whether the
  // mirror dir happens to exist — otherwise a deleted mirror in a SOURCE checkout silently passes.
  test('a SOURCE checkout with a DELETED .agents mirror REPORTS drift (gate FAILS)', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-scores-source-'));
    try {
      const sdir = path.join(root, 'skills', 'demo');
      fs.mkdirSync(sdir, { recursive: true });
      fs.writeFileSync(
        path.join(sdir, 'SKILL.md'),
        '---\nname: demo\ndescription: Use this when exercising the source-checkout mirror gate. This is NOT a real ' +
          'skill and unlike ship it never runs; it only needs an adequately long, cue-bearing description string.\n---\nbody\n'
      );
      // Seed a FRESH canonical scorecard so the ONLY drift is the missing mirror. No .agents/skills exists here.
      expect(skillCommand.handler(['eval', 'demo', '--json'], {}, root).success).toBe(true);
      const res = skillCommand.handler(['scores', '--json'], {}, root);
      const parsed = JSON.parse(res.output);
      expect(parsed.drift.some(d => d.where === 'mirror')).toBe(true);
      expect(parsed.gate.passed).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  // Gate-contract: a FAILING gate MUST surface as a FAILING command result (success:false) so the
  // registry runner exits non-zero and CI running `forge skill scores` actually fails — instead of
  // exiting 0 while the output reads "CI gate: FAIL". The full table still rides along in output.
  test('a failing gate returns success:false with an error naming the failures (both text and --json)', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-scores-failgate-'));
    try {
      const sdir = path.join(root, 'skills', 'demo');
      fs.mkdirSync(sdir, { recursive: true });
      fs.writeFileSync(
        path.join(sdir, 'SKILL.md'),
        '---\nname: demo\ndescription: Use this when exercising the failing-gate command contract. This is NOT a real ' +
          'skill and unlike ship it never runs; it only needs an adequately long, cue-bearing description string.\n---\nbody\n'
      );
      // Seed a fresh canonical scorecard; the missing .agents mirror in this SOURCE checkout is the drift.
      expect(skillCommand.handler(['eval', 'demo', '--json'], {}, root).success).toBe(true);

      const jsonRes = skillCommand.handler(['scores', '--json'], {}, root);
      expect(jsonRes.gate.passed).toBe(false);
      expect(jsonRes.success).toBe(false);
      expect(typeof jsonRes.error).toBe('string');
      expect(jsonRes.error).toContain('gate');
      // The league table / gate detail still ride along for context even on failure.
      expect(jsonRes.output).toContain('scorecards');

      const textRes = skillCommand.handler(['scores'], {}, root);
      expect(textRes.success).toBe(false);
      expect(textRes.output).toContain('CI gate: FAIL');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  // Healthy path: a clean dev checkout (gate passes) keeps success:true and carries no error.
  test('a passing gate keeps success:true and sets no error', () => {
    const res = skillCommand.handler(['scores', '--json'], {}, repoRoot);
    expect(res.gate.passed).toBe(true);
    expect(res.success).toBe(true);
    expect(res.error).toBeUndefined();
  });
});

// ── forge skill eval (writes scorecard.json) ──────────────────────────────────
describe('forge skill eval', () => {
  test('--json writes and returns a scorecard for a temp skill (no repo mutation)', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-eval-cmd-'));
    try {
      const sdir = path.join(root, 'skills', 'demo');
      fs.mkdirSync(sdir, { recursive: true });
      fs.writeFileSync(
        path.join(sdir, 'SKILL.md'),
        '---\nname: demo\ndescription: Use this when demoing. This is NOT a real skill and unlike ship it never runs. ' +
          'It exists only to exercise the eval writer with an adequately long description string.\n---\nbody line 1\nbody line 2\n'
      );
      const res = skillCommand.handler(['eval', 'demo', '--json'], {}, root);
      expect(res.success).toBe(true);
      const parsed = JSON.parse(res.output);
      expect(parsed.skill).toBe('demo');
      expect(Number.isInteger(parsed.composite)).toBe(true);
      expect(fs.existsSync(path.join(sdir, 'evals', 'scorecard.json'))).toBe(true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("a named skill that does not exist returns a 'not found' error", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-eval-missing-'));
    try {
      fs.mkdirSync(path.join(root, 'skills'), { recursive: true });
      const res = skillCommand.handler(['eval', 'does-not-exist', '--json'], {}, root);
      expect(res.success).toBe(false);
      expect(res.error).toContain('not found');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

// ── formatScores rendering (unit) ─────────────────────────────────────────────
describe('formatScores', () => {
  const card = (skill, composite, fixtures) => ({
    skill,
    composite,
    fixtures,
    static: {
      description_quality: { score: 100 },
      token_cost: { score: 80 },
      caps: { score: 100 },
    },
  });

  test('renders worst-first rows, warnings, and a PASS verdict', () => {
    const scorecards = { plan: card('plan', 51, 'present'), memory: card('memory', 84, 'no-fixtures') };
    const gate = { passed: true, failures: [], warnings: [{ skill: 'kernel', detail: 'paraphrase gap' }] };
    const out = skillCommand._internal.formatScores(scorecards, gate);
    expect(out.indexOf('plan')).toBeLessThan(out.indexOf('memory')); // worst first
    expect(out).toContain('no-fixtures');
    expect(out).toContain('paraphrase gap');
    expect(out).toContain('CI gate: PASS');
  });

  test('renders a FAIL verdict with the failing skill + kind', () => {
    const scorecards = { ship: card('ship', 78, 'present') };
    const gate = { passed: false, failures: [{ skill: 'ship', kind: 'scorecard_drift', detail: 'mirror: stale' }], warnings: [] };
    const out = skillCommand._internal.formatScores(scorecards, gate);
    expect(out).toContain('CI gate: FAIL');
    expect(out).toContain('scorecard_drift');
  });
});
