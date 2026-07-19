'use strict';

/**
 * Static skill-eval scorer (W3) -- a DETERMINISTIC, free, CI-gateable scorecard per skill.
 *
 * WHY only three scored parameters. A skill's real quality includes how reliably it TRIGGERS on
 * paraphrased intent, whether its chains fire correctly, and its live-outcome quality. Those are
 * inherently SEMANTIC: the skills/<name>/evals/evals.json fixtures are natural paraphrases, and
 * the W1 deterministic router (routeSkill) is a curated-KEYWORD matcher -- so measuring recall
 * with it scores keyword overlap, not skill quality (mean ~0.32 on real fixtures). Trigger
 * recall/precision/disambiguation therefore belong to the W5 BEHAVIORAL tier (LLM judge) and
 * appear here ONLY as typed placeholders. The static composite is built from the parameters that
 * ARE deterministic and free to measure:
 *
 *   - token_cost         description chars + body lines, normalized (lower is better).
 *   - caps               compliance with the desc<=1024 / body<=500 progressive-disclosure budget.
 *   - description_quality has explicit trigger phrases + disambiguation cues (the PR #292 pattern).
 *
 * Alongside the composite we run a ROUTER-REACHABILITY LINT (independent of the quality score): a
 * fixtured skill with NO curated INTENT_RULES rule and not router-exempt can NEVER be reached via
 * `forge skill for` -- a real defect the gate blocks. A skill that HAS a rule but whose paraphrase
 * fixtures don't hit its keywords is only a warning (that gap is exactly what the W5 judge fixes).
 *
 * Everything here is pure fs + pure JS: no LLM, no network, no subprocess -> reproducible in CI on
 * every platform. Follow-up rationale is recorded in kernel issue skill-eval-static.
 *
 * @module skill-eval
 */

const fs = require('node:fs');
const path = require('node:path');
const { INTENT_RULES, routeSkill, resolveSkillsRoot, loadSkillCatalog } = require('./using-forge');

// Progressive-disclosure budget -- mirrors test/skills/context-cost.test.js (single source of the
// numbers; kept in sync by the shared gate philosophy, not a runtime import to avoid test-dep).
const DESC_CAP = 1024; // Anthropic Agent Skills description limit (hard)
const BODY_CAP = 500; // body-line budget (loads on every trigger)

// Skills whose body legitimately exceeds BODY_CAP (documented in context-cost). `plan` keeps its
// HARD-GATEs in the body by design. Mirror it here so caps scoring agrees with the context gate.
const BODY_OVER_ALLOWLIST = new Set(['plan']);

// Skills intentionally NOT deterministic route targets (harness-internal, never user-invoked).
// Empty today: hermes-forge is a legitimate Hermes-session trigger target and instead carries a
// curated INTENT_RULES rule. The mechanism is retained (mirrors the chain-exempt pattern) so a
// future internal adapter can be classified honestly rather than forced to fake a route.
const ROUTER_EXEMPT = new Set([]);

// Documented composite weighting over the deterministic static params. description_quality leads
// (it is the actionable, skill-authored signal); token_cost next; caps compliance last (it is also
// a hard gate, so it contributes little marginal ranking signal). Weights sum to 1.
const WEIGHTS = Object.freeze({ description_quality: 0.5, token_cost: 0.3, caps: 0.2 });

// Gate floor for description_quality. 60 == adequate length + at least one of {trigger,
// disambiguation} cue; every canonical skill meets it today, and a regression that strips a
// skill's trigger phrasing AND contrast cues, or shrinks it below the length band, trips it.
const DESC_QUALITY_FLOOR = 60;

// Deterministic description-quality cues (lowercased substring checks -- no regex backtracking).
const TRIGGER_CUES = ['use when', 'use this', 'use it when', 'use whenever', 'when the user', 'when you', 'triggers:', 'trigger:'];
const DISAMBIGUATION_CUES = ['not ', "don't", 'do not', 'never', 'unlike', 'instead of', 'rather than', ' vs ', 'vs.', 'as opposed to', 'not for', 'skip'];

const RULE_SKILLS = new Set(INTENT_RULES.map(r => r.skill));

/** True when `name` has a curated INTENT_RULES rule (i.e. the deterministic router can target it). */
function hasCuratedRule(name) {
  return RULE_SKILLS.has(name);
}

/** Clamp a ratio into [0, 1]. */
function clamp01(x) {
  if (x < 0) return 0;
  if (x > 1) return 1;
  return x;
}

/**
 * token_cost: normalized cost of a skill's permanent (description) + on-trigger (body) footprint.
 * Lower cost -> higher score. Each axis is measured against its cap and averaged 50/50.
 * @param {{descLen:number, bodyLines:number}} m
 */
function scoreTokenCost({ descLen, bodyLines }) {
  const descRatio = clamp01(descLen / DESC_CAP);
  const bodyRatio = clamp01(bodyLines / BODY_CAP);
  const score = Math.round(100 * (1 - (descRatio * 0.5 + bodyRatio * 0.5)));
  return { desc_chars: descLen, body_lines: bodyLines, score };
}

/**
 * caps: hard compliance with the progressive-disclosure budget. Description over the cap always
 * fails; body over the cap fails UNLESS the skill is allowlisted (mirrors the context-cost gate).
 * @param {{descLen:number, bodyLines:number, allowlisted:boolean}} m
 */
function scoreCaps({ descLen, bodyLines, allowlisted }) {
  const descWithin = descLen <= DESC_CAP;
  const bodyWithin = bodyLines <= BODY_CAP || allowlisted === true;
  return { desc_within: descWithin, body_within: bodyWithin, score: descWithin && bodyWithin ? 100 : 0 };
}

/** Case-insensitive "does haystack contain any of these substrings". */
function containsAny(haystack, needles) {
  const lower = String(haystack).toLowerCase();
  return needles.some(n => lower.includes(n));
}

/**
 * description_quality: the PR #292 description pattern, scored deterministically.
 *   - trigger cues present   (explicit "use when / when the user / triggers:") -> 40
 *   - disambiguation cues     (contrast markers: "NOT the X skill", "unlike", ...) -> 40
 *   - adequate length         (>=120 chars and within the cap)                    -> 20
 * @param {string} description
 */
function scoreDescriptionQuality(description) {
  const desc = String(description || '');
  const hasTrigger = containsAny(desc, TRIGGER_CUES);
  const hasDisambiguation = containsAny(desc, DISAMBIGUATION_CUES);
  const adequate = desc.length >= 120 && desc.length <= DESC_CAP;
  const score = (hasTrigger ? 40 : 0) + (hasDisambiguation ? 40 : 0) + (adequate ? 20 : 0);
  return { has_trigger_cues: hasTrigger, has_disambiguation_cues: hasDisambiguation, adequate_length: adequate, score };
}

/** Weighted composite over the three deterministic static params -> integer 0..100. */
function composite({ tokenCost, caps, descQuality }) {
  const value =
    WEIGHTS.description_quality * descQuality.score +
    WEIGHTS.token_cost * tokenCost.score +
    WEIGHTS.caps * caps.score;
  return Math.max(0, Math.min(100, Math.round(value)));
}

/** The W5 behavioral-tier params, typed as null placeholders so consumers can rely on the shape. */
function behavioralPlaceholders() {
  return {
    trigger_recall: null,
    trigger_precision: null,
    disambiguation: null,
    chain_correctness: null,
    outcome_quality: null,
    variance: null,
    note: 'behavioral — W5 (LLM judge): semantic recall/precision/chain/outcome/variance, not deterministic',
  };
}

/**
 * Router-reachability lint (B): run a skill's should_trigger fixtures through the deterministic
 * router and report whether >=1 places this skill as best-match. This measures the W1 router's
 * COVERAGE (a fixable gap), NOT skill quality, so it is separate from the composite.
 *
 * @param {{name:string, fixtures:Array|null, catalog:Array, hasRule:boolean, exempt:boolean}} args
 */
function routerReachability({ name, fixtures, catalog, hasRule, exempt }) {
  const base = { has_curated_rule: hasRule === true, router_exempt: exempt === true };
  const positives = Array.isArray(fixtures) ? fixtures.filter(f => f && f.should_trigger === true) : null;
  if (!positives || positives.length === 0) {
    return { ...base, fixtures: 'no-fixtures', fixtures_total: 0, fixtures_best_hit: 0, reachable: null, keyword_alignment: null };
  }
  let hit = 0;
  for (const f of positives) {
    const r = routeSkill(f.query, { catalog });
    if (r.best === name) hit += 1;
  }
  return {
    ...base,
    fixtures: 'present',
    fixtures_total: positives.length,
    fixtures_best_hit: hit,
    reachable: hit > 0,
    keyword_alignment: Math.round((hit / positives.length) * 100) / 100,
  };
}

/** Strip a leading UTF-8 BOM without embedding the literal char. */
function stripBom(value) {
  const s = String(value);
  return s.charCodeAt(0) === 0xFEFF ? s.slice(1) : s;
}

/**
 * Parse a skill's SKILL.md source into { name, description, descLen, bodyLines }. Mirrors the
 * context-cost parser so caps/token measurements agree with that gate. Returns null when absent.
 * @param {string} skillsDir absolute path to the skills/ directory
 * @param {string} name skill folder name
 */
function parseSkillSource(skillsDir, name) {
  const file = path.join(skillsDir, name, 'SKILL.md');
  if (!fs.existsSync(file)) return null;
  const text = stripBom(fs.readFileSync(file, 'utf8'));
  const lines = text.split(/\r?\n/);
  if (lines[0].trim() !== '---') return { name, description: '', descLen: 0, bodyLines: lines.length };
  let fmEnd = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === '---') { fmEnd = i; break; }
  }
  if (fmEnd === -1) return { name, description: '', descLen: 0, bodyLines: 0 };
  const fm = lines.slice(1, fmEnd).join('\n');
  const m = fm.match(/description:\s*([\s\S]*?)(?:\n[A-Za-z_-]+:|$)/);
  const description = m ? m[1].replace(/^>\s*/, '').replace(/\s+/g, ' ').trim() : '';
  const bodyLines = lines.length - (fmEnd + 1);
  return { name, description, descLen: description.length, bodyLines };
}

/**
 * Load a skill's evals.json fixtures as a typed STATE. ONLY a genuinely ABSENT file is
 * "no-fixtures"; every other broken shape is 'invalid' so it can never silently disable the
 * router-reachability lint and pass CI:
 *   - 'absent'  no evals.json file.
 *   - 'valid'   file parses to an ARRAY, EVERY entry has a non-empty string `query` and a boolean
 *               `should_trigger`, AND there is >=1 positive (should_trigger:true) fixture.
 *   - 'invalid' file exists but is unreadable / not JSON / not an array / has a wrong-shape entry
 *               (e.g. `shouldTrigger` instead of `should_trigger`, missing `query`) / has zero
 *               positive fixtures. The `error` names the first bad entry and why.
 * @returns {{status:'absent'|'valid'|'invalid', fixtures:Array|null, error:string|null}}
 */
function loadFixtures(skillsDir, name) {
  const file = path.join(skillsDir, name, 'evals', 'evals.json');
  if (!fs.existsSync(file)) return { status: 'absent', fixtures: null, error: null };
  let raw;
  try {
    raw = stripBom(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    return { status: 'invalid', fixtures: null, error: `unreadable evals.json: ${err.message}` };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return { status: 'invalid', fixtures: null, error: `malformed evals.json: ${err.message}` };
  }
  if (!Array.isArray(parsed)) {
    return { status: 'invalid', fixtures: null, error: 'evals.json is not a JSON array of fixtures' };
  }
  for (let i = 0; i < parsed.length; i += 1) {
    const entry = parsed[i];
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      return { status: 'invalid', fixtures: null, error: `fixture #${i} is not an object` };
    }
    if (typeof entry.query !== 'string' || entry.query.trim() === '') {
      return { status: 'invalid', fixtures: null, error: `fixture #${i} has no non-empty string "query"` };
    }
    if (typeof entry.should_trigger !== 'boolean') {
      return { status: 'invalid', fixtures: null, error: `fixture #${i} has no boolean "should_trigger" (check for a mis-spelled key)` };
    }
  }
  if (!parsed.some(e => e.should_trigger === true)) {
    return { status: 'invalid', fixtures: null, error: 'no positive (should_trigger:true) fixtures — the reachability lint would be a no-op' };
  }
  return { status: 'valid', fixtures: parsed, error: null };
}

/**
 * Build a full deterministic scorecard for one skill. `catalog` is the router catalog (injectable);
 * a skill missing its SKILL.md yields null.
 * @param {{skillsDir:string, name:string, catalog:Array}} args
 */
function buildScorecard({ skillsDir, name, catalog }) {
  const src = parseSkillSource(skillsDir, name);
  if (!src) return null;
  const allowlisted = BODY_OVER_ALLOWLIST.has(name);
  const tokenCost = scoreTokenCost({ descLen: src.descLen, bodyLines: src.bodyLines });
  const caps = scoreCaps({ descLen: src.descLen, bodyLines: src.bodyLines, allowlisted });
  const descQuality = scoreDescriptionQuality(src.description);
  const fx = loadFixtures(skillsDir, name);
  let reachability;
  if (fx.status === 'invalid') {
    // A broken fixture file is NOT "no-fixtures": mark it explicitly so the gate can fail it.
    reachability = {
      has_curated_rule: hasCuratedRule(name),
      router_exempt: ROUTER_EXEMPT.has(name),
      fixtures: 'invalid',
      error: fx.error,
      fixtures_total: 0,
      fixtures_best_hit: 0,
      reachable: null,
      keyword_alignment: null,
    };
  } else {
    reachability = routerReachability({
      name,
      fixtures: fx.fixtures,
      catalog: catalog || [],
      hasRule: hasCuratedRule(name),
      exempt: ROUTER_EXEMPT.has(name),
    });
  }
  return {
    skill: name,
    fixtures: reachability.fixtures, // 'present' | 'no-fixtures' | 'invalid'
    static: { token_cost: tokenCost, caps, description_quality: descQuality },
    router_reachability: reachability,
    behavioral: behavioralPlaceholders(),
    composite: composite({ tokenCost, caps, descQuality }),
  };
}

/** Build scorecards for every skill under `skillsDir`, keyed by name (sorted, deterministic). */
function buildAllScorecards(skillsDir, catalog) {
  const cat = catalog || [];
  const names = fs
    .readdirSync(skillsDir, { withFileTypes: true })
    .filter(e => e.isDirectory() && fs.existsSync(path.join(skillsDir, e.name, 'SKILL.md')))
    .map(e => e.name)
    .sort();
  const out = {};
  for (const name of names) {
    const card = buildScorecard({ skillsDir, name, catalog: cat });
    if (card) out[name] = card;
  }
  return out;
}

/**
 * Resolve the canonical skills/ SOURCE dir, preferring the consumer/dev checkout's own skills/
 * and FALLING BACK to the packaged skills root (resolveSkillsRoot() with no override wraps
 * getPackageRoot). This is the SHARED resolver every `forge skill` verb must use so an installed
 * consumer project (which has no root skills/) reads Forge's PACKAGED skills instead of failing
 * with "no skills dir" — mirrors what `forge skill for` already does. Never throws -> null only
 * when no skills/ exists on either root. Keep this the single resolver so no future verb regresses.
 * @param {string} [projectRoot]
 * @returns {string|null}
 */
function resolveSkillsDir(projectRoot) {
  const roots = [];
  if (projectRoot) roots.push(projectRoot);
  const pkg = resolveSkillsRoot();
  if (pkg && pkg !== projectRoot) roots.push(pkg);
  for (const root of roots) {
    const dir = path.join(root, 'skills');
    // Require at least one <name>/SKILL.md: a consumer project may have an unrelated or empty
    // skills/ dir, which would otherwise be selected and yield ZERO scorecards (a hollow PASS).
    // An empty/skill-less dir falls through to the packaged skills root.
    if (dirHasAnySkill(dir)) return dir;
  }
  return null;
}

/** True when `dir` contains at least one `<name>/SKILL.md` (a real skills source, not an empty dir). */
function dirHasAnySkill(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return false;
  }
  return entries.some(e => e.isDirectory() && fs.existsSync(path.join(dir, e.name, 'SKILL.md')));
}

/**
 * Resolve BOTH the skills SOURCE dir and its aligned router catalog from the same root, so eval
 * and scores never read the catalog from a different root than the scorecards. Returns null when
 * no skills/ is resolvable.
 * @param {string} [projectRoot]
 * @returns {{ skillsDir: string, catalog: {name:string,description:string}[] } | null}
 */
function resolveSkillsContext(projectRoot) {
  const skillsDir = resolveSkillsDir(projectRoot);
  if (!skillsDir) return null;
  // loadSkillCatalog(override) reads override/skills — pass the parent of the resolved skills dir.
  return { skillsDir, catalog: loadSkillCatalog(path.dirname(skillsDir)) };
}

/** Read a committed scorecard.json under `<baseDir>/<name>/evals/`, or null when absent/unparseable. */
function loadCommittedScorecard(baseDir, name) {
  const file = path.join(baseDir, name, 'evals', 'scorecard.json');
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(stripBom(fs.readFileSync(file, 'utf8')));
  } catch {
    return null;
  }
}

/**
 * Detect scorecard DRIFT: for each fresh scorecard, the committed artifact under the canonical
 * skills/ dir (and, when present, the .agents/skills MIRROR) must byte-match the recomputed card.
 * Returns [{ skill, where, reason }] — empty when everything is fresh. This is what lets both the
 * CI gate and `forge skill scores` refuse to report PASS while a committed artifact is stale.
 * @param {{skillsDir:string, freshCards:object, mirrorDir?:string|null}} args
 */
function detectScorecardDrift({ skillsDir, freshCards, mirrorDir }) {
  const drift = [];
  for (const [name, fresh] of Object.entries(freshCards)) {
    const expected = JSON.stringify(fresh);
    const canonical = loadCommittedScorecard(skillsDir, name);
    if (canonical === null) {
      drift.push({ skill: name, where: 'canonical', reason: 'missing scorecard.json — run `forge skill eval --static`' });
    } else if (JSON.stringify(canonical) !== expected) {
      drift.push({ skill: name, where: 'canonical', reason: 'scorecard.json out of date — run `forge skill eval --static`' });
    }
    // No existsSync(mirrorDir) guard: a TOTALLY missing mirror is the worst case and must report
    // drift per skill (loadCommittedScorecard already returns null safely for missing files). The
    // caller passes mirrorDir only when a mirror is expected in this checkout (null skips it).
    if (mirrorDir) {
      const mirror = loadCommittedScorecard(mirrorDir, name);
      if (mirror === null) {
        drift.push({ skill: name, where: 'mirror', reason: 'missing .agents/skills scorecard.json — regenerate the mirror' });
      } else if (JSON.stringify(mirror) !== expected) {
        drift.push({ skill: name, where: 'mirror', reason: '.agents/skills scorecard.json out of date — regenerate the mirror' });
      }
    }
  }
  return drift;
}

/**
 * The CI GATE. Given scorecards keyed by name, returns { passed, failures, warnings }.
 * HARD failures (block CI):
 *   - caps: a description over the char cap or a non-allowlisted body over the line cap.
 *   - description_quality: below DESC_QUALITY_FLOOR.
 *   - router_unreachable: a FIXTURED skill with NO curated rule and NOT router-exempt (the router
 *     can never reach it via `forge skill for`).
 * WARNINGS (surface in `forge skill scores`, never block): a fixtured skill that HAS a rule but
 * whose paraphrase fixtures don't hit its keywords (reachable:false) -- the W5 judge is the real fix.
 */
function evaluateGate(scorecards, options = {}) {
  const failures = [];
  const warnings = [];
  // Committed-artifact drift is a hard failure: a stale scorecard.json (canonical or mirror) means
  // the published scores disagree with the source, so the gate must not report PASS.
  const drift = Array.isArray(options.drift) ? options.drift : [];
  for (const d of drift) {
    failures.push({ skill: d.skill, kind: 'scorecard_drift', detail: `${d.where}: ${d.reason}` });
  }
  for (const [name, card] of Object.entries(scorecards)) {
    if (card.static.caps.score !== 100) {
      failures.push({ skill: name, kind: 'caps', detail: `desc_within=${card.static.caps.desc_within} body_within=${card.static.caps.body_within}` });
    }
    if (card.static.description_quality.score < DESC_QUALITY_FLOOR) {
      failures.push({ skill: name, kind: 'description_quality', detail: `score ${card.static.description_quality.score} < floor ${DESC_QUALITY_FLOOR}` });
    }
    const rr = card.router_reachability;
    if (rr.fixtures === 'invalid') {
      // A broken evals.json must FAIL, not silently disable the reachability lint.
      failures.push({ skill: name, kind: 'invalid_fixtures', detail: rr.error || 'evals.json is malformed or not a JSON array' });
    } else if (rr.fixtures === 'present' && !rr.has_curated_rule && !rr.router_exempt) {
      failures.push({ skill: name, kind: 'router_unreachable', detail: 'fixtured skill has no curated INTENT_RULES rule and is not router-exempt' });
    } else if (rr.fixtures === 'present' && rr.has_curated_rule && rr.reachable === false) {
      warnings.push({ skill: name, kind: 'router_keyword_gap', detail: 'has a rule but no fixture reaches it (paraphrase gap — W5)' });
    }
  }
  return { passed: failures.length === 0, failures, warnings };
}

module.exports = {
  DESC_CAP,
  BODY_CAP,
  BODY_OVER_ALLOWLIST,
  ROUTER_EXEMPT,
  WEIGHTS,
  DESC_QUALITY_FLOOR,
  hasCuratedRule,
  scoreTokenCost,
  scoreCaps,
  scoreDescriptionQuality,
  composite,
  behavioralPlaceholders,
  routerReachability,
  parseSkillSource,
  loadFixtures,
  buildScorecard,
  buildAllScorecards,
  evaluateGate,
  resolveSkillsRoot,
  resolveSkillsDir,
  resolveSkillsContext,
  loadCommittedScorecard,
  detectScorecardDrift,
};
