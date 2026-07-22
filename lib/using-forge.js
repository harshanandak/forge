'use strict';

/**
 * using-forge dispatch: shared helpers for Forge's reasoning-driven skill auto-trigger.
 *
 * Two consumers share this module:
 *  - the SessionStart context hook (lib/commands/hooks.js), which injects the using-forge
 *    dispatch bootstrap text so an agent auto-triggers skills from turn one (the Superpowers
 *    mechanism), and
 *  - the "forge skill for" router (lib/commands/skill.js), the DETERMINISTIC intent-to-skill
 *    fallback for harnesses without a SessionStart hook.
 *
 * Skills are read from the Forge PACKAGE's canonical skills/ dir (resolved via getPackageRoot:
 * the on-disk npm/dev package, or the compiled binary's extracted embedded assets) -- NEVER from
 * the consumer's projectRoot, which after `forge setup` has only generated mirrors and no root
 * skills/. Everything here is deterministic and NEVER throws -- an unresolved asset root or a
 * missing skills dir degrades to empty results.
 *
 * @module using-forge
 */

const fs = require('node:fs');
const path = require('node:path');
const { getPackageRoot } = require('./package-root');

const DISPATCH_SKILL = 'using-forge';

/** Strip a leading UTF-8 BOM (U+FEFF) without embedding the char literally in source. */
function stripBom(value) {
  const s = String(value);
  return s.charCodeAt(0) === 0xFEFF ? s.slice(1) : s;
}

/**
 * Resolve the root that carries the canonical `skills/` dir. Default: the Forge PACKAGE root
 * (getPackageRoot) so the dispatch skill/catalog work in a consumer project and a compiled
 * binary, not only in the Forge source checkout. An explicit `override` is honored where a
 * caller intentionally wants a specific root (tests / repo-local use). Never throws -> null.
 * @param {string} [override]
 * @returns {string|null}
 */
function resolveSkillsRoot(override) {
  if (override) return override;
  try {
    return getPackageRoot();
  } catch {
    return null;
  }
}

/**
 * Read the using-forge SKILL.md body (everything AFTER the frontmatter) -- the dispatch
 * bootstrap text the SessionStart hook injects. Empty string when unresolved/absent (fail-open).
 * @param {string} [override] - optional skills-root override (defaults to the package root).
 * @returns {string}
 */
function loadDispatchText(override) {
  const root = resolveSkillsRoot(override);
  if (!root) return '';
  const raw = readSkillFile(root, DISPATCH_SKILL);
  return raw ? stripFrontmatter(raw).trim() : '';
}

/** Read a canonical skill's SKILL.md text under `<root>/skills/<name>`, or null when absent. */
function readSkillFile(root, name) {
  try {
    const filePath = path.join(root, 'skills', name, 'SKILL.md');
    if (!fs.existsSync(filePath)) return null;
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
}

/** Remove a leading YAML frontmatter block (--- ... ---), returning the body. */
function stripFrontmatter(raw) {
  const text = stripBom(String(raw));
  if (!text.startsWith('---')) return text;
  const end = text.indexOf('\n---', 3);
  if (end === -1) return text;
  const afterClose = text.indexOf('\n', end + 1);
  return afterClose === -1 ? '' : text.slice(afterClose + 1);
}

/** Return the raw frontmatter block (between the leading `---` fences), or null when absent. */
function frontmatterBlock(raw) {
  const text = stripBom(String(raw));
  if (!text.startsWith('---')) return null;
  const end = text.indexOf('\n---', 3);
  return end === -1 ? text.slice(3) : text.slice(3, end);
}

/** Strip a single pair of leading/trailing quotes from a scalar value. */
function unquote(value) {
  return value.replace(/^['"]|['"]$/g, '');
}

/** Apply one frontmatter line to the running parse state (name / folded description block). */
function applyFrontmatterLine(state, line) {
  if (state.inDescription) {
    if (/^\s+\S/.test(line)) {
      state.descParts.push(line.trim());
    } else if (line.trim() !== '') {
      state.inDescription = false;
    }
    return;
  }
  // Detect the `name:` key without a regex: SonarCloud flags every /^name:.../ variant for
  // super-linear backtracking. startsWith + slice is behavior-identical — the remainder is
  // trimmed and unquoted, and an empty value leaves state.name unset just as `.+` required a value.
  if (line.startsWith('name:')) {
    const value = line.slice('name:'.length).trim();
    if (value) state.name = unquote(value);
    return;
  }
  const descMatch = /^description:\s*(.*)$/.exec(line);
  if (descMatch) {
    state.inDescription = true;
    const inline = descMatch[1].trim();
    if (inline && !['>', '|', '>-', '|-'].includes(inline)) state.descParts.push(unquote(inline));
  }
}

/** Parse the name and (flattened) description from a SKILL.md frontmatter block. */
function parseFrontmatter(raw) {
  const block = frontmatterBlock(raw);
  if (block === null) return { name: null, description: '' };
  const state = { name: null, descParts: [], inDescription: false };
  for (const line of block.split(/\r?\n/)) applyFrontmatterLine(state, line);
  return { name: state.name, description: state.descParts.join(' ').replace(/\s+/g, ' ').trim() };
}

/** Read one skill dir into a `{ name, description }` catalog entry, or null when unreadable. */
function readCatalogEntry(root, name) {
  const raw = readSkillFile(root, name);
  if (!raw) return null;
  const fm = parseFrontmatter(raw);
  return { name: fm.name || name, description: fm.description || '' };
}

/**
 * Load the canonical Forge skill catalog: name + description for every skills/*\/SKILL.md under
 * the resolved root. Sorted by name for determinism. Never throws -- an unresolved root or
 * absent dir yields an empty array (the router then honestly returns no matches).
 * @param {string} [override] - optional skills-root override (defaults to the package root).
 * @returns {{name: string, description: string}[]}
 */
function loadSkillCatalog(override) {
  const root = resolveSkillsRoot(override);
  if (!root) return [];
  let entries;
  try {
    entries = fs.readdirSync(path.join(root, 'skills'), { withFileTypes: true });
  } catch {
    return [];
  }
  const catalog = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const item = readCatalogEntry(root, entry.name);
    if (item) catalog.push(item);
  }
  catalog.sort((a, b) => a.name.localeCompare(b.name));
  return catalog;
}

// Curated intent-to-skill rules: the deterministic backbone of the router. Each rule scores when
// a situation contains one of its keyword phrases; weight lets a strong signal outrank an
// incidental token. Keywords match as normalized substrings, so a multi-word phrase matches only
// when adjacent. This is the reasoning fallback for harnesses that cannot auto-load the skill.
const INTENT_RULES = Object.freeze([
  { skill: 'plan', weight: 3, keywords: ['add a feature', 'add feature', 'new feature', 'build a', 'build the', 'scope', 'design a', 'design intent', 'brainstorm', 'plan ', 'break this into tasks', 'task list'] },
  { skill: 'dev', weight: 3, keywords: ['fix a failing test', 'failing test', 'fix a bug', 'fix the bug', 'fix this bug', 'debug', 'implement', 'write the code', 'red-green', 'tdd', 'unexpected behavior', 'broken'] },
  { skill: 'validate', weight: 3, keywords: ['run tests', 'run the tests', 'lint', 'type check', 'typecheck', 'type-check', 'validate', 'security scan', 'run checks', 'all checks'] },
  { skill: 'ship', weight: 3, keywords: ['open a pr', 'open pr', 'create a pr', 'create pr', 'raise a pr', 'push the branch', 'push branch', 'ship it', 'make a pull request', 'pull request'] },
  { skill: 'review', weight: 3, keywords: ['review feedback', 'address feedback', 'pr feedback', 'coderabbit', 'greptile', 'review comment', 'resolve threads', 'address the review'] },
  { skill: 'verify', weight: 3, keywords: ['post-merge', 'after merge', 'verify health', 'health check', 'ci on main', 'close the issue after merge'] },
  { skill: 'triage-ready', weight: 3, keywords: ['what should i work on', 'what to work on', 'next ready', 'ready queue', 'pick the next', 'what is ready', 'rank the'] },
  { skill: 'status', weight: 3, keywords: ['where am i', 'current stage', 'what stage', 'stale work', 'status', 'active work', 'whats going on'] },
  { skill: 'issue-basics', weight: 2, keywords: ['create an issue', 'close an issue', 'update an issue', 'search issues', 'comment on an issue', 'file an issue', 'new issue'] },
  { skill: 'memory', weight: 2, keywords: ['remember', 'recall', 'remember that', 'recall the', 'save a note', 'persist a note', 'note the decision', 'jot down', 'remind me'] },
  { skill: 'claim-safety', weight: 2, keywords: ['claim an issue', 'claim the issue', 'prove ownership', 'own the lease', 'lease'] },
  { skill: 'smith', weight: 2, keywords: ['end to end', 'end-to-end', 'drive one issue', 'plan to merged', 'whole issue', 'from plan to pr'] },
  { skill: 'shepherd', weight: 3, keywords: ['monitor a pr', 'shepherd', 'watch the pr', 'watch my pr', 'ci status', 'poll the pr', 'pr checks', 'pr blocked', 'blocking my pr', 'blocking the pr', 'pr merging', 'pr not merging', 'ready to merge', 'merge ready', 'pr check failed', 'pr check went red', 'keep an eye on my pr', 'keep an eye on the pr', 'keep an eye on my prs', 'babysit my pr', 'babysit the pr', 'keep watching my pr', 'keep watching the pr', 'pr verdict', 'shepherd daemon', 'watch the pull request'] },
  { skill: 'worktree', weight: 3, keywords: ['forge worktree', 'create a worktree', 'worktree list', 'isolated branch', 'isolated worktree', 'isolated checkout', 'spin up a worktree', 'work on another pr', 'merged worktrees', 'clean up merged', 'clean merged', 'orphaned worktree', 'remove the worktree', 'worktree miss', 'worktree dependencies', 'forge clean'] },
  { skill: 'gates', weight: 3, keywords: ['disable the gate', 'disable a gate', 'enable a gate', 'enable the gate', 'toggle a gate', 'toggle the gate', 'tdd gate', 'disable the tdd', 'turn off tdd', 'tdd enforcement', 'tdd intent', 'kernel tracking rail', 'auto shepherd rail', 'loosen enforcement', 'approve the human gate', 'approve a human gate', 'human gate', 'forge control', 'forge gate', 'forge gate check', 'forge gate status', 'doc-gate', 'forge doc-gate'] },
  { skill: 'setup', weight: 3, keywords: ['forge setup', 'install forge', 'set up forge', 'forge init', 'initialize forge', 'adoption profile', 'forge doctor', 'forge upgrade', 'upgrade forge', 'forge hooks', 'hooks globally', 'native hooks', 'forge reset', 'reset the forge', 'forge install', 'forge reinstall', 'reinstall forge', 'forge recommend', 'scaffold forge'] },
  { skill: 'portability', weight: 3, keywords: ['forge export', 'export the backlog', 'export the kernel', 'kernel backlog', 'backlog jsonl', 'back up the backlog', 'snapshot the backlog', 'hydrate the backlog', 'forge migrate', 'migrate from beads', 'beads migration', 'migrate the beads', 'beads issue', 'import the beads', 'import a beads store', 'v2 to v3 migration'] },
  { skill: 'research', weight: 2, keywords: ['research', 'best practices', 'investigate the landscape', 'deep research', 'compare libraries'] },
  { skill: 'parallel-deep-research', weight: 2, keywords: ['market research', 'competitive research', 'competitor analysis', 'competitive analysis', 'competitive landscape', 'market landscape'] },
  { skill: 'sonarcloud', weight: 2, keywords: ['sonarcloud', 'sonar', 'quality gate', 'code smell', 'code smells', 'cognitive complexity'] },
  { skill: 'sonarcloud-analysis', weight: 1, keywords: ['sonarcloud analysis', 'sonar analysis', 'sonarcloud report', 'analyze with sonar'] },
  { skill: 'rollback', weight: 2, keywords: ['revert', 'roll back', 'rollback', 'undo the merge', 'undo a change'] },
  { skill: 'kernel', weight: 1, keywords: ['how does forge', 'which command', 'which skill', 'how is forge set up', 'new here', 'orient'] },
  { skill: 'hermes-forge', weight: 2, keywords: ['hermes', 'hermes session', 'hermes harness'] },
]);

/** Normalize a situation string for matching: lowercase, collapse whitespace, strip punctuation. */
function normalizeSituation(situation) {
  return String(situation || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * True when `norm` contains `keyword` as a WHOLE token/phrase, not as a substring inside a larger
 * word. Bare "lease" must not fire on "please review"; "plan" must not fire on "planning". `norm`
 * is pre-normalized (lowercase; only [a-z0-9\s-]), so the boundary is start/end or a non-[a-z0-9]
 * char. Works for single words and multi-word phrases alike.
 */
function matchesKeyword(norm, keyword) {
  const needle = keyword.trim();
  if (!needle) return false;
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp('(?:^|[^a-z0-9])' + escaped + '(?:[^a-z0-9]|$)').test(norm);
}

/** Accumulate a weighted score + reason for a skill into the scores map. */
function bumpScore(scores, skill, amount, reason) {
  if (!scores.has(skill)) scores.set(skill, { score: 0, reasons: new Set() });
  const entry = scores.get(skill);
  entry.score += amount;
  if (reason) entry.reasons.add(reason);
}

/**
 * Score curated intent rules. Only skills PRESENT in the catalog (`known`) are ever scored, so an
 * empty/unavailable catalog produces no matches instead of fabricating nonexistent skill names.
 */
function scoreCuratedRules(norm, known, scores) {
  for (const rule of INTENT_RULES) {
    if (!known.has(rule.skill)) continue;
    for (const kw of rule.keywords) {
      if (matchesKeyword(norm, kw)) bumpScore(scores, rule.skill, rule.weight, 'matches "' + kw.trim() + '"');
    }
  }
}

/**
 * Light token-overlap bonus against each skill's own description — a TIE-BREAKER ONLY. It bumps
 * ONLY skills that already earned a curated INTENT_RULES hit (present in `scores`); it never
 * introduces a new skill on description overlap alone. Otherwise a generic, non-Forge prompt
 * ("please review this commit") would route into a workflow stage via incidental token overlap.
 */
function scoreDescriptionOverlap(norm, catalog, scores) {
  const tokens = new Set(norm.split(' ').filter(t => t.length >= 4));
  for (const skill of catalog) {
    if (!scores.has(skill.name)) continue; // no curated hit -> not a routing candidate
    const desc = normalizeSituation(skill.description);
    let overlap = 0;
    for (const token of tokens) {
      if (desc.includes(token)) overlap += 1;
    }
    if (overlap > 0) bumpScore(scores, skill.name, Math.min(overlap * 0.25, 1), 'described intent');
  }
}

/** Rank scored skills highest-first (name tiebreak) and cap to `limit`. */
function rankMatches(scores, limit) {
  return [...scores.entries()]
    .filter(([, v]) => v.score > 0)
    .map(([name, v]) => ({ name, score: Math.round(v.score * 100) / 100, why: [...v.reasons].join('; ') }))
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
    .slice(0, limit);
}

/**
 * Deterministically route a natural-language situation to the best-fit Forge skill(s).
 *
 * Scoring: curated INTENT_RULES keyword hits (weighted, catalog-gated) PLUS a light token-overlap
 * bonus against each skill's own description. Ties break by skill name for determinism. When the
 * catalog is empty/unavailable, returns no matches (unknown:true) rather than nonexistent skills.
 *
 * @param {string} situation
 * @param {object} [options]
 * @param {{name: string, description: string}[]} [options.catalog] - skill catalog (injectable).
 * @param {number} [options.limit=3] - max matches to return.
 * @returns {{ situation: string, matches: {name: string, score: number, why: string}[], best: string|null, unknown: boolean }}
 */
function routeSkill(situation, options = {}) {
  const catalog = options.catalog || [];
  const limit = Number.isInteger(options.limit) && options.limit > 0 ? options.limit : 3;
  const norm = normalizeSituation(situation);
  const known = new Set(catalog.map(s => s.name));

  const scores = new Map();
  if (norm) {
    scoreCuratedRules(norm, known, scores);
    // Description overlap is a tie-breaker among curated hits only. With NO curated hit the situation
    // is not a confident Forge-skill match -> unknown (no overlap-only routing of generic prompts).
    if (scores.size > 0) scoreDescriptionOverlap(norm, catalog, scores);
  }

  const matches = rankMatches(scores, limit);
  return {
    situation: String(situation || ''),
    matches,
    best: matches.length > 0 ? matches[0].name : null,
    unknown: matches.length === 0,
  };
}

module.exports = {
  DISPATCH_SKILL,
  INTENT_RULES,
  resolveSkillsRoot,
  loadDispatchText,
  loadSkillCatalog,
  parseFrontmatter,
  stripFrontmatter,
  normalizeSituation,
  routeSkill,
};
