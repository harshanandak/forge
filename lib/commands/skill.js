'use strict';

/**
 * Forge Skill Command -- the unified "forge skill <verb>" noun.
 *
 * "forge skill for <situation>" is a DETERMINISTIC intent-to-skill router: it reads the canonical
 * skill catalog (skills/*\/SKILL.md frontmatter) and prints the best-fit Forge skill(s) plus WHY,
 * as the reasoning fallback for harnesses without a SessionStart hook that can auto-inject the
 * using-forge dispatch skill. It NEVER opens the kernel and NEVER throws.
 *
 * The noun is structured so later waves can add sibling verbs (forge skill eval, forge skill
 * scores) without a new top-level command -- the owner's command-surface rule: unify related
 * commands under one self-explanatory noun instead of scattering verbs.
 *
 * @module commands/skill
 */

const fs = require('node:fs');
const path = require('node:path');
const { routeSkill, loadSkillCatalog, resolveSkillsRoot } = require('../using-forge');
const skillEval = require('../skill-eval');

const USAGE = 'Usage: forge skill for "<situation>" [--json]\n' +
  '       forge skill eval [name] --static [--json]\n' +
  '       forge skill scores [--json]';

/** Extract the situation text (all non-flag args after the verb) and json flag. */
function parseForArgs(rest, flags) {
  const positional = rest.filter(a => typeof a === 'string' && !a.startsWith('--'));
  const json = flags.json === true || flags['--json'] === true || rest.includes('--json');
  return { situation: positional.join(' ').trim(), json };
}

/** Render the human-readable routing answer. */
function formatRouting(result) {
  const lines = ['Best skill for: "' + result.situation + '"', ''];
  if (result.unknown) {
    lines.push(
      'No confident match. This may not need a Forge skill -- or describe it more concretely.',
      'Fallbacks: `forge ready` for what to work on, or the kernel skill to see the whole surface.',
    );
    return lines.join('\n');
  }
  const [top, ...rest] = result.matches;
  lines.push(
    '-> ' + top.name + '  (' + top.why + ')',
    '  Announce: "Using ' + top.name + ' to ..." then follow the skill.',
  );
  if (rest.length > 0) {
    lines.push('', 'Also consider:');
    for (const m of rest) lines.push('  - ' + m.name + '  (' + m.why + ')');
  }
  return lines.join('\n');
}

/** "forge skill for <situation>" -- deterministic router. */
function handleFor(rest, flags) {
  const { situation, json } = parseForArgs(rest, flags);
  if (!situation) {
    return { success: false, error: 'Missing situation.\n' + USAGE };
  }
  // Read the canonical catalog from the Forge PACKAGE (not projectRoot): a set-up consumer
  // project has no root skills/, so the routable skills live in the package assets.
  const catalog = loadSkillCatalog();
  const result = routeSkill(situation, { catalog });
  if (json) {
    return { success: true, result, output: JSON.stringify(result, null, 2) + '\n' };
  }
  return { success: true, result, output: formatRouting(result) };
}

/** Resolve the skills SOURCE dir (canonical skills/ under the package/dev root), or null. */
function resolveSkillsDir(projectRoot) {
  const root = resolveSkillsRoot(projectRoot);
  if (!root) return null;
  const dir = path.join(root, 'skills');
  return fs.existsSync(dir) ? dir : null;
}

/** Write a scorecard to skills/<name>/evals/scorecard.json (stable 2-space JSON + trailing NL). */
function writeScorecard(skillsDir, name, card) {
  const dir = path.join(skillsDir, name, 'evals');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'scorecard.json'), JSON.stringify(card, null, 2) + '\n');
}

/**
 * "forge skill eval [name] --static [--json]" -- compute + persist the DETERMINISTIC scorecard(s).
 * All skills when no name. --static is the only tier today (behavioral is W5); it is accepted (and
 * implied) so the flag reads honestly and future tiers can branch here.
 */
function handleEval(rest, flags, projectRoot) {
  const json = flags.json === true || flags['--json'] === true || rest.includes('--json');
  const positional = rest.filter(a => typeof a === 'string' && !a.startsWith('--'));
  const name = positional[0];
  const skillsDir = resolveSkillsDir(projectRoot);
  if (!skillsDir) {
    return { success: false, error: 'No canonical skills/ directory found (run from a Forge checkout).' };
  }
  const catalog = loadSkillCatalog(projectRoot);
  const targets = name
    ? [name]
    : fs.readdirSync(skillsDir, { withFileTypes: true })
        .filter(e => e.isDirectory() && fs.existsSync(path.join(skillsDir, e.name, 'SKILL.md')))
        .map(e => e.name)
        .sort();

  const written = [];
  const cards = {};
  for (const target of targets) {
    const card = skillEval.buildScorecard({ skillsDir, name: target, catalog });
    if (!card) {
      if (name) return { success: false, error: `Skill '${name}' not found under ${skillsDir}.` };
      continue;
    }
    writeScorecard(skillsDir, target, card);
    written.push(target);
    cards[target] = card;
  }

  if (json) {
    return { success: true, cards, output: JSON.stringify(name ? cards[name] : cards, null, 2) + '\n' };
  }
  const lines = ['Static scorecards written (deterministic tier):'];
  for (const t of written) lines.push('  ' + t + '  composite=' + cards[t].composite);
  lines.push('', 'Behavioral tier (recall/precision/chains/outcome/variance) is W5.');
  return { success: true, cards, output: lines.join('\n') };
}

/** Render the worst-first league table from a scorecards map. */
function formatScores(scorecards, gate) {
  const rows = Object.values(scorecards)
    .map(c => ({
      skill: c.skill,
      composite: c.composite,
      dq: c.static.description_quality.score,
      tok: c.static.token_cost.score,
      caps: c.static.caps.score,
      fixtures: c.fixtures,
    }))
    .sort((a, b) => a.composite - b.composite || a.skill.localeCompare(b.skill));

  const lines = ['Skill scores (static tier — worst first). Composite = 0.5*desc-quality + 0.3*token-cost + 0.2*caps.', ''];
  lines.push('  COMPOSITE  DESC-Q  TOKEN  CAPS  FIXTURES  SKILL');
  for (const r of rows) {
    lines.push(
      '  ' + String(r.composite).padStart(9) +
      '  ' + String(r.dq).padStart(6) +
      '  ' + String(r.tok).padStart(5) +
      '  ' + String(r.caps).padStart(4) +
      '  ' + r.fixtures.padEnd(8) +
      '  ' + r.skill,
    );
  }
  if (gate.warnings.length > 0) {
    lines.push('', 'Router-reachability warnings (paraphrase gap — W5 judge is the fix, not blocking):');
    for (const w of gate.warnings) lines.push('  - ' + w.skill + ': ' + w.detail);
  }
  lines.push('', gate.passed ? 'CI gate: PASS' : 'CI gate: FAIL (' + gate.failures.length + ')');
  for (const f of gate.failures) lines.push('  x ' + f.skill + ': ' + f.kind + ' — ' + f.detail);
  return lines.join('\n');
}

/** "forge skill scores [--json]" -- the league table over committed/recomputed scorecards. */
function handleScores(rest, flags, projectRoot) {
  const json = flags.json === true || flags['--json'] === true || rest.includes('--json');
  const skillsDir = resolveSkillsDir(projectRoot);
  if (!skillsDir) {
    return { success: false, error: 'No canonical skills/ directory found (run from a Forge checkout).' };
  }
  const catalog = loadSkillCatalog(projectRoot);
  const scorecards = skillEval.buildAllScorecards(skillsDir, catalog);
  const gate = skillEval.evaluateGate(scorecards);
  if (json) {
    return { success: true, scorecards, gate, output: JSON.stringify({ scorecards, gate }, null, 2) + '\n' };
  }
  return { success: true, scorecards, gate, output: formatScores(scorecards, gate) };
}

module.exports = {
  name: 'skill',
  description: 'Route, evaluate, and score Forge skills (forge skill for | eval | scores)',
  usage: USAGE,
  flags: {
    '--json': 'Emit the machine-readable result',
    '--static': 'Score only the deterministic static tier (the only tier today; behavioral is W5)',
  },
  // flags is the LAST declared param so its `= {}` default is trailing (SonarCloud S1788). The
  // registry still passes (args, flags, projectRoot, opts) — the router reads the canonical catalog
  // from the package root; eval/scores read the canonical skills/ source dir.
  handler: (args, flags = {}, projectRoot) => {
    const verb = args[0];
    if (verb === 'for') {
      return handleFor(args.slice(1), flags);
    }
    if (verb === 'eval') {
      return handleEval(args.slice(1), flags, projectRoot);
    }
    if (verb === 'scores') {
      return handleScores(args.slice(1), flags, projectRoot);
    }
    if (!verb) {
      return { success: false, error: 'Missing verb.\n' + USAGE };
    }
    return {
      success: false,
      error: "Unknown verb '" + verb + "'. Supported: for, eval, scores.\n" + USAGE,
    };
  },
  // Exposed for unit tests; not part of the CLI surface.
  _internal: { parseForArgs, formatRouting, handleFor, handleEval, handleScores, formatScores },
};
