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
 * Everything here is deterministic and file-based (reads the canonical skills/ frontmatter); it
 * NEVER opens the kernel and NEVER throws -- a missing skills dir degrades to empty results.
 *
 * @module using-forge
 */

const fs = require('node:fs');
const path = require('node:path');

const DISPATCH_SKILL = 'using-forge';

/** Strip a leading UTF-8 BOM (U+FEFF) without embedding the char literally in source. */
function stripBom(value) {
  const s = String(value);
  return s.charCodeAt(0) === 0xFEFF ? s.slice(1) : s;
}

/**
 * Read the using-forge SKILL.md body (everything AFTER the frontmatter). This is the dispatch
 * bootstrap text the SessionStart hook injects. Returns empty string when the file is
 * absent/unreadable so injection fails open.
 * @param {string} projectRoot
 * @returns {string}
 */
function loadDispatchText(projectRoot) {
  const raw = readSkillFile(projectRoot, DISPATCH_SKILL);
  if (!raw) return '';
  return stripFrontmatter(raw).trim();
}

/** Read a canonical skill's SKILL.md text, or null when absent. */
function readSkillFile(projectRoot, name) {
  try {
    const filePath = path.join(projectRoot, 'skills', name, 'SKILL.md');
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

/** Parse the name and (flattened) description from a SKILL.md frontmatter block. */
function parseFrontmatter(raw) {
  const text = stripBom(String(raw));
  if (!text.startsWith('---')) return { name: null, description: '' };
  const end = text.indexOf('\n---', 3);
  const block = end === -1 ? text.slice(3) : text.slice(3, end);
  const lines = block.split(/\r?\n/);

  let name = null;
  const descParts = [];
  let inDescription = false;

  for (const line of lines) {
    const nameMatch = /^name:\s*(.+)\s*$/.exec(line);
    if (nameMatch && !inDescription) {
      name = nameMatch[1].trim().replace(/^['"]|['"]$/g, '');
      continue;
    }
    const descMatch = /^description:\s*(.*)$/.exec(line);
    if (descMatch && !inDescription) {
      inDescription = true;
      const inline = descMatch[1].trim();
      // A folded/literal block scalar has its text on the following indented lines.
      if (inline && inline !== '>' && inline !== '|' && inline !== '>-' && inline !== '|-') {
        descParts.push(inline.replace(/^['"]|['"]$/g, ''));
      }
      continue;
    }
    if (inDescription) {
      // The description block continues while lines are indented, ends at a new top-level key.
      if (/^\s+\S/.test(line)) {
        descParts.push(line.trim());
      } else if (line.trim() !== '') {
        inDescription = false;
      }
    }
  }

  return { name, description: descParts.join(' ').replace(/\s+/g, ' ').trim() };
}

/**
 * Load the canonical Forge skill catalog: name + description for every skills/*\/SKILL.md.
 * Sorted by name for determinism. Never throws -- an absent dir yields an empty array.
 * @param {string} projectRoot
 * @returns {{name: string, description: string}[]}
 */
function loadSkillCatalog(projectRoot) {
  const skillsDir = path.join(projectRoot, 'skills');
  let entries;
  try {
    entries = fs.readdirSync(skillsDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const catalog = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const raw = readSkillFile(projectRoot, entry.name);
    if (!raw) continue;
    const fm = parseFrontmatter(raw);
    catalog.push({ name: fm.name || entry.name, description: fm.description || '' });
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
  { skill: 'claim-safety', weight: 2, keywords: ['claim an issue', 'claim the issue', 'prove ownership', 'own the lease', 'lease'] },
  { skill: 'smith', weight: 2, keywords: ['end to end', 'end-to-end', 'drive one issue', 'plan to merged', 'whole issue', 'from plan to pr'] },
  { skill: 'shepherd', weight: 2, keywords: ['monitor a pr', 'shepherd', 'watch the pr', 'ci status', 'poll the pr', 'pr checks'] },
  { skill: 'research', weight: 2, keywords: ['research', 'best practices', 'investigate the landscape', 'deep research', 'compare libraries'] },
  { skill: 'rollback', weight: 2, keywords: ['revert', 'roll back', 'rollback', 'undo the merge', 'undo a change'] },
  { skill: 'kernel', weight: 1, keywords: ['how does forge', 'which command', 'which skill', 'how is forge set up', 'new here', 'orient'] },
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
 * Deterministically route a natural-language situation to the best-fit Forge skill(s).
 *
 * Scoring: curated INTENT_RULES keyword hits (weighted) PLUS a light token-overlap bonus against
 * each skill's own description (so a skill whose description literally mentions the situation's
 * words still ranks even without a curated rule). Ties break by skill name for determinism.
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

  const scores = new Map(); // skill -> { score, reasons:Set }
  const bump = (skill, amount, reason) => {
    if (!scores.has(skill)) scores.set(skill, { score: 0, reasons: new Set() });
    const entry = scores.get(skill);
    entry.score += amount;
    if (reason) entry.reasons.add(reason);
  };

  if (norm) {
    // 1) Curated intent rules (only for skills that actually exist in the catalog).
    for (const rule of INTENT_RULES) {
      if (known.size > 0 && !known.has(rule.skill)) continue;
      for (const kw of rule.keywords) {
        if (norm.includes(kw)) bump(rule.skill, rule.weight, 'matches "' + kw.trim() + '"');
      }
    }
    // 2) Description token-overlap bonus (fractional so it never outranks a curated hit).
    const tokens = norm.split(' ').filter(t => t.length >= 4);
    for (const skill of catalog) {
      const desc = normalizeSituation(skill.description);
      let overlap = 0;
      for (const token of new Set(tokens)) {
        if (desc.includes(token)) overlap += 1;
      }
      if (overlap > 0) bump(skill.name, Math.min(overlap * 0.25, 1), 'described intent');
    }
  }

  const matches = [...scores.entries()]
    .filter(([, v]) => v.score > 0)
    .map(([name, v]) => ({ name, score: Math.round(v.score * 100) / 100, why: [...v.reasons].join('; ') }))
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
    .slice(0, limit);

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
  loadDispatchText,
  loadSkillCatalog,
  parseFrontmatter,
  stripFrontmatter,
  normalizeSituation,
  routeSkill,
};
