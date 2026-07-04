'use strict';

/**
 * `forge role <role> --use <skill> [--ideology <name>]`
 *
 * Thin SWAP verb over the sparse config writer: binds a role to a skill and/or
 * ideology by writing `roles.<role>.skill` / `roles.<role>.ideology` in
 * `.forge/config.yaml`. `forge options roles --json` reflects the binding
 * through the shipped resolver (`applyRoleConfig`).
 *
 * Write-time validation errors BEFORE anything is written:
 *  - unknown role (not in the KNOWN closed set ROLE_IDS)
 *  - unresolvable skill (no SKILL.md under `.skills/ > skills/`)
 *
 * The skill name is OPEN-WORLD (a bring-your-own skill is fine) — it is checked
 * for existence/trust, never against the closed PLAN_SUBSKILL enum.
 */

const { setConfigOverride, resolveSkill } = require('../config-writer');
const { ROLE_IDS } = require('../core/runtime-graph');

function usage() {
  return 'Usage: forge role <role> --use <skill> [--ideology <name>]';
}

function parseArgs(args) {
  const parsed = { role: args[0], skill: undefined, ideology: undefined };
  for (let i = 1; i < args.length; i += 1) {
    const token = args[i];
    if (token === '--use' || token === '--skill') {
      if (i + 1 >= args.length) {
        return { error: `${token} requires a value.` };
      }
      parsed.skill = args[i + 1];
      i += 1;
    } else if (token === '--ideology') {
      if (i + 1 >= args.length) {
        return { error: `${token} requires a value.` };
      }
      parsed.ideology = args[i + 1];
      i += 1;
    } else {
      return { error: `Unknown argument '${token}'.` };
    }
  }
  return { parsed };
}

async function handler(args, _flags, projectRoot = process.cwd()) {
  const { parsed, error } = parseArgs(args);
  if (error) {
    return { success: false, error: `${error}\n${usage()}` };
  }
  if (!parsed.role) {
    return { success: false, error: usage() };
  }
  if (!ROLE_IDS.has(parsed.role)) {
    return {
      success: false,
      error: `Unknown role '${parsed.role}'. Known roles: ${[...ROLE_IDS].join(', ')}`,
    };
  }
  if (parsed.skill === undefined && parsed.ideology === undefined) {
    return { success: false, error: `Nothing to set — pass --use and/or --ideology.\n${usage()}` };
  }
  if (parsed.skill !== undefined) {
    if (typeof parsed.skill !== 'string' || parsed.skill === '') {
      return { success: false, error: `--use requires a skill name.\n${usage()}` };
    }
    if (!resolveSkill(projectRoot, parsed.skill)) {
      return {
        success: false,
        error: `Unknown skill '${parsed.skill}' — no SKILL.md found under .skills/ or skills/.`,
      };
    }
  }
  if (parsed.ideology !== undefined && (typeof parsed.ideology !== 'string' || parsed.ideology === '')) {
    return { success: false, error: `--ideology requires a name.\n${usage()}` };
  }

  const writes = [];
  if (parsed.skill !== undefined) {
    setConfigOverride(projectRoot, ['roles', parsed.role, 'skill'], parsed.skill);
    writes.push(`roles.${parsed.role}.skill=${parsed.skill}`);
  }
  if (parsed.ideology !== undefined) {
    setConfigOverride(projectRoot, ['roles', parsed.role, 'ideology'], parsed.ideology);
    writes.push(`roles.${parsed.role}.ideology=${parsed.ideology}`);
  }

  return { success: true, output: `Updated ${writes.join(', ')}` };
}

module.exports = {
  name: 'role',
  description: 'Bind a role to a skill/ideology in .forge/config.yaml',
  usage: usage(),
  handler,
};
