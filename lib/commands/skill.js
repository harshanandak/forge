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

const { routeSkill, loadSkillCatalog } = require('../using-forge');

const USAGE = 'Usage: forge skill for "<situation>" [--json]';

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
function handleFor(rest, flags, projectRoot) {
  const { situation, json } = parseForArgs(rest, flags);
  if (!situation) {
    return { success: false, error: 'Missing situation.\n' + USAGE };
  }
  const catalog = loadSkillCatalog(projectRoot);
  const result = routeSkill(situation, { catalog });
  if (json) {
    return { success: true, result, output: JSON.stringify(result, null, 2) + '\n' };
  }
  return { success: true, result, output: formatRouting(result) };
}

module.exports = {
  name: 'skill',
  description: 'Route a situation to the best-fit Forge skill (forge skill for "<situation>")',
  usage: USAGE + '\n       (future: forge skill eval | forge skill scores)',
  flags: {
    '--json': 'Emit the machine-readable routing result',
  },
  handler: (args, flags = {}, projectRoot = process.cwd()) => {
    const verb = args[0];
    if (verb === 'for') {
      return handleFor(args.slice(1), flags, projectRoot);
    }
    if (!verb) {
      return { success: false, error: 'Missing verb.\n' + USAGE };
    }
    return {
      success: false,
      error: "Unknown verb '" + verb + "'. Supported: for.\n" + USAGE,
    };
  },
  // Exposed for unit tests; not part of the CLI surface.
  _internal: { parseForArgs, formatRouting, handleFor },
};
