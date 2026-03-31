'use strict';

/**
 * Forge Reinstall Command
 *
 * Hard-reset all forge files and re-run default setup.
 * Extracted from bin/forge.js — registry-compliant module.
 *
 * @module commands/reinstall
 */

const { reinstall } = require('../reset');
const setupCommand = require('./setup');

/**
 * Handler for the reinstall command.
 * @param {string[]} args - Positional arguments (may contain --force)
 * @param {object} flags - CLI flags
 * @param {string} projectRoot - Project root path
 * @returns {Promise<{ success: boolean, error?: string }>}
 */
async function handler(args, flags, projectRoot) {
  const isForce = args.includes('--force') || flags.force;

  try {
    const result = await reinstall(projectRoot, {
      force: isForce,
      setupFn: async (root) => {
        // Re-run default setup (claude agent, skip external prompts)
        const agents = ['claude'];
        await setupCommand.handleSetupCommand(agents, { skipExternal: true, yes: true, projectRoot: root });
        return { agents };
      },
    });

    console.log('');
    console.log('  Reinstall complete.');
    for (const f of result.resetResult.removed) {
      console.log(`    Removed: ${f}`);
    }
    if (result.setupResult) {
      console.log('');
      console.log('  Setup re-run automatically.');
    }
    console.log('');
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

module.exports = {
  name: 'reinstall',
  description: 'Hard-reset all forge files and re-run default setup',
  usage: 'forge reinstall --force',
  flags: {
    '--force': 'Required safety flag to confirm destructive operation',
  },
  handler,
};
