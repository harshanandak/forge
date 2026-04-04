#!/usr/bin/env node

/**
 * @module check-agents
 *
 * CLI command that validates all agent configs are complete and in sync.
 *
 * 1. Runs syncCommands({ check: true }) to verify agent command files match canonical source
 * 2. Reads lib/agents/*.plugin.json to verify each agent with capabilities.commands: true
 *    has its command directory populated with expected files
 * 3. Reports: missing files, out-of-sync files, stale files
 * 4. Exits 0 if all clean, exits non-zero if issues found
 *
 * Usage:
 *   node scripts/check-agents.js
 *
 * Exports:
 *   checkAgents(repoRoot) -> { errors: string[], warnings: string[] }
 */

const { syncCommands } = require('./sync-commands');
const { AGENT_ADAPTERS } = require('./sync-commands');
const path = require('path');
const fs = require('fs');
const { validatePluginSchema } = require('../lib/plugin-manager');

const SYNC_ADAPTER_BY_PLUGIN_ID = Object.freeze({
  claude: 'claude-code',
  cline: 'cline',
  codex: 'codex',
  copilot: 'github-copilot',
  cursor: 'cursor',
  kilocode: 'kilo-code',
  opencode: 'opencode',
  roo: 'roo-code',
});

function normalizeRelativeDir(dir) {
  if (!dir) return null;
  return String(dir).replace(/\\/g, '/').replace(/\/+$/, '');
}

function getDeclaredCommandDir(plugin) {
  const dirs = plugin.directories || {};
  return dirs.commands || dirs.workflows || dirs.prompts || dirs.skills || null;
}

function getExpectedCommandDir(plugin) {
  const adapterId = SYNC_ADAPTER_BY_PLUGIN_ID[plugin.id];
  if (!adapterId) {
    return null;
  }

  const adapter = AGENT_ADAPTERS[adapterId];
  if (!adapter) {
    return null;
  }

  if (plugin.id === 'codex') {
    return normalizeRelativeDir(plugin.directories?.skills || adapter.baseDir);
  }

  return normalizeRelativeDir(adapter.baseDir);
}

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

  if (capabilities.commands) {
    const expectedDir = getExpectedCommandDir(plugin);
    const declaredDir = normalizeRelativeDir(getDeclaredCommandDir(plugin));

    if (!expectedDir) {
      errors.push(
        `Plugin "${plugin.name}" (${plugin.id}) declares commands support but has no Forge sync adapter.`
      );
    } else if (!declaredDir) {
      errors.push(
        `Plugin "${plugin.name}" (${plugin.id}) declares commands support but has no command directory configured.`
      );
    } else if (declaredDir !== expectedDir) {
      errors.push(
        `Plugin "${plugin.name}" (${plugin.id}) command directory "${declaredDir}" does not match sync output "${expectedDir}".`
      );
    }
  }

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

  // ---- 1. Run sync check ----
  let syncResult;
  try {
    syncResult = syncCommands({ check: true, dryRun: false, repoRoot });
  } catch (err) {
    errors.push(`Sync check failed: ${err.message}`);
    return { errors, warnings };
  }

  if (syncResult.empty) {
    errors.push('No command files found in .claude/commands/ — cannot verify sync.');
    return { errors, warnings };
  } else {
    if (syncResult.manifestMissing) {
      warnings.push(
        'Sync manifest (.forge/sync-manifest.json) not found — stale file detection skipped. ' +
        'Run "node scripts/sync-commands.js" to generate it.'
      );
    }

    if (syncResult.outOfSync && syncResult.outOfSync.length > 0) {
      for (const entry of syncResult.outOfSync) {
        const relPath = path.join(entry.dir, entry.filename);
        const exists = fs.existsSync(entry.filePath);
        const status = exists ? 'modified' : 'missing';
        errors.push(`Out of sync [${entry.agent}]: ${relPath} (${status})`);
      }
    }

    if (syncResult.staleFiles && syncResult.staleFiles.length > 0) {
      for (const filePath of syncResult.staleFiles) {
        const relPath = path.relative(repoRoot, filePath);
        errors.push(`Stale file (no longer generated, should be removed): ${relPath}`);
      }
    }
  }

  // ---- 2. Validate plugin catalog ----
  const pluginDir = path.join(repoRoot, 'lib', 'agents');
  /** @type {object[]} */
  const plugins = [];

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
        plugins.push(plugin);
        validatePluginParity(plugin, errors);
      } catch (_err) {
        errors.push(`Failed to parse plugin file: lib/agents/${file}`);
      }
    }

    // For each plugin with commands: true, verify its command directory has files
    for (const plugin of plugins) {
      if (!plugin.capabilities || !plugin.capabilities.commands) {
        continue;
      }

      // Find the command directory from the plugin's directories config
      const dirs = plugin.directories || {};
      // Plugins use different keys: commands, workflows, prompts, skills
      const commandDir = dirs.commands || dirs.workflows || dirs.prompts;

      if (!commandDir) {
        // Plugin declares commands: true but has no command directory configured
        // Codex is the only agent that uses skills as its command mechanism
        if (plugin.id === 'codex' && dirs.skills) {
          // Codex CLI: commands live in .codex/skills/<name>/SKILL.md — skip standard check
          continue;
        }
        warnings.push(
          `Plugin "${plugin.name}" (${plugin.id}) has commands: true but no command directory configured.`
        );
        continue;
      }

      const absCmdDir = path.join(repoRoot, commandDir);

      if (!fs.existsSync(absCmdDir)) {
        errors.push(
          `Plugin "${plugin.name}" (${plugin.id}) has commands: true but directory "${commandDir}" does not exist.`
        );
        continue;
      }

      // Check the directory has at least one file
      const files = fs.readdirSync(absCmdDir).filter((f) => !f.startsWith('.'));
      if (files.length === 0) {
        errors.push(
          `Plugin "${plugin.name}" (${plugin.id}) has commands: true but directory "${commandDir}" is empty.`
        );
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
