'use strict';

const memoryRouter = require('../memory/router');
const { stripGlobalFlags } = require('../global-flags');

const usage = 'Usage: forge recall [query] [--limit N] [--json]';

/**
 * Separate the optional positional query from `--limit N` and `--json`.
 * Global flags (e.g. `-p <dir>`) are stripped first so they never corrupt
 * the search query (kernel issue c1e090ff).
 *
 * @param {string[]} rawArgs - Raw command arguments.
 * @returns {{ query: string, limit: (number|undefined), json: boolean }}
 */
function parseArgs(rawArgs) {
  const args = stripGlobalFlags(rawArgs);
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

  const { notes, total, capped } = memoryRouter.recall(projectRoot, { query, limit });

  if (json) {
    return { success: true, output: `${JSON.stringify(notes, null, 2)}\n` };
  }

  if (notes.length === 0) {
    const reason = query
      ? `No notes match "${query}".`
      : 'No notes remembered yet. Use "forge remember <note>" to add one.';
    return { success: true, output: reason };
  }

  let header;
  if (query) {
    header = `${notes.length} note(s) matching "${query}":`;
  } else if (capped) {
    // Never a bare full dump: show the newest N and the true total.
    header = `Showing ${notes.length} of ${total} remembered note(s) (newest first):`;
  } else {
    header = `${total} remembered note(s):`;
  }
  const lines = notes.map(formatEntry);
  return {
    success: true,
    output: [header, ...lines].join('\n'),
  };
}

module.exports = {
  name: 'recall',
  description: 'Retrieve project-memory notes from the kernel-backed memory store',
  usage,
  flags: {
    '--limit': 'Cap the number of notes returned',
    '--json': 'Emit machine-readable JSON output',
  },
  handler,
};
