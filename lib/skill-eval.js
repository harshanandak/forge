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
 * Resolve the skills SOURCE dir, its aligned router catalog, AND which root was selected, so eval
 * and scores never read the catalog from a different root than the scorecards. `source` is:
 *   - 'project'  the consumer/dev SOURCE checkout's own skills/ was selected (projectRoot/skills).
 *                A committed .agents/skills MIRROR is expected here, so mirror drift MUST be gated.
 *   - 'package'  fell back to the PACKAGED skills root (installed consumer with no root skills/).
 *                No mirror ships with the package, so a mirror check would be false drift.
 * Returns null when no skills/ is resolvable.
 * @param {string} [projectRoot]
 * @returns {{ skillsDir: string, catalog: {name:string,description:string}[], source: 'project'|'package' } | null}
 */
function resolveSkillsContext(projectRoot) {
  const skillsDir = resolveSkillsDir(projectRoot);
  if (!skillsDir) return null;
  const source = projectRoot && skillsDir === path.join(projectRoot, 'skills') ? 'project' : 'package';
  // loadSkillCatalog(override) reads override/skills — pass the parent of the resolved skills dir.
  return { skillsDir, catalog: loadSkillCatalog(path.dirname(skillsDir)), source };
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

/** List every skill name (a `<name>/SKILL.md` exists) under `skillsDir`, sorted. */
function listSkillNames(skillsDir) {
  return fs
    .readdirSync(skillsDir, { withFileTypes: true })
    .filter(e => e.isDirectory() && fs.existsSync(path.join(skillsDir, e.name, 'SKILL.md')))
    .map(e => e.name)
    .sort();
}

/**
 * Load skills/coverage.json — the command→owning-skill coverage map. Shape:
 *   { "version": 1, "commands": { "<cmd>": "<skill>" | { "exempt": "<reason>" }, ... } }
 * Returns null when the file is absent (a hard gate failure surfaced by evaluateCoverage) or an
 * object with `__error` set when it exists but is unparseable. Never throws.
 * @param {string} skillsDir
 */
function loadCoverageMap(skillsDir) {
  const file = path.join(skillsDir, 'coverage.json');
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(stripBom(fs.readFileSync(file, 'utf8')));
  } catch (err) {
    return { __error: `unparseable coverage.json: ${err.message}` };
  }
}

/**
 * Enumerate every REGISTERED command name from the Forge command registry (the source of truth for
 * the user-facing command surface). Lazy-requires the registry INSIDE the function — never at module
 * top — because several command modules require this module (skill-eval); a top-level require would
 * be circular. By call time the registry and all command modules are fully loaded and cached, so a
 * lazy require is safe and returns the real dispatchable set (manifest + readdir fallback).
 * @returns {string[]} sorted command names
 */
function enumerateCommandNames() {
  const { loadCommands } = require('./commands/_registry');
  const commandsDir = path.join(__dirname, 'commands');
  const { commands } = loadCommands(commandsDir);
  const names = new Set(commands.keys());
  // UNION the registry with commands dispatched DIRECTLY in the shipped binaries (docs,
  // reset, rollback, review, verify, …). These never enter the registry, so without this
  // they would escape the coverage gate. Parsed from source so a new direct command is
  // auto-covered. (Read failures are surfaced separately via scanBinDirectCommands so the
  // gate can FAIL CLOSED — see buildCoverageReport — rather than silently drop them.)
  for (const name of scanBinDirectCommands().names) names.add(name);
  return [...names].sort((a, b) => a.localeCompare(b)); // explicit comparator (SonarCloud)
}

/**
 * Command names dispatched directly in bin/forge.js (`command === '<name>'`) rather than
 * through the registry. Parsed from source (best-effort; returns [] if bin/forge.js is
 * unreadable) so the coverage gate covers the non-registry CLI surface too.
 * @returns {string[]}
 */
function scanBinDirectCommands() {
  const names = new Set();
  const errors = [];
  const { getPackageRoot, isCompiledBinary } = require('./package-root');
  // Resolve bin/ via the package root so it works from an extracted-asset install too, not
  // just __dirname/../bin. In a COMPILED single-file binary the bin/ scripts are not embedded
  // assets, so the tree can be absent — that is EXPECTED (the coverage gate is a dev/CI check),
  // NOT a scan failure. In that case skip the direct scan without failing closed.
  const compiled = (() => { try { return isCompiledBinary(); } catch { return false; } })();
  const binDir = path.join(getPackageRoot(), 'bin');
  if (compiled && !fs.existsSync(binDir)) return { names: [], errors: [] };
  const wordRe = /['"]([a-z][a-z0-9_-]*)['"]/g;
  const allMatches = (text, re) => { const out = []; let m; while ((m = re.exec(text)) !== null) out.push(m[1]); return out; };
  // Each shipped binary (package.json `bin`) dispatches commands its OWN way; use a
  // per-file extractor scoped to that file's real dispatch so unrelated switch/menu
  // cases are never caught. This covers the full bounded bin/ set (forge.js,
  // forge-preflight.js, forge-cmd.js); a new binary needs its extractor added here.
  const sources = [
    // main CLI: `command === '<name>'`
    { file: 'forge.js', extract: (src) => allMatches(src, /command === '([a-z][a-z0-9_-]*)'/g) },
    // preflight binary: `switch(command){ case "<name>": }`
    { file: 'forge-preflight.js', extract: (src) => allMatches(src, /case ['"]([a-z][a-z0-9_-]*)['"]:/g) },
    // legacy forge-cmd dispatcher: a `VALID_COMMANDS = [ '<name>', … ]` array
    { file: 'forge-cmd.js', extract: (src) => {
      const block = /VALID_COMMANDS\s*=\s*\[([\s\S]*?)\]/.exec(src);
      return block ? allMatches(block[1], wordRe) : [];
    } },
  ];
  for (const { file, extract } of sources) {
    try {
      const src = fs.readFileSync(path.join(binDir, file), 'utf8');
      for (const name of extract(src)) names.add(name);
    } catch (err) {
      // FAIL CLOSED in a real source checkout: every source here is an EXPECTED shipped
      // binary, so an unreadable one means the gate is blind to part of the command surface
      // — record a scan error (which fails the gate) rather than silently letting those
      // commands bypass. In a compiled binary a missing bin/ script is expected, not a gap.
      if (!compiled) errors.push({ source: `bin/${file}`, detail: err.message });
    }
  }
  return { names: [...names], errors };
}

/**
 * Coverage GATE (part 1 of §3.3): every registered command must be OWNED by an existing skill or
 * explicitly `{ exempt: "<reason>" }`. A registered command with NO coverage.json entry FAILS — so a
 * new command physically cannot merge without deciding its skill home. A mapping to a skill that
 * does not exist FAILS. A malformed/empty entry FAILS. A coverage.json entry for a command that no
 * longer exists is a non-blocking WARNING (keep the map honest without surprise failures).
 * @param {{commands:string[], coverage:object|null, skillNames:Set<string>}} args
 * @returns {{passed:boolean, failures:Array, warnings:Array, mapped:number, exempt:number, total:number}}
 */
function evaluateCoverage({ commands, coverage, skillNames, scanErrors = [] }) {
  const failures = [];
  const warnings = [];
  // FAIL CLOSED on unreadable command sources: a binary the scan could not read means the
  // gate is blind to part of the command surface, so it must fail rather than pass.
  for (const e of (Array.isArray(scanErrors) ? scanErrors : [])) {
    failures.push({ command: e.source, kind: 'unreadable_command_source', detail: `could not read ${e.source}; the coverage gate cannot see its commands (${e.detail})` });
  }
  const total = Array.isArray(commands) ? commands.length : 0;
  if (total === 0) {
    // Defensive: an empty registry enumeration would make every coverage.json entry look "stale"
    // and vacuously PASS. Fail instead so a broken enumeration can never hollow-pass the gate.
    failures.push({ command: '*', kind: 'no_commands_enumerated', detail: 'command registry enumerated zero commands — cannot evaluate coverage' });
    return { passed: false, failures, warnings, mapped: 0, exempt: 0, total };
  }
  if (!coverage || coverage.__error) {
    failures.push({
      command: '*',
      kind: 'coverage_map_missing',
      detail: coverage && coverage.__error ? coverage.__error : 'skills/coverage.json not found',
    });
    return { passed: false, failures, warnings, mapped: 0, exempt: 0, total };
  }
  const map = coverage.commands && typeof coverage.commands === 'object' ? coverage.commands : {};
  const known = new Set(commands);
  let mapped = 0;
  let exempt = 0;
  for (const cmd of commands) {
    if (!Object.prototype.hasOwnProperty.call(map, cmd)) {
      failures.push({ command: cmd, kind: 'unmapped', detail: 'no coverage.json entry — map it to an owning skill or add { "exempt": "<reason>" }' });
      continue;
    }
    const entry = map[cmd];
    if (typeof entry === 'string') {
      if (skillNames.has(entry)) mapped += 1;
      else failures.push({ command: cmd, kind: 'unknown_skill', detail: `owning skill '${entry}' does not exist under skills/` });
    } else if (entry && typeof entry === 'object' && typeof entry.exempt === 'string' && entry.exempt.trim() !== '') {
      exempt += 1;
    } else {
      failures.push({ command: cmd, kind: 'malformed_entry', detail: 'entry must be an owning-skill name (string) or { "exempt": "<non-empty reason>" }' });
    }
  }
  for (const key of Object.keys(map)) {
    if (!known.has(key)) warnings.push({ command: key, kind: 'stale_entry', detail: 'coverage.json maps a command that is no longer registered — remove it' });
  }
  return { passed: failures.length === 0, failures, warnings, mapped, exempt, total };
}

/**
 * Resolve the skills dir, enumerate the command registry, load coverage.json, and evaluate the
 * coverage gate — one call for both the CLI (`forge skill coverage` / `forge skill scores`) and the
 * CI test. Returns null when no skills/ is resolvable (mirrors resolveSkillsContext).
 * @param {string} [projectRoot]
 */
function buildCoverageReport(projectRoot) {
  const skillsDir = resolveSkillsDir(projectRoot);
  if (!skillsDir) return null;
  const commands = enumerateCommandNames();
  const { errors: scanErrors } = scanBinDirectCommands();
  const coverage = loadCoverageMap(skillsDir);
  const skillNames = new Set(listSkillNames(skillsDir));
  const result = evaluateCoverage({ commands, coverage, skillNames, scanErrors });
  return { skillsDir, commands, coverage, ...result };
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

/** Escape a string for literal use inside a RegExp. */
function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Return a SKILL.md's INSTRUCTION BODY — the text after the YAML frontmatter block.
 * The documentation lint scans the body only: a command named solely in the
 * frontmatter description is NOT taught to an agent that loads the skill.
 * @param {string} text raw SKILL.md contents (BOM already stripped)
 * @returns {string}
 */
function skillBody(text) {
  if (!text.startsWith('---')) return text;
  const fmEnd = text.indexOf('\n---', 3);
  if (fmEnd === -1) return text;
  const afterFence = text.indexOf('\n', fmEnd + 1);
  return afterFence === -1 ? '' : text.slice(afterFence + 1);
}

/**
 * Skill-accuracy lint, Dimension A — DOCUMENTATION coverage. For every command that
 * coverage.json maps to a skill (string value; `{exempt}` objects are skipped), the
 * command must be documented in that skill's SKILL.md body. "Documented" = the command
 * IS the skill's own name (a self-titled skill documents its command implicitly), OR the
 * command token appears (word-boundary) in the body. A miss is a HOLLOW mapping — the
 * coverage gate passes but an agent routed to the skill is never taught the command
 * (the exact defect that recurred on the batch-1 skills PR, e.g. orphans -> issue-basics).
 *
 * @param {{skillsDir:string, coverage:object}} args
 * @returns {Array<{command:string, skill:string, reason:string}>} empty when clean.
 */
function auditCommandDocumentation({ skillsDir, coverage }) {
  const map = (coverage && (coverage.commands || coverage)) || {};
  const violations = [];
  for (const [command, skill] of Object.entries(map)) {
    if (typeof skill !== 'string') continue; // exempt entry ({ exempt: reason })
    if (command === skill) continue; // self-titled skill documents its own command
    const file = path.join(skillsDir, skill, 'SKILL.md');
    if (!fs.existsSync(file)) {
      violations.push({ command, skill, reason: 'owning skill SKILL.md is missing' });
      continue;
    }
    const body = skillBody(stripBom(fs.readFileSync(file, 'utf8')));
    const re = new RegExp(`(^|[^a-z0-9-])${escapeRegExp(command)}([^a-z0-9-]|$)`, 'm');
    if (!re.test(body)) {
      violations.push({ command, skill, reason: 'command not referenced in the owning skill body' });
    }
  }
  return violations;
}

/**
 * Skill-accuracy lint, Dimension B — ROUTER PRECISION. Assert that specific queries do
 * NOT route to a named skill through the deterministic router — i.e. a curated keyword
 * does not over-match a phrase it should not own. This targets the DETERMINISTIC
 * keyword-collision class (e.g. a bare `gate status` cue capturing "SonarCloud gate
 * status"), the negative complement to `routerReachability`.
 *
 * It deliberately does NOT blanket-scan every `should_trigger:false` fixture: many of
 * those are SEMANTIC paraphrases where a legitimate keyword fires but the deeper intent
 * differs (e.g. "…plan, build, validate, ship…" hits the `plan` cue but means an
 * end-to-end run). Semantic precision is the W5 LLM tier's job (see the header note),
 * not the deterministic router's — so those cases belong to behavioral eval, not here.
 *
 * @param {{cases:Array<{query:string, skill:string}>, catalog:Array, route?:function}} args
 *   each case asserts `query` must NOT resolve to `skill`. route defaults to routeSkill.
 * @returns {Array<{skill:string, query:string, routedTo:string}>} empty when clean.
 */
function auditRouterPrecision({ cases, catalog, route }) {
  const routeFn = typeof route === 'function' ? route : (q, opts) => routeSkill(q, opts);
  const violations = [];
  for (const c of Array.isArray(cases) ? cases : []) {
    if (!c || typeof c.query !== 'string' || typeof c.skill !== 'string') continue;
    const best = routeFn(c.query, { catalog }).best;
    if (best === c.skill) violations.push({ skill: c.skill, query: c.query, routedTo: best });
  }
  return violations;
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
  auditCommandDocumentation,
  auditRouterPrecision,
  parseSkillSource,
  loadFixtures,
  buildScorecard,
  buildAllScorecards,
  evaluateGate,
  listSkillNames,
  loadCoverageMap,
  enumerateCommandNames,
  evaluateCoverage,
  buildCoverageReport,
  resolveSkillsRoot,
  resolveSkillsDir,
  resolveSkillsContext,
  loadCommittedScorecard,
  detectScorecardDrift,
};
