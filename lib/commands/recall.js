'use strict';

const memoryRouter = require('../memory/router');
const projectMemory = require('../project-memory');
const { types: { isProxy } } = require('node:util');
const { stripGlobalFlags } = require('../global-flags');
const { fenceUntrusted } = require('../untrusted-content');
const { applyBudget, buildSection, estimateTokens } = require('../orientation');
const { memoryTrustStatus } = require('../memory-recall');

const usage = 'Usage: forge recall [query] [--kind <type>] [--limit N] [--all] [--json]';
const RECALL_CONTENT_BUDGET = 1100;

// Reserved tag prefix that `remember --kind` writes (kernel issue 8cc1db4d). A `--kind`
// filter keeps only notes carrying this tag; the prefix is stripped when surfacing the
// derived `type` field so a note's user tags stay clean. The filter FLAG is `--kind` (NOT
// `--type`): `--type` is a reserved GLOBAL flag hard-validated to workflow classifications.
const TYPE_TAG_PREFIX = 'type:';

// Kind filtering is pushed into the Kernel read so limits and capped metadata stay truthful.
// the small default page — otherwise the type match could fall outside the default limit.

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

function privateCommandOption(options, field) {
  if (!options || typeof options !== 'object' || isProxy(options)) return undefined;
  let descriptor;
  try { descriptor = Object.getOwnPropertyDescriptor(options, field); } catch { return undefined; }
  return descriptor && Object.hasOwn(descriptor, 'value') ? descriptor.value : undefined;
}

function formatEntry(entry) {
  const date = entry.timestamp ? entry.timestamp.slice(0, 10) : '';
  const trust = memoryTrustStatus({
    tags: entry.tags,
    sourceAgent: entry.sourceAgent,
    value: entry.machine ? {} : entry.note,
  });
  const sourceAgent = entry.sourceAgent || 'unknown';
  const label = `[source=${sourceAgent} trust=${trust} updated=${date || 'unknown'}] `;
  // The reserved `type:` tag renders as a leading `(kind)` marker, not as a raw tag, so the
  // displayed tags stay the user's own labels.
  const type = typeOf(entry);
  const userTags = (entry.tags || []).filter(
    t => !t.startsWith(TYPE_TAG_PREFIX) && !t.startsWith('trust:')
  );
  const tagSuffix = userTags.length > 0 ? ` [${userTags.join(', ')}]` : '';
  const typeMarker = type ? `(${type}) ` : '';
  // Machine/insights records are LABELED with their source so they are never mistaken for a
  // plain human note; human `remember` notes render clean.
  const marker = entry.machine && entry.sourceAgent ? `(${entry.sourceAgent}) ` : '';
  // Stored note text is untrusted. Fence it after budgeting so a truncation cannot
  // sever the close marker; the `--json` path above keeps the raw note unchanged.
  const note = String(entry.note == null ? '' : entry.note);
  return `- ${label}${marker}${typeMarker}${note}${tagSuffix}`;
}

function createUsageRecorder(projectRoot, recallStore, commandOpts) {
  const invocationId = privateCommandOption(commandOpts, 'invocationId');
  const usageStore = privateCommandOption(commandOpts, 'usageStore');
  const onUsageEvidence = privateCommandOption(commandOpts, 'onUsageEvidence');
  const invocationStartedAt = privateCommandOption(commandOpts, 'invocationStartedAt')
    || privateCommandOption(commandOpts, 'now')
    || new Date().toISOString();
  const evidenceCallback = typeof onUsageEvidence === 'function' && !isProxy(onUsageEvidence)
    ? onUsageEvidence
    : undefined;
  return selected => {
    const observation = projectMemory.recordRecallUsage(projectRoot, selected, {
      invocationId,
      usageStore: usageStore || recallStore,
      invocationStartedAt,
    });
    if (evidenceCallback) {
      // Observability is deliberately aggregate-only: callers never receive query, note,
      // path, secret, or raw durable identifiers.
      try { evidenceCallback(observation); } catch { /* advisory test seam */ }
    }
  };
}

function buildRecallSections(notes) {
  return notes
    .map((entry, index) => {
      const content = formatEntry(entry);
      if (estimateTokens(content) > RECALL_CONTENT_BUDGET) return null;
      const trust = memoryTrustStatus({
        tags: entry.tags,
        sourceAgent: entry.sourceAgent,
        value: entry.machine ? {} : entry.note,
      });
      return buildSection({
        id: `recall_${index}`,
        title: '',
        content,
        priority: index,
        preserve: false,
        data: { trust, memoryId: entry.id },
      });
    })
    .filter(Boolean);
}

function humanRecallHeader(query, capped, rendered, noteCount, total, scope) {
  const noun = scope === 'all' && !query ? 'stored memory record(s)' : 'remembered note(s)';
  if (query) {
    return capped || rendered < noteCount
      ? `Top ${rendered} note(s) matching "${query}" (raise --limit for more):`
      : `${rendered} note(s) matching "${query}":`;
  }
  if (capped || rendered < noteCount) {
    return `Showing ${rendered} of ${total} ${noun} (newest first):`;
  }
  return `${rendered} ${noun}:`;
}

function renderHumanRecall(notes, result, recordUsage) {
  const sections = buildRecallSections(notes);
  const budgeted = applyBudget(sections, RECALL_CONTENT_BUDGET).sections
    .filter(section => section.content);
  for (const section of budgeted) {
    section.content = fenceUntrusted(section.content, { source: 'memory' });
  }
  recordUsage(budgeted.map(section => ({ id: section.data.memoryId })));
  const rendered = budgeted.length;
  const header = humanRecallHeader(result.query, result.capped, rendered, notes.length, result.total, result.scope);
  const confirmed = budgeted.filter(section => section.data.trust === 'confirmed');
  const suggested = budgeted.filter(section => section.data.trust === 'suggested');
  const groups = [
    confirmed.length ? ['Confirmed memory', confirmed] : null,
    suggested.length ? ['Suggested memory — verify before relying', suggested] : null,
  ].filter(Boolean);
  const body = groups.flatMap(([title, entries]) => [
    title,
    ...entries.map(entry => entry.content),
  ]);
  return { success: true, output: [header, ...body].join('\n') };
}

function emptyRecall(query) {
  const reason = query
    ? `No notes match "${query}".`
    : 'No notes remembered yet. Use "forge remember <note>" to add one.';
  return { success: true, output: reason };
}

async function handler(args, flags, projectRoot, commandOpts = {}) {
  const { query, limit, type, json } = parseArgs(args);
  // `--all` is a GLOBAL boolean flag: in production bin/forge.js strips it from
  // args and sets flags.all; on a direct handler call it may still be in args.
  const all = Boolean(flags && flags.all) || args.includes('--all');

  // A `--type` filter scans a generous recent window, then keeps only matching notes — the
  // read stays entirely in the existing store (no schema change). `--limit` is re-applied
  // AFTER filtering so it caps the typed result set, not the pre-filter scan.
  // Resolve once for the complete recall: selection, count, and advisory evidence share
  // one cached driver/connection rather than each opening or migrating independently.
  const recallStore = projectMemory.resolveStore(projectRoot);
  const result = memoryRouter.recall(projectRoot, { query, limit, all, kind: type }, { store: recallStore });
  const notes = result.notes.map(withType);
  const recordUsage = createUsageRecorder(projectRoot, recallStore, commandOpts);

  if (json) {
    // Object (not a bare array) so programmatic consumers see the total and whether the
    // result was truncated (raise --limit to page further).
    recordUsage(notes);
    return {
      success: true,
      output: `${JSON.stringify({ notes, total: result.total, capped: result.capped, scope: result.scope }, null, 2)}\n`,
    };
  }

  if (notes.length === 0) {
    return emptyRecall(query);
  }

  return renderHumanRecall(notes, result, recordUsage);
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
