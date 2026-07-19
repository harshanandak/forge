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
const { WORKFLOW_STAGE_MATRIX } = require('../../lib/workflow/stages');

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
// Each stage's frontmatter `next` (the DEFAULT / critical-path successor). No
// stage is unconditionally terminal: verify's only stages.js successor is `ship`
// (the docs-only pre-ship reuse), so verify carries next:ship too. The linear
// critical ladder is plan→dev→validate→ship→review→verify (CRITICAL_LADDER below).
const STAGE_NEXT = {
  plan: 'dev',
  dev: 'validate',
  validate: 'ship',
  ship: 'review',
  review: 'verify',
  verify: 'ship',
};
// The canonical critical-path ladder (WORKFLOW_STAGE_MATRIX.critical order).
const CRITICAL_LADDER = ['plan', 'dev', 'validate', 'ship', 'review', 'verify'];
// Feeders point INTO the chain. triage-ready routes through claim-safety (prove
// the live lease before work starts) — NOT straight to plan, which would bypass
// lease safety. `research` is intentionally NOT a feeder: it is standalone /
// callable mid-workflow and returns to its CALLER, so it declares no forced
// `next` (it is terminal + a subskill of plan).
const FEEDER_NEXT = {
  'triage-ready': 'claim-safety',
  // claim-safety proves the live lease, then work continues into dev (smith
  // proceeds into plan/dev after the proof) — it does NOT dead-end the flow.
  'claim-safety': 'dev',
};
// Utility/terminal skills — terminal by their OWN semantics (return to caller),
// not stages in lib/workflow/stages.js. verify is NOT here: it is a stage and
// (per the docs flow) not unconditionally terminal.
const TERMINAL_SKILLS = [
  'research',
  'status',
  'shepherd',
  'kernel',
  'issue-basics',
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

  test('the critical-path ladder edges match frontmatter next (plan→…→verify)', () => {
    for (let i = 0; i < CRITICAL_LADDER.length - 1; i++) {
      expect(FM[CRITICAL_LADDER[i]].next).toBe(CRITICAL_LADDER[i + 1]);
    }
  });

  test('walking `next` from plan visits every stage in critical order (docs back-edge stops the walk)', () => {
    const walked = [];
    let cursor = 'plan';
    const seen = new Set();
    while (cursor && !seen.has(cursor)) {
      seen.add(cursor);
      walked.push(cursor);
      cursor = FM[cursor].next;
    }
    // plan→dev→validate→ship→review→verify, then verify.next=ship is already seen
    // (the docs-only back-edge) so the walk terminates cleanly.
    expect(walked).toEqual(STAGE_CHAIN);
    expect(FM.verify.next).toBe('ship');
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
      // Every stage carries a frontmatter next; the body HARD-GATE line must name
      // that successor (backtick-quoted) so prose and metadata never drift.
      expect(typeof fm.next).toBe('string');
      expect(line).toContain('`' + fm.next + '`');
    });
  }
});

// The stage chain metadata must AGREE with the change-classification matrix in
// lib/workflow/stages.js (the runtime source of truth). frontmatter `next` is the
// DEFAULT / critical-path successor; it must be a successor stages.js actually
// uses for SOME classification, and no stage may assert a successor stages.js
// never uses. (ship/review/verify successors are classification-dependent — the
// body HARD-GATE lines spell that out; frontmatter carries the critical-path.)
function stagesJsSuccessors(stage) {
  const successors = new Set();
  for (const path of Object.values(WORKFLOW_STAGE_MATRIX)) {
    const i = path.indexOf(stage);
    if (i !== -1 && i < path.length - 1) successors.add(path[i + 1]);
  }
  return successors;
}

describe('stage chain metadata is consistent with lib/workflow/stages.js', () => {
  for (const stage of STAGE_CHAIN) {
    // IFF: a stage may advertise terminal:true ONLY IF no classification continues
    // past it. Every one of the 6 stages has a successor in SOME classification
    // (verify → ship in docs), so none is unconditionally terminal.
    test(`${stage}: terminal:true iff stages.js never continues past it`, () => {
      const continuesSomewhere = stagesJsSuccessors(stage).size > 0;
      expect(FM[stage].terminal).toBe(!continuesSomewhere);
    });

    test(`${stage}: frontmatter next is a successor stages.js actually uses`, () => {
      const next = FM[stage].next;
      if (next === undefined || next === null) {
        // Only permitted if the stage truly never continues (no such stage today).
        expect(stagesJsSuccessors(stage).size).toBe(0);
        return;
      }
      expect([...stagesJsSuccessors(stage)]).toContain(next);
    });
  }

  test('no stage declares a successor stages.js never uses for any classification', () => {
    for (const stage of STAGE_CHAIN) {
      const next = FM[stage].next;
      if (!next) continue;
      expect([...stagesJsSuccessors(stage)]).toContain(next);
    }
  });

  test('no stage advertises terminal where some classification continues past it', () => {
    for (const stage of STAGE_CHAIN) {
      if (FM[stage].terminal === true) {
        expect(stagesJsSuccessors(stage).size).toBe(0);
      }
    }
  });
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

  // VALIDATE-vs-RESOLVE parity: the id set that validates (getSubSkillIds) must
  // exactly equal the id set that resolves (getSubSkillDefinitions) for every
  // owner — a subskill that validates also resolves, and vice versa.
  for (const owner of ['plan', 'smith']) {
    test(`${owner}: getSubSkillIds equals the ids of getSubSkillDefinitions (validate == resolve)`, () => {
      const resolveIds = new Set(getSubSkillDefinitions(owner).map((d) => d.id));
      const validateIds = getSubSkillIds(owner);
      expect([...resolveIds].sort()).toEqual([...validateIds].sort());
    });

    test(`${owner}: every declared frontmatter subskill BOTH validates AND resolves`, () => {
      const declared = FM[owner].subskills || [];
      const resolveIds = new Set(getSubSkillDefinitions(owner).map((d) => d.id));
      for (const sub of declared) {
        const errors = [];
        expect(validateSubSkillList(owner, [sub], errors, 'test')).toEqual([sub]);
        expect(errors).toEqual([]);
        expect(resolveIds.has(sub)).toBeTruthy();
      }
    });
  }

  test('getSubSkillDefinitions(plan) resolves the composed whole-skill research (not just plan.* phases)', () => {
    const ids = getSubSkillDefinitions('plan').map((d) => d.id);
    expect(ids).toContain('research');
    expect(ids).toContain('plan.intent_capture');
  });
});

// KERNEL-MAP vs METADATA: the kernel umbrella publishes a chain-map table. Its
// rows MUST agree with each skill's actual frontmatter, so the human-facing index
// can never drift from the machine metadata.
describe('kernel chain-map table agrees with per-skill frontmatter', () => {
  function parseKernelChainMap() {
    const body = readSkill('kernel');
    const rows = [];
    for (const line of body.split(/\r?\n/)) {
      // Rows look like: | `plan` | `dev` | `false` |
      const m = line.match(/^\|\s*`(\w[\w-]*)`\s*\|\s*(`[\w-]+`|—|-)\s*\|\s*`(true|false)`\s*\|/);
      if (!m) continue;
      const skill = m[1];
      const nextCell = m[2] === '—' || m[2] === '-' ? null : m[2].replace(/`/g, '');
      const terminal = m[3] === 'true';
      rows.push({ skill, next: nextCell, terminal });
    }
    return rows;
  }

  test('every stage row is present in the kernel chain-map', () => {
    const rows = parseKernelChainMap();
    const mapped = new Set(rows.map((r) => r.skill));
    for (const stage of STAGE_CHAIN) expect(mapped.has(stage)).toBeTruthy();
  });

  test('each kernel chain-map row matches the skill frontmatter (next + terminal)', () => {
    for (const row of parseKernelChainMap()) {
      const fm = FM[row.skill];
      expect(fm).toBeTruthy();
      const fmNext = fm.next === undefined || fm.next === null ? null : fm.next;
      expect(row.next).toBe(fmNext);
      expect(row.terminal).toBe(fm.terminal === true);
    }
  });
});
