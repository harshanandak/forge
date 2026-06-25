'use strict';

const memoryStore = require('../memory-store');

const usage = 'Usage: forge recall [query] [--limit N] [--json]';

/**
 * Separate the optional positional query from `--limit N` and `--json`.
 *
 * @param {string[]} args - Raw command arguments.
 * @returns {{ query: string, limit: (number|undefined), json: boolean }}
 */
function parseArgs(args) {
  const words = [];
  let limit;
  let json = false;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--json') {
      json = true;
    } else if (arg === '--limit') {
      const value = Number(args[index + 1]);
      if (Number.isInteger(value) && value > 0) {
        limit = value;
        index += 1;
      }
    } else if (arg.startsWith('--limit=')) {
      const value = Number(arg.slice('--limit='.length));
      if (Number.isInteger(value) && value > 0) {
        limit = value;
      }
    } else {
      words.push(arg);
    }
  }

  return { query: words.join(' ').trim(), limit, json };
}

function formatEntry(entry) {
  const date = entry.timestamp ? entry.timestamp.slice(0, 10) : '';
  const tagSuffix = entry.tags.length > 0 ? ` [${entry.tags.join(', ')}]` : '';
  const prefix = date ? `${date}  ` : '';
  return `- ${prefix}${entry.note}${tagSuffix}`;
}

async function handler(args, _flags, projectRoot) {
  const { query, limit, json } = parseArgs(args);

  let entries = query
    ? memoryStore.search(projectRoot, query)
    : memoryStore.list(projectRoot);

  if (limit !== undefined) {
    entries = entries.slice(0, limit);
  }

  if (json) {
    return { success: true, output: `${JSON.stringify(entries, null, 2)}\n` };
  }

  if (entries.length === 0) {
    const reason = query
      ? `No notes match "${query}".`
      : 'No notes remembered yet. Use "forge remember <note>" to add one.';
    return { success: true, output: reason };
  }

  const header = query
    ? `${entries.length} note(s) matching "${query}":`
    : `${entries.length} remembered note(s):`;
  const lines = entries.map(formatEntry);
  return {
    success: true,
    output: [header, ...lines].join('\n'),
  };
}

module.exports = {
  name: 'recall',
  description: 'Retrieve project-memory notes from the file-backed store',
  usage,
  flags: {
    '--limit': 'Cap the number of notes returned',
    '--json': 'Emit machine-readable JSON output',
  },
  handler,
};
