'use strict';

const memoryRouter = require('../memory/router');
const { stripGlobalFlags } = require('../global-flags');
const { fenceUntrusted } = require('../untrusted-content');

const usage = 'Usage: forge recall [query] [--kind <type>] [--limit N] [--all] [--json]';

// Reserved tag prefix that `remember --kind` writes (kernel issue 8cc1db4d). A `--kind`
// filter keeps only notes carrying this tag; the prefix is stripped when surfacing the
// derived `type` field so a note's user tags stay clean. The filter FLAG is `--kind` (NOT
// `--type`): `--type` is a reserved GLOBAL flag hard-validated to workflow classifications.
const TYPE_TAG_PREFIX = 'type:';

// When a `--kind` filter is active the tag filter runs in the command layer (the store is
// not reimplemented), so scan a generous window of recent notes before filtering rather than
// the small default page — otherwise the type match could fall outside the default limit.
const TYPE_FILTER_SCAN = 1000;

/**
 * Separate the optional positional query from `--kind <type>`, `--limit N`, and `--json`.
 * Global flags (e.g. `-p <dir>`, `--all`) are stripped first so they never corrupt the
 * search query (kernel issue c1e090ff). `--all` is a GLOBAL boolean flag, so the handler
 * reads it from its `flags` argument (or the raw args on a direct call) — not from here.
 * `--kind` is NOT a global flag, so it survives the strip and is parsed here.
 *
 * @param {string[]} rawArgs - Raw command arguments.
 * @returns {{ query: string, limit: (number|undefined), type: (string|undefined), json: boolean }}
 */
function parseArgs(rawArgs) {
  const args = stripGlobalFlags(rawArgs);
  const words = [];
  let limit;
  let type;
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
    } else if (arg === '--kind') {
      const value = args[index + 1];
      if (value && !value.startsWith('--')) {
        type = value.trim();
        index += 1;
      }
    } else if (arg.startsWith('--kind=')) {
      type = arg.slice('--kind='.length).trim();
    } else {
      words.push(arg);
    }
  }

  return { query: words.join(' ').trim(), limit, type, json };
}

// Derive a note's `type` from its reserved `type:` tag (undefined when untyped), so any
// surface — JSON and text — can show and filter by kind without exposing the tag encoding.
function typeOf(entry) {
  const tag = (entry.tags || []).find(t => t.startsWith(TYPE_TAG_PREFIX));
  return tag ? tag.slice(TYPE_TAG_PREFIX.length) : undefined;
}

function withType(entry) {
  const type = typeOf(entry);
  return type ? { ...entry, type } : entry;
}

function formatEntry(entry) {
  const date = entry.timestamp ? entry.timestamp.slice(0, 10) : '';
  const prefix = date ? `${date}  ` : '';
  // The reserved `type:` tag renders as a leading `(kind)` marker, not as a raw tag, so the
  // displayed tags stay the user's own labels.
  const type = typeOf(entry);
  const userTags = (entry.tags || []).filter(t => !t.startsWith(TYPE_TAG_PREFIX));
  const tagSuffix = userTags.length > 0 ? ` [${userTags.join(', ')}]` : '';
  const typeMarker = type ? `(${type}) ` : '';
  // Machine/insights records are LABELED with their source so they are never mistaken for a
  // plain human note; human `remember` notes render clean.
  const marker = entry.machine && entry.sourceAgent ? `(${entry.sourceAgent}) ` : '';
  // Stored note text is UNTRUSTED (a planted memory could carry injected directives),
  // so the human/agent-facing render is provenance-fenced. The `--json` path above
  // keeps the raw note so programmatic consumers/parsers are unaffected.
  const note = fenceUntrusted(entry.note, { source: 'memory' });
  return `- ${prefix}${marker}${typeMarker}${note}${tagSuffix}`;
}

async function handler(args, flags, projectRoot) {
  const { query, limit, type, json } = parseArgs(args);
  // `--all` is a GLOBAL boolean flag: in production bin/forge.js strips it from
  // args and sets flags.all; on a direct handler call it may still be in args.
  const all = Boolean(flags && flags.all) || args.includes('--all');

  // A `--type` filter scans a generous recent window, then keeps only matching notes — the
  // read stays entirely in the existing store (no schema change). `--limit` is re-applied
  // AFTER filtering so it caps the typed result set, not the pre-filter scan.
  const recallLimit = type ? Math.max(limit ?? 0, TYPE_FILTER_SCAN) : limit;
  const result = memoryRouter.recall(projectRoot, { query, limit: recallLimit, all });
  let notes = result.notes.map(withType);
  let { total, capped } = result;
  const { scope } = result;
  if (type) {
    notes = notes.filter(entry => entry.type === type);
    total = notes.length;
    if (limit && notes.length > limit) {
      notes = notes.slice(0, limit);
      capped = true;
    } else {
      capped = false;
    }
  }

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
    '--kind': 'Filter to notes of a type (decision|bugfix|gotcha|...); --type is reserved',
    '--limit': 'Cap the number of notes returned',
    '--all': 'Include machine/insights records in the no-query listing (query already searches all)',
    '--json': 'Emit machine-readable JSON output',
  },
  handler,
};
