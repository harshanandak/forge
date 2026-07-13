'use strict';

/**
 * @module memory-digest
 *
 * Builds the BOUNDED, token-capped memory digest that Forge PUSHES to an agent at
 * session start (the `memory-inject` context intent in the hook contract). This is
 * the missing "push" half of Forge memory: today an agent only sees remembered
 * notes if it TYPES `forge recall`, so memory is effectively orphaned.
 *
 * Two layers, kept separate for testability:
 *   - collectDigestData(projectRoot, opts) — BEST-EFFORT fetch (each source wrapped;
 *     a failure yields [] for that source). Fetchers are injectable so tests never
 *     touch a real DB. Async (issue reads are async).
 *   - buildMemoryDigest(data, { budgetTokens }) — PURE formatting + token-capping via
 *     orientation's applyBudget. Empty data → empty digest (the caller then injects
 *     nothing). Never exceeds the budget.
 *
 * The digest is a small NUDGE, not a manual: the default budget is deliberately tiny.
 */

const { applyBudget, buildSection, estimateTokens } = require('./orientation');
const { fenceUntrusted } = require('./untrusted-content');

const DEFAULT_DIGEST_BUDGET_TOKENS = 400;
const DEFAULT_NOTE_LIMIT = 5;
const DEFAULT_ISSUE_LIMIT = 5;
const DIGEST_HEADER = 'Forge memory (auto-injected at session start):';

/** Run an async producer, returning `fallback` on any throw/rejection (never propagates). */
async function safe(producer, fallback) {
  try {
    const value = await producer();
    return value === undefined || value === null ? fallback : value;
  } catch {
    return fallback;
  }
}

/** Default note fetch: newest remembered notes via the kernel-backed memory router. */
function defaultFetchNotes(projectRoot, opts = {}) {
  const memoryRouter = require('./memory/router');
  const result = memoryRouter.recall(projectRoot, { limit: opts.noteLimit || DEFAULT_NOTE_LIMIT });
  return Array.isArray(result && result.notes) ? result.notes : [];
}

/** Pull an issues array out of a runIssueOperation result, defensively (shape varies). */
function extractIssues(result) {
  let payload = result && result.data;
  if (!payload && result && typeof result.output === 'string') {
    try { payload = JSON.parse(result.output); } catch { return []; }
  }
  if (Array.isArray(payload)) return payload;
  if (payload && Array.isArray(payload.issues)) return payload.issues;
  return [];
}

/**
 * Default issue fetch for a status kind ('ready' | 'in_progress'). Best-effort.
 * The CLI `--limit` is NOT trusted (`forge issue ready --json --limit 2` empirically
 * returns the whole set), so the result is HARD-CAPPED with `.slice(0, limit)` — else
 * the digest dumps every ready issue and applyBudget truncates the claimed tail away.
 * `opts.runIssueOperation` is injectable so tests exercise the cap deterministically.
 */
async function defaultFetchIssues(projectRoot, kind, opts = {}) {
  const runIssueOperation = opts.runIssueOperation || require('./forge-issues').runIssueOperation;
  const limit = opts.issueLimit || DEFAULT_ISSUE_LIMIT;
  const [operation, args] = kind === 'ready'
    ? ['ready', ['--json', '--limit', String(limit)]]
    : ['list', ['--status', 'in_progress', '--json', '--limit', String(limit)]];
  const result = await runIssueOperation(operation, args, projectRoot);
  return extractIssues(result).slice(0, limit);
}

/**
 * Best-effort gather of the digest inputs. Each source degrades to [] independently.
 * @param {string} projectRoot
 * @param {object} [opts] - { fetchNotes, fetchIssues, noteLimit, issueLimit }
 * @returns {Promise<{ notes: object[], ready: object[], claimed: object[] }>}
 */
async function collectDigestData(projectRoot, opts = {}) {
  const fetchNotes = opts.fetchNotes || defaultFetchNotes;
  const fetchIssues = opts.fetchIssues || defaultFetchIssues;
  const notes = await safe(() => fetchNotes(projectRoot, opts), []);
  const ready = await safe(() => fetchIssues(projectRoot, 'ready', opts), []);
  const claimed = await safe(() => fetchIssues(projectRoot, 'in_progress', opts), []);
  return {
    notes: Array.isArray(notes) ? notes : [],
    ready: Array.isArray(ready) ? ready : [],
    claimed: Array.isArray(claimed) ? claimed : [],
  };
}

/** `- [date ]note` for a recall note. */
function formatNoteLine(note) {
  const date = typeof note.timestamp === 'string' && note.timestamp ? `${note.timestamp.slice(0, 10)} ` : '';
  return `- ${date}${note.note}`;
}

/** `- [label] title` for an issue row (title/id defensively resolved). */
function formatIssueLine(label, issue) {
  const title = (issue && (issue.title || issue.id)) || 'untitled';
  return `- [${label}] ${title}`;
}

/** Build the notes section, or null when there are no notes. */
function notesSection(notes) {
  if (!notes.length) return null;
  return buildSection({
    id: 'digest_notes',
    title: 'Remembered notes',
    content: notes.map(formatNoteLine).join('\n'),
    priority: 10,
    preserve: false,
    // Untrusted: a planted note is DATA, not instructions. Fenced after truncation.
    untrustedSource: 'memory',
  });
}

/**
 * Build the open-issues section, or null when both are empty. CLAIMED lines come FIRST
 * so that when applyBudget truncates the tail, it is the (less critical) ready list that
 * is cut — the agent's own in-progress work must never be the vanished tail.
 */
function issuesSection(ready, claimed) {
  const lines = [
    ...claimed.map(issue => formatIssueLine('claimed', issue)),
    ...ready.map(issue => formatIssueLine('ready', issue)),
  ];
  if (!lines.length) return null;
  return buildSection({
    id: 'digest_issues',
    title: 'Open issues',
    content: lines.join('\n'),
    priority: 20,
    preserve: false,
    // Untrusted: an issue title is attacker-influenceable. Fenced after truncation.
    untrustedSource: 'issue-titles',
  });
}

/**
 * Assemble the bounded digest text. PURE. Never exceeds `budgetTokens` (delegated to
 * applyBudget). Empty inputs → { text: '', empty: true } so the caller injects nothing.
 *
 * @param {{ notes?: object[], ready?: object[], claimed?: object[] }} [data]
 * @param {object} [options] - { budgetTokens }
 * @returns {{ text: string, empty: boolean, tokens: number }}
 */
function buildMemoryDigest(data = {}, options = {}) {
  const notes = Array.isArray(data.notes) ? data.notes : [];
  const ready = Array.isArray(data.ready) ? data.ready : [];
  const claimed = Array.isArray(data.claimed) ? data.claimed : [];

  const sections = [notesSection(notes), issuesSection(ready, claimed)].filter(Boolean);
  if (!sections.length) return { text: '', empty: true, tokens: 0 };

  const budgetTokens = options.budgetTokens || DEFAULT_DIGEST_BUDGET_TOKENS;
  const budgeted = applyBudget(sections, budgetTokens);
  const body = budgeted.sections
    .filter(section => section.content)
    // Fence AFTER applyBudget truncates, so the ⟦END UNTRUSTED⟧ close marker always
    // survives (fencing before truncation would let the budget cut the terminator and
    // leave an unclosed fence a payload could exploit). Provenance-labelled per section.
    .map(section => `${section.title}:\n${fenceUntrusted(section.content, { source: section.untrustedSource })}`)
    .join('\n\n');
  if (!body) return { text: '', empty: true, tokens: 0 };

  const text = `${DIGEST_HEADER}\n\n${body}`;
  return { text, empty: false, tokens: estimateTokens(text) };
}

module.exports = {
  DEFAULT_DIGEST_BUDGET_TOKENS,
  DIGEST_HEADER,
  buildMemoryDigest,
  collectDigestData,
  extractIssues,
  // exported for focused reuse / tests
  defaultFetchNotes,
  defaultFetchIssues,
};
