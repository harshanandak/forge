'use strict';

const memoryRouter = require('../memory/router');
const { stripGlobalFlags } = require('../global-flags');
const { fenceUntrusted } = require('../untrusted-content');

const usage = 'Usage: forge recall [query] [--limit N] [--all] [--json]';

/**
 * Separate the optional positional query from `--limit N` and `--json`.
 * Global flags (e.g. `-p <dir>`, `--all`) are stripped first so they never
 * corrupt the search query (kernel issue c1e090ff). `--all` is a GLOBAL boolean
 * flag, so the handler reads it from its `flags` argument (or the raw args on a
 * direct call) — not from this parsed query.
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
  const prefix = date ? `${date}  ` : '';
  const tagSuffix = entry.tags.length > 0 ? ` [${entry.tags.join(', ')}]` : '';
  // Machine/insights records are LABELED with their source so they are never mistaken for a
  // plain human note; human `remember` notes render clean.
  const marker = entry.machine && entry.sourceAgent ? `(${entry.sourceAgent}) ` : '';
  // Stored note text is UNTRUSTED (a planted memory could carry injected directives),
  // so the human/agent-facing render is provenance-fenced. The `--json` path above
  // keeps the raw note so programmatic consumers/parsers are unaffected.
  const note = fenceUntrusted(entry.note, { source: 'memory' });
  return `- ${prefix}${marker}${note}${tagSuffix}`;
}

async function handler(args, flags, projectRoot) {
  const { query, limit, json } = parseArgs(args);
  // `--all` is a GLOBAL boolean flag: in production bin/forge.js strips it from
  // args and sets flags.all; on a direct handler call it may still be in args.
  const all = Boolean(flags && flags.all) || args.includes('--all');

  const { notes, total, capped, scope } = memoryRouter.recall(projectRoot, { query, limit, all });

  if (json) {
    // Object (not a bare array) so programmatic consumers see the total and whether the
    // result was truncated (raise --limit to page further).
    return {
      success: true,
      output: `${JSON.stringify({ notes, total, capped, scope }, null, 2)}\n`,
    };
  }

  if (notes.length === 0) {
    const reason = query
      ? `No notes match "${query}".`
      : 'No notes remembered yet. Use "forge remember <note>" to add one.';
    return { success: true, output: reason };
  }

  const noun = scope === 'all' && !query ? 'stored memory record(s)' : 'remembered note(s)';
  let header;
  if (query) {
    // BM25 returns at most `limit`; when full, signal it is the TOP-N, not the whole set.
    header = capped
      ? `Top ${notes.length} note(s) matching "${query}" (raise --limit for more):`
      : `${notes.length} note(s) matching "${query}":`;
  } else if (capped) {
    // Never a bare full dump: show the newest N and the true total.
    header = `Showing ${notes.length} of ${total} ${noun} (newest first):`;
  } else {
    header = `${total} ${noun}:`;
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
    '--all': 'Include machine/insights records in the no-query listing (query already searches all)',
    '--json': 'Emit machine-readable JSON output',
  },
  handler,
};
