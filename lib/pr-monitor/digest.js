'use strict';

/**
 * PR-shepherd digest — the thin CONSUMER half of the constant monitor (epic
 * c2d398e5, 33e1bbd3). The constant watch loop is the PRODUCER: it writes the
 * per-PR NDJSON journals under `.forge/pr-monitor/<repo>-<pr>/` (the `forge
 * shepherd events` pull surface reads those same records back). Nothing, though,
 * surfaced those events to a working agent. This module is a pure READER: it
 * reads the NEW budget events across all PR journals since a persisted per-PR
 * CONSUMER cursor, renders a COMPACT capped summary, and advances the cursor —
 * the exact payload a harness hook (Claude UserPromptSubmit) injects each turn.
 *
 * The CORE (events/journal/watch/monitor) is untouched: this only READS the
 * journal via `journal.readEventsSince` and keeps its OWN `consumer.cursor`
 * (distinct from the watcher's snapshot), so consumption never disturbs
 * production. Every function is fail-open — a bad journal degrades to skipped,
 * never throws — because it feeds a hook that must never block a prompt.
 *
 * @module pr-monitor/digest
 */

const fs = require('node:fs');
const path = require('node:path');

const journalMod = require('./journal');

/**
 * The event types worth surfacing on each turn — the ACTIONABLE transitions
 * (verdict flip, a failed check, a new review thread, terminal merge/close).
 * Everything else (head pushes, green checks, degraded notices) stays in the
 * journal for `forge shepherd events` but is NOT pushed, to keep the injected
 * context tiny.
 */
const BUDGET_TYPES = Object.freeze(new Set([
  'verdict.changed', 'check.failed', 'thread.opened', 'pr.merged', 'pr.closed',
]));

const DEFAULT_CAP = 8;
const CONSUMER_CURSOR_FILE = 'consumer.cursor';

/** Absolute `.forge/pr-monitor` root for a project. */
function monitorRoot(root) {
  return path.join(root, '.forge', 'pr-monitor');
}

/** The per-PR consumer cursor path (distinct from the watcher's snapshot/pid). */
function cursorPath(dir) {
  return path.join(dir, CONSUMER_CURSOR_FILE);
}

/**
 * List absolute PR journal dirs (those containing an events.ndjson). Fail-open:
 * a missing monitor root or unreadable dir yields []. Injectable fs for tests.
 *
 * @param {string} root
 * @param {{ readdirSync?: Function, existsSync?: Function }} [deps]
 * @returns {string[]}
 */
function discoverPrDirs(root, deps = {}) {
  const readdir = deps.readdirSync || fs.readdirSync;
  const exists = deps.existsSync || fs.existsSync;
  try {
    return readdir(monitorRoot(root), { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => path.join(monitorRoot(root), e.name))
      .filter((dir) => exists(path.join(dir, 'events.ndjson')));
  } catch {
    return [];
  }
}

/**
 * Read a PR's consumer cursor (the last consumed seq). Fail-open → 0 (no cursor,
 * unreadable, or malformed all mean "start from the beginning").
 *
 * @param {string} dir
 * @param {{ readFileSync?: Function }} [deps]
 * @returns {number}
 */
function readConsumerCursor(dir, deps = {}) {
  const readFile = deps.readFileSync || fs.readFileSync;
  try {
    const obj = JSON.parse(readFile(cursorPath(dir), 'utf8'));
    const seq = Number(obj && obj.seq);
    return Number.isFinite(seq) && seq >= 0 ? seq : 0;
  } catch {
    return 0;
  }
}

/**
 * Persist a PR's consumer cursor. Fail-open: an unwritable cursor returns false
 * (next turn re-reads the same events — a duplicate nudge, never a crash).
 *
 * @param {string} dir
 * @param {number} seq
 * @param {{ writeFileSync?: Function }} [deps]
 * @returns {boolean}
 */
function writeConsumerCursor(dir, seq, deps = {}) {
  const writeFile = deps.writeFileSync || fs.writeFileSync;
  try {
    writeFile(cursorPath(dir), `${JSON.stringify({ seq: Number(seq) || 0 })}\n`);
    return true;
  } catch {
    return false;
  }
}

/**
 * A compact one-line label for a budget event. PURE. Bounded so injected context
 * stays tiny; the full record is always available via `forge shepherd events`.
 *
 * @param {object} e - a journal event.
 * @returns {string}
 */
function renderEventLine(e) {
  const pr = e.pr != null ? `#${e.pr}` : '#?';
  const d = e.data || {};
  let detail;
  switch (e.type) {
    case 'verdict.changed': detail = (e.verdict && (e.verdict.verdict || e.verdict.state)) || d.verdict || d.to || ''; break;
    case 'check.failed': detail = d.name || d.check || ''; break;
    case 'thread.opened': detail = d.author ? `by ${d.author}` : (d.path || ''); break;
    case 'pr.merged': detail = 'merged'; break;
    case 'pr.closed': detail = 'closed'; break;
    default: detail = '';
  }
  const suffix = detail ? `: ${String(detail).slice(0, 60)}` : '';
  return `- PR ${pr} ${e.type}${suffix}`;
}

/**
 * PURE: filter events to the budget types, cap the count, and render lines.
 *
 * @param {object[]} events
 * @param {{ cap?: number }} [opts]
 * @returns {{ lines: string[], total: number }}
 */
function renderDigestLines(events, { cap = DEFAULT_CAP } = {}) {
  const budget = (Array.isArray(events) ? events : []).filter((e) => e && BUDGET_TYPES.has(e.type));
  const lines = budget.map(renderEventLine);
  return { lines: lines.slice(0, cap), total: lines.length };
}

/**
 * Format the compact injected block (a header + capped lines + an overflow
 * pointer), or '' when there is nothing to surface. PURE.
 */
function formatBlock(lines, total, cap, prs) {
  if (lines.length === 0) return '';
  const on = prs.length ? ` on PR(s) ${prs.join(', ')}` : '';
  const more = total > cap ? `\n(+${total - cap} more — see \`forge shepherd events <pr> --since <seq>\`)` : '';
  return `[forge PR shepherd] ${total} new event(s)${on}:\n${lines.join('\n')}${more}`;
}

/**
 * Collect a compact digest of NEW budget events across every PR journal since the
 * per-PR consumer cursor, advancing each cursor past EVERYTHING read (budget and
 * non-budget alike, so skipped types never re-surface). Fail-open throughout.
 *
 * @param {object} args
 * @param {string} args.root - project root.
 * @param {object} [args.journal] - journal module (test injection).
 * @param {number} [args.cap] - max lines in the block.
 * @param {object} [args.fsDeps] - injectable fs for discovery + cursor I/O.
 * @returns {{ text: string, total: number, prs: string[] }}
 */
function collectDigest({ root, journal = journalMod, cap = DEFAULT_CAP, fsDeps = {} } = {}) {
  const dirs = discoverPrDirs(root, fsDeps);
  const allLines = [];
  const prs = new Set();
  for (const dir of dirs) {
    const cursor = readConsumerCursor(dir, fsDeps);
    let evs;
    try {
      evs = journal.readEventsSince(dir, cursor);
    } catch {
      evs = [];
    }
    if (!Array.isArray(evs) || evs.length === 0) continue;
    const maxSeq = evs.reduce((m, e) => Math.max(m, Number(e.seq) || 0), cursor);
    for (const e of evs) {
      if (!e || !BUDGET_TYPES.has(e.type)) continue;
      allLines.push(renderEventLine(e));
      if (e.pr != null) prs.add(String(e.pr));
    }
    writeConsumerCursor(dir, maxSeq, fsDeps);
  }
  const capped = allLines.slice(0, cap);
  return { text: formatBlock(capped, allLines.length, cap, [...prs]), total: allLines.length, prs: [...prs] };
}

module.exports = {
  BUDGET_TYPES,
  DEFAULT_CAP,
  monitorRoot,
  cursorPath,
  discoverPrDirs,
  readConsumerCursor,
  writeConsumerCursor,
  renderEventLine,
  renderDigestLines,
  formatBlock,
  collectDigest,
};
