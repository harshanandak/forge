'use strict';

/**
 * Forge Docs Command
 *
 * Display documentation topics from the forge docs/ directory.
 * Extracted from bin/forge.js — registry-compliant module.
 *
 * @module commands/docs
 */

const path = require('node:path');
const { listTopics, getTopicContent } = require('../docs-command');

/**
 * Handler for the docs command.
 * @param {string[]} args - Positional arguments (first element is topic name)
 * @param {object} _flags - CLI flags (unused)
 * @param {string} _projectRoot - Project root path (unused — docs come from package)
 * @returns {Promise<{ success: boolean, error?: string }>}
 */
async function handler(args, _flags, _projectRoot) {
  const packageDir = path.resolve(__dirname, '..', '..');
  const topic = args[0];

  if (!topic) {
    console.log('');
    console.log('  Available documentation topics:');
    console.log('');
    for (const t of listTopics()) {
      console.log(`    - ${t}`);
    }
    console.log('');
    console.log('  Usage: forge docs <topic>');
    console.log('');
    return { success: true };
  }

  const result = getTopicContent(topic, packageDir);
  if (result.error) {
    return { success: false, error: result.error };
  }

  console.log(result.content);
  return { success: true };
}

module.exports = {
  name: 'docs',
  description: 'Display forge documentation topics',
  usage: 'forge docs [<topic>]',
  handler,
};
