const { describe, test, expect } = require('bun:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// ─── static skill-eval scorer (W3) ────────────────────────────────────────────
//
// The STATIC tier is DETERMINISTIC and free: it scores only the parameters that
// can be measured without an LLM or network — token cost, cap compliance, and a
// description-quality heuristic (the PR #292 pattern). TRUE trigger recall/
// precision is inherently SEMANTIC (the evals.json fixtures are paraphrases), so
// it belongs to the W5 behavioral tier and lives here only as a typed placeholder.
//
// This file is BOTH the unit spec for the scorer and the CI GATE: it recomputes
// scorecards from the canonical skills/ source and fails on a cap violation, a
// description-quality regression, a committed-scorecard drift, or a fixtured skill
// the deterministic router can NEVER reach (no curated rule + not router-exempt).

const {
  DESC_CAP,
  BODY_CAP,
  WEIGHTS,
  DESC_QUALITY_FLOOR,
  scoreTokenCost,
  scoreCaps,
  scoreDescriptionQuality,
  composite,
  routerReachability,
  behavioralPlaceholders,
  buildScorecard,
  buildAllScorecards,
  evaluateGate,
  parseSkillSource,
  resolveSkillsDir,
  resolveSkillsContext,
  detectScorecardDrift,
} = require('../lib/skill-eval');

const { loadSkillCatalog } = require('../lib/using-forge');

const repoRoot = path.resolve(__dirname, '..');
const skillsDir = path.join(repoRoot, 'skills');

// ── token cost ────────────────────────────────────────────────────────────────
describe('scoreTokenCost', () => {
  test('a zero-cost skill scores 100 (lower cost is better)', () => {
    expect(scoreTokenCost({ descLen: 0, bodyLines: 0 }).score).toBe(100);
  });

  test('a skill at both caps scores 0', () => {
    expect(scoreTokenCost({ descLen: DESC_CAP, bodyLines: BODY_CAP }).score).toBe(0);
  });

  test('half-budget on both axes scores 50', () => {
    expect(scoreTokenCost({ descLen: DESC_CAP / 2, bodyLines: BODY_CAP / 2 }).score).toBe(50);
  });

  test('over-cap inputs clamp (never negative)', () => {
    expect(scoreTokenCost({ descLen: DESC_CAP * 4, bodyLines: BODY_CAP * 4 }).score).toBe(0);
  });

  test('echoes the raw measurements', () => {
    const r = scoreTokenCost({ descLen: 300, bodyLines: 120 });
    expect(r.desc_chars).toBe(300);
    expect(r.body_lines).toBe(120);
  });
});

// ── caps ────────────────────────────────────────────────────────────────────
describe('scoreCaps', () => {
  test('within both caps scores 100', () => {
    const r = scoreCaps({ descLen: 500, bodyLines: 200, allowlisted: false });
    expect(r.score).toBe(100);
    expect(r.desc_within).toBe(true);
    expect(r.body_within).toBe(true);
  });

  test('description over the cap fails (score 0)', () => {
    expect(scoreCaps({ descLen: DESC_CAP + 1, bodyLines: 10, allowlisted: false }).score).toBe(0);
  });

  test('body over the cap fails when NOT allowlisted', () => {
    const r = scoreCaps({ descLen: 100, bodyLines: BODY_CAP + 1, allowlisted: false });
    expect(r.score).toBe(0);
    expect(r.body_within).toBe(false);
  });

  test('body over the cap PASSES when allowlisted (e.g. plan)', () => {
    expect(scoreCaps({ descLen: 100, bodyLines: BODY_CAP + 30, allowlisted: true }).score).toBe(100);
  });
});

// ── description quality (PR #292 pattern) ─────────────────────────────────────
describe('scoreDescriptionQuality', () => {
  test('trigger phrases + disambiguation cues + adequate length scores 100', () => {
    const desc =
      'Use this when the user wants to open a pull request. This is NOT the review skill and unlike ship it never merges. '.repeat(2);
    const r = scoreDescriptionQuality(desc);
    expect(r.has_trigger_cues).toBe(true);
    expect(r.has_disambiguation_cues).toBe(true);
    expect(r.adequate_length).toBe(true);
    expect(r.score).toBe(100);
  });

  test('missing trigger cues drops the score below 100', () => {
    const desc = 'This skill opens pull requests. It is not the review skill. '.repeat(3);
    const r = scoreDescriptionQuality(desc);
    expect(r.has_trigger_cues).toBe(false);
    expect(r.score).toBeLessThan(100);
  });

  test('a too-short description loses the adequate-length points', () => {
    const r = scoreDescriptionQuality('Use when shipping.');
    expect(r.adequate_length).toBe(false);
  });
});

// ── composite ─────────────────────────────────────────────────────────────────
describe('composite', () => {
  test('applies the documented weighting', () => {
    const value = composite({
      tokenCost: { score: 80 },
      caps: { score: 100 },
      descQuality: { score: 100 },
    });
    // 0.5*100 + 0.3*80 + 0.2*100 = 94
    expect(value).toBe(94);
  });

  test('weights sum to 1', () => {
    const sum = WEIGHTS.description_quality + WEIGHTS.token_cost + WEIGHTS.caps;
    expect(Math.round(sum * 1000) / 1000).toBe(1);
  });

  test('is an integer in 0..100', () => {
    const value = composite({ tokenCost: { score: 33 }, caps: { score: 0 }, descQuality: { score: 61 } });
    expect(Number.isInteger(value)).toBe(true);
    expect(value).toBeGreaterThanOrEqual(0);
    expect(value).toBeLessThanOrEqual(100);
  });
});

// ── behavioral placeholders (W5) ──────────────────────────────────────────────
describe('behavioralPlaceholders', () => {
  test('all behavioral params are typed null and labeled W5', () => {
    const b = behavioralPlaceholders();
    for (const key of ['trigger_recall', 'trigger_precision', 'disambiguation', 'chain_correctness', 'outcome_quality', 'variance']) {
      expect(b[key]).toBeNull();
    }
    expect(String(b.note).toLowerCase()).toContain('w5');
  });
});

// ── router reachability lint (B) — deterministic, uses routeSkill ─────────────
describe('routerReachability', () => {
  const catalog = [
    { name: 'ship', description: 'open a pr' },
    { name: 'dev', description: 'fix a bug' },
    { name: 'adapter-x', description: 'internal adapter' },
  ];

  test('a fixtured skill with a curated rule and a matching fixture is reachable', () => {
    const r = routerReachability({
      name: 'ship',
      fixtures: [{ query: 'open a pr for this branch', should_trigger: true }],
      catalog,
      hasRule: true,
      exempt: false,
    });
    expect(r.has_curated_rule).toBe(true);
    expect(r.reachable).toBe(true);
    expect(r.fixtures_best_hit).toBeGreaterThanOrEqual(1);
  });

  test('a fixtured skill with NO rule and NOT exempt is a hard defect (unreachable)', () => {
    const r = routerReachability({
      name: 'adapter-x',
      fixtures: [{ query: 'do the adapter thing', should_trigger: true }],
      catalog,
      hasRule: false,
      exempt: false,
    });
    expect(r.has_curated_rule).toBe(false);
    expect(r.router_exempt).toBe(false);
    expect(r.reachable).toBe(false);
  });

  test('a skill without fixtures is marked no-fixtures, not crashed', () => {
    const r = routerReachability({ name: 'memory', fixtures: null, catalog, hasRule: true, exempt: false });
    expect(r.fixtures).toBe('no-fixtures');
    expect(r.has_curated_rule).toBe(true);
  });
});

// ── scorecard shape ──────────────────────────────────────────────────────────
describe('buildScorecard', () => {
  const catalog = loadSkillCatalog(repoRoot);

  test('a real fixtured skill produces a complete, typed scorecard', () => {
    const card = buildScorecard({ skillsDir, name: 'ship', catalog });
    expect(card.skill).toBe('ship');
    expect(card.fixtures).toBe('present');
    expect(card.static.token_cost.score).toBeGreaterThanOrEqual(0);
    expect(card.static.caps.score).toBe(100);
    expect(card.static.description_quality.score).toBeGreaterThanOrEqual(DESC_QUALITY_FLOOR);
    expect(Number.isInteger(card.composite)).toBe(true);
    // behavioral tier is a placeholder, never fabricated
    expect(card.behavioral.trigger_recall).toBeNull();
  });

  test('a skill WITHOUT fixtures still scores the deterministic params (no crash)', () => {
    const card = buildScorecard({ skillsDir, name: 'using-forge', catalog });
    expect(card.fixtures).toBe('no-fixtures');
    expect(Number.isInteger(card.composite)).toBe(true);
    expect(card.static.description_quality.score).toBeGreaterThanOrEqual(0);
  });
});

// ── the CI gate ────────────────────────────────────────────────────────────────
describe('evaluateGate (CI gate)', () => {
  const catalog = loadSkillCatalog(repoRoot);
  const scorecards = buildAllScorecards(skillsDir, catalog);

  test('every skill in the canonical library PASSES the gate today', () => {
    const result = evaluateGate(scorecards);
    if (!result.passed) {
      throw new Error('Static skill-eval gate failures:\n' + result.failures.map(f => `  ${f.skill}: ${f.kind} — ${f.detail}`).join('\n'));
    }
    expect(result.passed).toBe(true);
  });

  test('the gate FAILS on a seeded description over the char cap', () => {
    const seeded = { ...scorecards };
    seeded.__seed_cap = buildSeed({ caps: { score: 0, desc_within: false, body_within: true } });
    const result = evaluateGate(seeded);
    expect(result.passed).toBe(false);
    expect(result.failures.some(f => f.skill === '__seed_cap' && f.kind === 'caps')).toBe(true);
  });

  test('the gate FAILS on a seeded description-quality regression', () => {
    const seeded = { ...scorecards };
    seeded.__seed_dq = buildSeed({ description_quality: { score: DESC_QUALITY_FLOOR - 20 } });
    const result = evaluateGate(seeded);
    expect(result.passed).toBe(false);
    expect(result.failures.some(f => f.skill === '__seed_dq' && f.kind === 'description_quality')).toBe(true);
  });

  test('the gate FAILS on a fixtured skill the router can never reach', () => {
    const seeded = { ...scorecards };
    seeded.__seed_unreachable = buildSeed({
      router_reachability: { has_curated_rule: false, router_exempt: false, fixtures: 'present', reachable: false },
    });
    const result = evaluateGate(seeded);
    expect(result.passed).toBe(false);
    expect(result.failures.some(f => f.skill === '__seed_unreachable' && f.kind === 'router_unreachable')).toBe(true);
  });

  test('a fixtured skill with a rule but zero keyword-covered fixtures is a WARNING, not a hard fail', () => {
    const seeded = { ...scorecards };
    seeded.__seed_softmiss = buildSeed({
      router_reachability: { has_curated_rule: true, router_exempt: false, fixtures: 'present', reachable: false },
    });
    const result = evaluateGate(seeded);
    // reachable:false with a rule present is the paraphrase-vs-keyword gap (W5's job): a warning only.
    expect(result.failures.some(f => f.skill === '__seed_softmiss' && f.kind === 'router_unreachable')).toBe(false);
    expect(result.warnings.some(w => w.skill === '__seed_softmiss')).toBe(true);
  });
});

// A minimal, fully-passing scorecard, with a targeted field override for seeding regressions.
function buildSeed(overrides = {}) {
  const base = {
    skill: 'seed',
    fixtures: 'present',
    static: {
      token_cost: { desc_chars: 100, body_lines: 50, score: 90 },
      caps: { desc_within: true, body_within: true, score: 100 },
      description_quality: { has_trigger_cues: true, has_disambiguation_cues: true, adequate_length: true, score: 100 },
    },
    router_reachability: { has_curated_rule: true, router_exempt: false, fixtures: 'present', reachable: true, fixtures_total: 1, fixtures_best_hit: 1 },
    behavioral: behavioralPlaceholders(),
    composite: 95,
  };
  if (overrides.caps) base.static.caps = { ...base.static.caps, ...overrides.caps };
  if (overrides.description_quality) base.static.description_quality = { ...base.static.description_quality, ...overrides.description_quality };
  if (overrides.router_reachability) base.router_reachability = { ...base.router_reachability, ...overrides.router_reachability };
  return base;
}

// ── committed-artifact drift (canonical AND the .agents/skills mirror) ─────────
describe('committed scorecards stay fresh', () => {
  const catalog = loadSkillCatalog(repoRoot);
  const mirrorDir = path.join(repoRoot, '.agents', 'skills');
  const freshCards = buildAllScorecards(skillsDir, catalog);

  test('canonical AND mirror scorecard.json each equal the recomputed card', () => {
    const drift = detectScorecardDrift({ skillsDir, freshCards, mirrorDir });
    if (drift.length) {
      throw new Error('Scorecard drift:\n' + drift.map(d => `  ${d.skill} [${d.where}]: ${d.reason}`).join('\n'));
    }
    expect(drift).toEqual([]);
  });

  test('detectScorecardDrift flags a mirror that is missing a card', () => {
    // Point the mirror at an empty temp dir: every skill should be reported as mirror-missing,
    // proving the mirror is gated (not just the canonical tree).
    const emptyMirror = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-eval-mirror-'));
    const drift = detectScorecardDrift({ skillsDir, freshCards, mirrorDir: emptyMirror });
    expect(drift.some(d => d.where === 'mirror')).toBe(true);
    fs.rmSync(emptyMirror, { recursive: true, force: true });
  });

  test('a TOTALLY absent mirror dir still reports drift (no existsSync guard hides total loss)', () => {
    // A path that does not exist at all — the worst case (mirror deleted / fresh checkout). The
    // guard-free check must report mirror drift for every skill, not silently pass.
    const gone = path.join(os.tmpdir(), 'skill-eval-nonexistent-mirror-' + Date.now());
    expect(fs.existsSync(gone)).toBe(false);
    const drift = detectScorecardDrift({ skillsDir, freshCards, mirrorDir: gone });
    const mirrorDrift = drift.filter(d => d.where === 'mirror');
    expect(mirrorDrift.length).toBe(Object.keys(freshCards).length);
  });
});

// ── shared consumer-repo resolver (finding A: un-regressable) ──────────────────
describe('resolveSkillsDir / resolveSkillsContext', () => {
  test('a dev checkout resolves its own skills/ dir', () => {
    expect(resolveSkillsDir(repoRoot)).toBe(skillsDir);
  });

  test('a consumer project with NO skills/ falls back to the packaged skills root', () => {
    const noSkills = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-eval-consumer-'));
    const resolved = resolveSkillsDir(noSkills);
    // Must NOT be null and must NOT be the (skill-less) consumer dir — it falls back to the package.
    expect(resolved).not.toBeNull();
    expect(resolved.startsWith(noSkills)).toBe(false);
    const ctx = resolveSkillsContext(noSkills);
    expect(ctx).not.toBeNull();
    expect(ctx.catalog.length).toBeGreaterThan(0);
    fs.rmSync(noSkills, { recursive: true, force: true });
  });

  test('a project with an EMPTY skills/ dir (no */SKILL.md) also falls back to the package', () => {
    const emptySkills = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-eval-empty-'));
    fs.mkdirSync(path.join(emptySkills, 'skills', 'not-a-skill'), { recursive: true }); // dir, but no SKILL.md
    const resolved = resolveSkillsDir(emptySkills);
    expect(resolved).not.toBeNull();
    expect(resolved.startsWith(emptySkills)).toBe(false); // did NOT select the skill-less dir
    fs.rmSync(emptySkills, { recursive: true, force: true });
  });
});

// ── evaluateGate is drift-aware (finding B) ───────────────────────────────────
describe('evaluateGate drift-awareness', () => {
  const catalog = loadSkillCatalog(repoRoot);
  const freshCards = buildAllScorecards(skillsDir, catalog);

  test('a drift entry makes the gate FAIL even when every card is otherwise clean', () => {
    const result = evaluateGate(freshCards, { drift: [{ skill: 'ship', where: 'mirror', reason: 'stale' }] });
    expect(result.passed).toBe(false);
    expect(result.failures.some(f => f.kind === 'scorecard_drift' && f.skill === 'ship')).toBe(true);
  });

  test('no drift + clean cards still PASS', () => {
    expect(evaluateGate(freshCards, { drift: [] }).passed).toBe(true);
  });
});

// ── invalid vs absent fixtures (a broken evals.json must FAIL the gate) ───────
describe('invalid fixtures', () => {
  const DESC = 'Use this when you want to exercise the fixture-state gate path. This is NOT a real skill and ' +
    'unlike ship it never runs; it exists only to give the scorer an adequately long, cue-bearing description.';

  function tempSkill(evalsContent) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-eval-fx-'));
    const sdir = path.join(root, 'skills', 'demo');
    fs.mkdirSync(sdir, { recursive: true });
    fs.writeFileSync(path.join(sdir, 'SKILL.md'), `---\nname: demo\ndescription: ${DESC}\n---\nbody line 1\nbody line 2\n`);
    if (evalsContent !== undefined) {
      fs.mkdirSync(path.join(sdir, 'evals'), { recursive: true });
      fs.writeFileSync(path.join(sdir, 'evals', 'evals.json'), evalsContent);
    }
    return { root, skillsDir: path.join(root, 'skills') };
  }

  test('ABSENT evals.json -> no-fixtures, gate unaffected (passes)', () => {
    const { root, skillsDir: sd } = tempSkill(undefined);
    try {
      const card = buildScorecard({ skillsDir: sd, name: 'demo', catalog: [] });
      expect(card.fixtures).toBe('no-fixtures');
      const gate = evaluateGate({ demo: card });
      expect(gate.passed).toBe(true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('MALFORMED evals.json -> fixtures:invalid, gate FAILS naming the skill + reason', () => {
    const { root, skillsDir: sd } = tempSkill('{ this is not valid json');
    try {
      const card = buildScorecard({ skillsDir: sd, name: 'demo', catalog: [] });
      expect(card.fixtures).toBe('invalid');
      expect(String(card.router_reachability.error)).toContain('malformed');
      const gate = evaluateGate({ demo: card });
      expect(gate.passed).toBe(false);
      const fail = gate.failures.find(f => f.skill === 'demo' && f.kind === 'invalid_fixtures');
      expect(fail).toBeTruthy();
      expect(fail.detail.length).toBeGreaterThan(0);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('valid JSON that is NOT an array -> fixtures:invalid, gate FAILS', () => {
    const { root, skillsDir: sd } = tempSkill('{"query":"x","should_trigger":true}');
    try {
      const card = buildScorecard({ skillsDir: sd, name: 'demo', catalog: [] });
      expect(card.fixtures).toBe('invalid');
      expect(String(card.router_reachability.error)).toContain('not a JSON array');
      expect(evaluateGate({ demo: card }).passed).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

// ── parseSkillSource matches the context-cost parser ──────────────────────────
describe('parseSkillSource', () => {
  test('parses a temp SKILL.md into description + body-line count', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-eval-'));
    const sdir = path.join(dir, 'skills', 'demo');
    fs.mkdirSync(sdir, { recursive: true });
    fs.writeFileSync(
      path.join(sdir, 'SKILL.md'),
      '---\nname: demo\ndescription: Use when demoing. NOT real.\n---\nbody line 1\nbody line 2\n'
    );
    const parsed = parseSkillSource(path.join(dir, 'skills'), 'demo');
    expect(parsed.name).toBe('demo');
    expect(parsed.description).toContain('Use when demoing');
    expect(parsed.bodyLines).toBeGreaterThanOrEqual(2);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
