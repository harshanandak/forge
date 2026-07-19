'use strict';

const { describe, test, expect } = require('bun:test');
const fs = require('node:fs');
const path = require('node:path');
const YAML = require('yaml');

const {
  getSubSkillIds,
  getSubSkillDefinitions,
  validateSubSkillList,
  validatePlanSubSkillList,
  SUBSKILL_REGISTRY,
} = require('../../lib/core/runtime-graph');

const repoRoot = path.resolve(__dirname, '../..');
const skillsDir = path.join(repoRoot, 'skills');

// ---------------------------------------------------------------------------
// Canonical chain graph (W2). Each stage skill declares the FOLLOWING stage as
// its `next`; the linear ladder is plan → dev → validate → ship → review →
// verify, and `verify` is TERMINAL (post-merge health check, nothing after).
// Utilities are terminal (no forward-stage next). Meta skills are EXEMPT from
// the chain rules (hermes-forge is a harness adapter, not a chain/route target).
// ---------------------------------------------------------------------------
const STAGE_CHAIN = ['plan', 'dev', 'validate', 'ship', 'review', 'verify'];
const STAGE_NEXT = {
  plan: 'dev',
  dev: 'validate',
  validate: 'ship',
  ship: 'review',
  review: 'verify',
  // verify → terminal
};
// Feeders point INTO the chain. triage-ready routes through claim-safety (prove
// the live lease before work starts) — NOT straight to plan, which would bypass
// lease safety. `research` is intentionally NOT a feeder: it is standalone /
// callable mid-workflow and returns to its CALLER, so it declares no forced
// `next` (it is terminal + a subskill of plan).
const FEEDER_NEXT = {
  'triage-ready': 'claim-safety',
};
const TERMINAL_SKILLS = [
  'verify',
  'research',
  'status',
  'shepherd',
  'kernel',
  'issue-basics',
  'claim-safety',
  'memory',
  'rollback',
  'sonarcloud',
  'sonarcloud-analysis',
  'parallel-deep-research',
  'using-forge',
  'smith',
];
const EXEMPT_SKILLS = ['hermes-forge'];

function listSkillDirs() {
  return fs.readdirSync(skillsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .filter((entry) => fs.existsSync(path.join(skillsDir, entry.name, 'SKILL.md')))
    .map((entry) => entry.name)
    .sort();
}

function readSkill(name) {
  return fs.readFileSync(path.join(skillsDir, name, 'SKILL.md'), 'utf8');
}

function parseFrontmatter(name) {
  const content = readSkill(name);
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) throw new Error(`${name}: no YAML frontmatter block`);
  return YAML.parse(match[1]) || {};
}

const SKILL_DIRS = listSkillDirs();
const SKILL_SET = new Set(SKILL_DIRS);
const FM = Object.fromEntries(SKILL_DIRS.map((name) => [name, parseFrontmatter(name)]));

describe('skill chain metadata (frontmatter dual-encoding)', () => {
  for (const name of SKILL_DIRS) {
    test(`${name}: chain frontmatter is well-formed`, () => {
      const fm = FM[name];
      if (EXEMPT_SKILLS.includes(name)) {
        // Meta skill — must opt out of the chain explicitly.
        expect(fm.chainExempt).toBe(true);
        return;
      }
      // Non-exempt: must carry a `terminal` boolean.
      expect(typeof fm.terminal).toBe('boolean');
      // No orphan: a non-terminal skill MUST declare a `next` successor.
      if (fm.terminal === false) {
        expect(typeof fm.next).toBe('string');
        expect(fm.next.trim().length).toBeGreaterThan(0);
      }
      // A terminal skill must NOT declare a forward-stage `next`.
      if (fm.terminal === true) {
        expect(fm.next === undefined || fm.next === null).toBeTruthy();
      }
    });

    test(`${name}: next/handoffs/subskills targets are real skill dirs`, () => {
      const fm = FM[name];
      if (fm.next) expect(SKILL_SET.has(fm.next)).toBeTruthy();
      for (const h of fm.handoffs || []) expect(SKILL_SET.has(h)).toBeTruthy();
      for (const s of fm.subskills || []) expect(SKILL_SET.has(s)).toBeTruthy();
    });
  }
});

describe('linear stage chain plan → dev → validate → ship → review → verify', () => {
  for (const [from, to] of Object.entries(STAGE_NEXT)) {
    test(`${from}.next === ${to}`, () => {
      expect(FM[from].next).toBe(to);
      expect(FM[from].terminal).toBe(false);
    });
  }

  test('verify is terminal (end of the linear chain)', () => {
    expect(FM.verify.terminal).toBe(true);
    expect(FM.verify.next === undefined || FM.verify.next === null).toBeTruthy();
  });

  test('walking `next` from plan visits every stage in order and terminates at verify', () => {
    const walked = [];
    let cursor = 'plan';
    const seen = new Set();
    while (cursor && !seen.has(cursor)) {
      seen.add(cursor);
      walked.push(cursor);
      cursor = FM[cursor].next;
    }
    expect(walked).toEqual(STAGE_CHAIN);
    expect(FM[walked[walked.length - 1]].terminal).toBe(true);
  });
});

// The dual-encoding's BODY half: each stage skill carries a model-facing
// HARD-GATE chain line (the instruction the agent actually obeys). This must
// stay in agreement with the frontmatter `next` — a future edit that changes
// frontmatter but leaves stale body prose is exactly what this catches.
function chainGateLine(name) {
  const body = readSkill(name).replace(/^---\r?\n[\s\S]*?\r?\n---/, '');
  return body.split(/\r?\n/).find((l) => l.includes('Chain (HARD-GATE)'));
}

describe('stage skills carry the HARD-GATE body chain line (body half of the dual-encoding)', () => {
  for (const name of STAGE_CHAIN) {
    test(`${name}: body has a "Chain (HARD-GATE)" line`, () => {
      expect(typeof chainGateLine(name)).toBe('string');
    });

    test(`${name}: the successor named in the body agrees with frontmatter next`, () => {
      const line = chainGateLine(name);
      const fm = FM[name];
      if (fm.terminal === true) {
        // verify — terminal; the body must say so and name no successor.
        expect(line.toUpperCase()).toContain('TERMINAL');
      } else {
        // The frontmatter successor must be named (backtick-quoted) in the body line.
        expect(line).toContain('`' + fm.next + '`');
      }
    });
  }
});

describe('feeder skills point into the chain', () => {
  for (const [from, to] of Object.entries(FEEDER_NEXT)) {
    test(`${from}.next === ${to}`, () => {
      expect(FM[from].next).toBe(to);
    });
  }

  test('review can hand off to shepherd, and shepherd points back to review (bidirectional)', () => {
    expect(FM.review.handoffs || []).toContain('shepherd');
    expect(FM.shepherd.handoffs || []).toContain('review');
  });
});

describe('terminal / utility skills', () => {
  for (const name of TERMINAL_SKILLS) {
    test(`${name} is terminal:true`, () => {
      expect(FM[name].terminal).toBe(true);
    });
  }
});

describe('smith orchestrator composes the whole chain via the generic registry', () => {
  test('smith declares the 6 stage skills as subskills', () => {
    expect(FM.smith.subskills).toEqual(STAGE_CHAIN);
  });

  test('smith subskills resolve through the generic sub-skill registry (keyed by owner)', () => {
    const registryIds = getSubSkillIds('smith');
    for (const stage of FM.smith.subskills) {
      expect(registryIds.has(stage)).toBeTruthy();
    }
    // Registry is keyed by owner, not hardcoded to plan.
    expect(SUBSKILL_REGISTRY).toHaveProperty('smith');
    expect(SUBSKILL_REGISTRY).toHaveProperty('plan');
  });
});

describe('plan references research as a subskill (research/plan inversion)', () => {
  test('plan declares research as a subskill', () => {
    expect(FM.plan.subskills || []).toContain('research');
  });

  test('research owns its own Plan-bundle logic (OWASP + TDD scenarios)', () => {
    const body = readSkill('research');
    expect(body).toContain('OWASP');
    expect(body.toLowerCase()).toContain('tdd scenario');
    expect(body).toContain('Plan bundle');
  });

  test('plan delegates the technical bundle to the research skill (does not re-own it)', () => {
    const body = readSkill('plan');
    expect(body).toContain('Skill("research")');
  });
});

describe('kernel umbrella carries the chain map (index of the chain)', () => {
  test('kernel references the stage ladder and the smith orchestrator', () => {
    const body = readSkill('kernel');
    for (const stage of STAGE_CHAIN) expect(body).toContain(stage);
    expect(body).toContain('smith');
  });

  test('all stages are reachable from the kernel index (via smith subskills + next-walk)', () => {
    // kernel indexes smith; smith composes plan; plan chains to verify.
    const fromSmith = new Set(FM.smith.subskills);
    let cursor = 'plan';
    const seen = new Set();
    while (cursor && !seen.has(cursor)) {
      seen.add(cursor);
      cursor = FM[cursor].next;
    }
    for (const stage of STAGE_CHAIN) {
      expect(fromSmith.has(stage) || seen.has(stage)).toBeTruthy();
    }
  });
});

describe('generic sub-skill registry (backward compatible with plan)', () => {
  test('plan sub-skill definitions still resolve (backward compatible)', () => {
    const defs = getSubSkillDefinitions('plan');
    expect(defs.length).toBeGreaterThan(0);
    const ids = defs.map((d) => d.id);
    expect(ids).toContain('plan.intent_capture');
  });

  test('validatePlanSubSkillList still validates known plan sub-skill ids', () => {
    const errors = [];
    const out = validatePlanSubSkillList(['plan.intent_capture', 'plan.final_lock'], errors, 'test');
    expect(errors).toEqual([]);
    expect(out).toEqual(['plan.intent_capture', 'plan.final_lock']);
  });

  test('validateSubSkillList is generic (keyed by owner) and rejects unknown ids', () => {
    const errors = [];
    const out = validateSubSkillList('plan', ['plan.nope'], errors, 'test');
    expect(out).toBeUndefined();
    expect(errors.length).toBeGreaterThan(0);
  });

  test('validateSubSkillList resolves smith stage subskills', () => {
    const errors = [];
    const out = validateSubSkillList('smith', ['plan', 'dev', 'verify'], errors, 'test');
    expect(errors).toEqual([]);
    expect(out).toEqual(['plan', 'dev', 'verify']);
  });

  // Reconciliation: a skill's ADVERTISED frontmatter subskills must resolve
  // through the same generic registry (frontmatter is the source of truth). This
  // catches the plan `subskills: [research]` vs registry drift.
  for (const owner of ['plan', 'smith']) {
    test(`${owner}: declared frontmatter subskills all resolve through the registry`, () => {
      const declared = FM[owner].subskills || [];
      expect(declared.length).toBeGreaterThan(0);
      const errors = [];
      const out = validateSubSkillList(owner, declared, errors, `${owner}.frontmatter`);
      expect(errors).toEqual([]);
      expect(out).toEqual(declared);
    });
  }

  // The two plan contracts must stay SEPARATE: the composed whole-skill `research`
  // resolves as a frontmatter subskill, but must be REJECTED as a partialInvocation
  // micro-phase (it maps to no runtime-graph action — silent dead config otherwise).
  test('research resolves as a plan frontmatter subskill but is rejected as a partial-invocation micro-phase', () => {
    const composeErrors = [];
    const composed = validateSubSkillList('plan', ['research'], composeErrors, 'plan.frontmatter');
    expect(composeErrors).toEqual([]);
    expect(composed).toEqual(['research']);

    const partialErrors = [];
    const partial = validatePlanSubSkillList(['research'], partialErrors, 'planning.template.partialInvocation.only');
    expect(partial).toBeUndefined();
    expect(partialErrors.map((e) => e.code)).toContain('UNKNOWN_PLAN_SUBSKILL');
  });
});
