#!/usr/bin/env node

/**
 * @module check-agents
 *
 * CLI command that validates all agent configs are complete and in sync.
 *
 * 1. Runs the skills drift check (lib/skills-sync) to verify generated agent
 *    skill mirrors (e.g. .codex/skills) match the canonical root skills/ source.
 * 2. Reads lib/agents/*.plugin.json to validate each plugin's schema/parity
 *    (support metadata, rules/skills scaffold paths, deprecated-tier consistency).
 * 3. Reports: skill drift, missing/stale skills, plugin parity errors.
 * 4. Exits 0 if all clean, exits non-zero if issues found.
 *
 * Usage:
 *   node scripts/check-agents.js
 *
 * Exports:
 *   checkAgents(repoRoot) -> { errors: string[], warnings: string[] }
 */

const path = require('path');
const fs = require('fs');
const { checkSkillsSync } = require('../lib/skills-sync');
const { validatePluginSchema } = require('../lib/plugin-manager');

/**
 * Validate a single plugin's schema + capability/scaffold parity.
 *
 * Command-surface parity is intentionally NOT validated: Forge is skills-only
 * (the .claude/commands/.cursor/commands/.codex/skills command surface was
 * removed in PR-A0). The surviving checks cover support metadata, the rules and
 * skills scaffold paths, and deprecated-tier consistency.
 *
 * @param {object} plugin
 * @param {string[]} errors - mutated with any parity errors
 */
function validatePluginParity(plugin, errors) {
  const validation = validatePluginSchema(plugin);
  if (!validation.valid) {
    const parityErrors = validation.errors.filter((error) =>
      error.startsWith('"support') || error.startsWith('"capabilities')
    );
    parityErrors.forEach((error) => {
      errors.push(`Plugin "${plugin.name || plugin.id}" (${plugin.id || 'unknown'}): ${error}`);
    });
  }

  const capabilities = plugin.capabilities || {};
  const dirs = plugin.directories || {};
  const supportStatus = plugin.support?.status;

  if (capabilities.rules && !dirs.rules) {
    errors.push(
      `Plugin "${plugin.name}" (${plugin.id}) declares rules capability but has no scaffold path configured.`
    );
  }

  if (capabilities.skills && !dirs.skills) {
    errors.push(
      `Plugin "${plugin.name}" (${plugin.id}) declares skills capability but has no scaffold path configured.`
    );
  }

  if (supportStatus === 'deprecated' || supportStatus === 'unsupported') {
    if (capabilities.skills) {
      errors.push(
        `Plugin "${plugin.name}" (${plugin.id}) is ${supportStatus} but still declares skills parity.`
      );
    }

    if (plugin.setup?.createSkill || dirs.skills) {
      errors.push(
        `Plugin "${plugin.name}" (${plugin.id}) is ${supportStatus} but still scaffolds Forge skills.`
      );
    }
  }
}

/**
 * Validate all agent configs are complete and in sync.
 *
 * @param {string} repoRoot - Absolute path to the repository root
 * @returns {{ errors: string[], warnings: string[] }}
 */
function checkAgents(repoRoot) {
  /** @type {string[]} */
  const errors = [];
  /** @type {string[]} */
  const warnings = [];

  // ---- 1. Skills drift check ----
  let driftResult;
  try {
    driftResult = checkSkillsSync({ repoRoot });
  } catch (err) {
    errors.push(`Skills sync check failed: ${err.message}`);
    return { errors, warnings };
  }

  const canonicalSkillsDir = path.join(repoRoot, 'skills');
  if (!fs.existsSync(canonicalSkillsDir)) {
    errors.push('No canonical skills found in skills/ — cannot verify skill sync.');
    return { errors, warnings };
  }

  if (driftResult.checkedAgents.length === 0) {
    warnings.push(
      'No generated agent skill directories found (e.g. .codex/skills) — skill drift check skipped. ' +
      'Run "forge setup" or "skills sync" to populate them.'
    );
  }

  for (const d of driftResult.drift) {
    errors.push(`Out of sync [${d.agent}]: ${d.skill}/${d.file} (${d.status})`);
  }

  // ---- 2. Validate plugin catalog ----
  const pluginDir = path.join(repoRoot, 'lib', 'agents');

  if (!fs.existsSync(pluginDir)) {
    warnings.push('No plugin directory found at lib/agents/ — plugin catalog validation skipped.');
  } else {
    const pluginFiles = fs.readdirSync(pluginDir).filter((f) => f.endsWith('.plugin.json'));

    if (pluginFiles.length === 0) {
      warnings.push('No plugin.json files found in lib/agents/ — plugin catalog validation skipped.');
    }

    for (const file of pluginFiles) {
      try {
        const plugin = JSON.parse(fs.readFileSync(path.join(pluginDir, file), 'utf8'));
        validatePluginParity(plugin, errors);
      } catch (_err) {
        errors.push(`Failed to parse plugin file: lib/agents/${file}`);
      }
    }
  }

  return { errors, warnings };
}

// ---- CLI entry point ----

if (require.main === module) {
  const repoRoot = path.resolve(__dirname, '..');
  const result = checkAgents(repoRoot);

  // Print warnings
  for (const warning of result.warnings) {
    console.warn(`Warning: ${warning}`);
  }

  // Print errors
  for (const error of result.errors) {
    console.error(`Error: ${error}`);
  }

  // Summary
  if (result.errors.length === 0 && result.warnings.length === 0) {
    console.log('All agent checks passed.');
    process.exit(0);
  } else if (result.errors.length === 0) {
    console.log(`\nAll agent checks passed with ${result.warnings.length} warning(s).`);
    process.exit(0);
  } else {
    console.error(`\n${result.errors.length} error(s), ${result.warnings.length} warning(s) found.`);
    process.exit(1);
  }
}

module.exports = { checkAgents };
