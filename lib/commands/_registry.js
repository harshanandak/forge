/**
 * Command Registry — Auto-Discovery
 *
 * Scans a commands directory for .js files, validates each exports
 * { name, description, handler }, and builds a routing Map.
 *
 * Follows the same fs.readdirSync() pattern as lib/plugin-manager.js.
 *
 * @module _registry
 */

const { existsSync, readdirSync } = require('node:fs');
const path = require('node:path');
const { normalizeStageId } = require('../workflow/stages');

/**
 * @typedef {Object} CommandModule
 * @property {string} name - Command name used for routing
 * @property {string} description - Human-readable description
 * @property {function(Array, Object, string): Promise<*>} handler - Async command handler
 * @property {string} [usage] - Usage string (optional)
 * @property {Object<string, string>} [flags] - Flag descriptions (optional)
 */

/**
 * Validate that a module exports the required command interface.
 *
 * @param {*} mod - The required module
 * @returns {{ valid: boolean, reason?: string }}
 */
function validateCommand(mod) {
  if (!mod || typeof mod !== 'object') {
    return { valid: false, reason: 'module does not export an object' };
  }
  if (typeof mod.name !== 'string' || !mod.name) {
    return { valid: false, reason: 'missing or invalid "name" export' };
  }
  if (typeof mod.description !== 'string' || !mod.description) {
    return { valid: false, reason: 'missing or invalid "description" export' };
  }
  if (typeof mod.handler !== 'function') {
    return { valid: false, reason: 'missing or invalid "handler" export' };
  }
  return { valid: true };
}

/**
 * Load and discover command modules from a directory.
 *
 * Scans `commandsDir` for `.js` files (excluding files starting with `_`),
 * validates each module exports `{ name, description, handler }`, and builds
 * a routing Map keyed by command name.
 *
 * Malformed modules are skipped with a `console.warn` — other commands
 * continue loading. Duplicate command names warn and skip the later file.
 *
 * @param {string} commandsDir - Absolute path to the commands directory
 * @returns {{ commands: Map<string, CommandModule>, getHelp: () => string }}
 */
function loadCommands(commandsDir) {
  /** @type {Map<string, CommandModule>} */
  const commands = new Map();

  if (!commandsDir || !existsSync(commandsDir)) {
    return {
      commands,
      getHelp: () => buildHelp(commands),
    };
  }

  const files = readdirSync(commandsDir)
    .filter(f => f.endsWith('.js') && !f.startsWith('_'))
    .sort(); // deterministic order — first file wins on duplicates

  for (const file of files) {
    const filePath = path.join(commandsDir, file);

    let mod;
    try {
      mod = require(filePath);
    } catch (_err) {
      console.warn(`[registry] Skipping ${file}: failed to load — ${_err.message}`);
      continue;
    }

    const validation = validateCommand(mod);
    if (!validation.valid) {
      console.warn(`[registry] Skipping ${file}: ${validation.reason}`);
      continue;
    }

    if (commands.has(mod.name)) {
      console.warn(
        `[registry] Skipping ${file}: duplicate command name "${mod.name}"`
      );
      continue;
    }

    commands.set(mod.name, mod);
  }

  return {
    commands,
    getHelp: () => buildHelp(commands),
  };
}

/**
 * Build a formatted help string from discovered commands.
 *
 * @param {Map<string, CommandModule>} commands
 * @returns {string}
 */
function buildHelp(commands) {
  if (commands.size === 0) {
    return 'No commands available.';
  }

  const lines = ['Available commands:', ''];

  // Find the longest name for alignment
  let maxLen = 0;
  for (const name of commands.keys()) {
    if (name.length > maxLen) maxLen = name.length;
  }

  for (const [name, cmd] of commands) {
    const padding = ' '.repeat(maxLen - name.length + 2);
    lines.push(`  ${name}${padding}${cmd.description}`);
  }

  return lines.join('\n');
}

function isStageCommand(commandName) {
  return normalizeStageId(commandName) !== null;
}

async function executeCommand(commands, commandName, args, flags, projectRoot, options = {}) {
  const command = commands.get(commandName);
  if (!command) {
    return { success: false, error: `Unknown command: ${commandName}` };
  }

  try {
    if (typeof options.enforceStage === 'function' && isStageCommand(commandName)) {
      const enforcement = await options.enforceStage({
        commandName,
        args,
        flags,
        projectRoot,
        command,
      });

      if (enforcement?.allowed === false) {
        return {
          success: false,
          error: enforcement.error ?? `Stage ${commandName} is blocked.`,
          enforcement,
        };
      }
    }

    return await command.handler(args, flags, projectRoot);
  } catch (err) {
    return {
      success: false,
      error: err?.message ?? `Failed to execute ${commandName}`,
    };
  }
}

module.exports = { loadCommands, validateCommand, executeCommand };
