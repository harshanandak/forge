'use strict';

/**
 * Forge Reset Command
 *
 * Remove forge configuration (soft) or all forge-managed files (hard).
 * Extracted from bin/forge.js — registry-compliant module.
 *
 * @module commands/reset
 */

const { resetSoft, resetHard } = require('../reset');

/**
 * Handler for the reset command.
 * @param {string[]} args - Positional arguments (may contain --soft, --hard, --force)
 * @param {object} flags - CLI flags
 * @param {string} projectRoot - Project root path
 * @returns {Promise<{ success: boolean, error?: string }>}
 */
async function handler(args, flags, projectRoot) {
  const isSoft = args.includes('--soft') || flags.soft;
  const isHard = args.includes('--hard') || flags.hard;
  const isForce = args.includes('--force') || flags.force;

  if (isSoft && isHard) {
    return { success: false, error: '--soft and --hard are mutually exclusive. Specify one.' };
  }

  if (!isSoft && !isHard) {
    console.log('');
    console.log('  Forge Reset');
    console.log('');
    console.log('  Usage:');
    console.log('    forge reset --soft --force    Remove .forge/ config only');
    console.log('    forge reset --hard --force    Remove ALL forge-managed files');
    console.log('');
    console.log('  Flags:');
    console.log('    --soft     Remove only .forge/ directory (preserves commands, rules, agents)');
    console.log('    --hard     Remove all forge files (preserves user-created files)');
    console.log('    --force    Required safety flag to confirm destructive operation');
    console.log('');
    return { success: true };
  }

  if (isSoft) {
    try {
      const result = resetSoft(projectRoot, { force: isForce });
      console.log('');
      console.log('  Soft reset complete.');
      for (const f of result.removed) {
        console.log(`    Removed: ${f}`);
      }
      console.log('');
      return { success: true };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  // isHard
  try {
    const result = resetHard(projectRoot, { force: isForce });
    console.log('');
    console.log('  Hard reset complete.');
    for (const f of result.removed) {
      console.log(`    Removed: ${f}`);
    }
    console.log('');
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

module.exports = {
  name: 'reset',
  description: 'Remove forge configuration (--soft) or all forge files (--hard)',
  usage: 'forge reset --soft|--hard --force',
  flags: {
    '--soft': 'Remove only .forge/ directory (preserves commands, rules, agents)',
    '--hard': 'Remove all forge-managed files (preserves user-created files)',
    '--force': 'Required safety flag to confirm destructive operation',
  },
  handler,
};
