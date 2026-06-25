'use strict';

const memoryStore = require('../memory-store');

const usage = 'Usage: forge remember <note> [--tag <label>]... [--json]';

/**
 * Split positional note words from `--tag <label>` pairs and the `--json` flag.
 *
 * @param {string[]} args - Raw command arguments.
 * @returns {{ note: string, tags: string[], json: boolean }}
 */
function parseArgs(args) {
  const words = [];
  const tags = [];
  let json = false;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--json') {
      json = true;
    } else if (arg === '--tag') {
      const value = args[index + 1];
      if (value && !value.startsWith('--')) {
        tags.push(value);
        index += 1;
      }
    } else if (arg.startsWith('--tag=')) {
      tags.push(arg.slice('--tag='.length));
    } else {
      words.push(arg);
    }
  }

  return { note: words.join(' ').trim(), tags, json };
}

async function handler(args, _flags, projectRoot) {
  const { note, tags, json } = parseArgs(args);

  if (!note) {
    return {
      success: false,
      error: `No note provided.\n${usage}`,
    };
  }

  const entry = memoryStore.append(projectRoot, note, { tags });

  if (json) {
    return { success: true, output: `${JSON.stringify(entry, null, 2)}\n` };
  }

  const tagSuffix = entry.tags.length > 0 ? ` [${entry.tags.join(', ')}]` : '';
  return {
    success: true,
    output: `Remembered: ${entry.note}${tagSuffix}`,
  };
}

module.exports = {
  name: 'remember',
  description: 'Persist a project-memory note to a file-backed store',
  usage,
  flags: {
    '--tag': 'Attach a search label (repeatable)',
    '--json': 'Emit machine-readable JSON output',
  },
  handler,
};
