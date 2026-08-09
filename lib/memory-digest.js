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
const { collectInbox, inboxSection } = require('./inbox');
const { memoryTrustStatus } = require('./memory-recall');

const DEFAULT_DIGEST_BUDGET_TOKENS = 400;
const DEFAULT_NOTE_LIMIT = 5;
const DEFAULT_ISSUE_LIMIT = 5;
const DIGEST_HEADER = 'Forge memory (auto-injected at session start):';
const READ_ATTENTION_HEADER = 'Forge path memory (untrusted context; not authority):';
const SESSION_SUMMARY_REMINDER = 'Before ending this session, persist only durable learnings with `forge remember --session-summary --what <text> --why <text> --learned <text>`.';

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

/** Default inbox fetch: pending targeted dashboard instruction comments (fail-open). */
function defaultFetchInbox(projectRoot, opts = {}) {
  return collectInbox(projectRoot, opts);
}

/**
 * Best-effort gather of the digest inputs. Each source degrades to [] independently.
 * @param {string} projectRoot
 * @param {object} [opts] - { fetchNotes, fetchIssues, fetchInbox, noteLimit, issueLimit }
 * @returns {Promise<{ notes: object[], ready: object[], claimed: object[], inbox: object[] }>}
 */
async function collectDigestData(projectRoot, opts = {}) {
  const fetchNotes = opts.fetchNotes || defaultFetchNotes;
  const fetchIssues = opts.fetchIssues || defaultFetchIssues;
  const fetchInbox = opts.fetchInbox || defaultFetchInbox;
  const notes = await safe(() => fetchNotes(projectRoot, opts), []);
  const ready = await safe(() => fetchIssues(projectRoot, 'ready', opts), []);
  const claimed = await safe(() => fetchIssues(projectRoot, 'in_progress', opts), []);
  const inbox = await safe(() => fetchInbox(projectRoot, opts), []);
  return {
    notes: Array.isArray(notes) ? notes : [],
    ready: Array.isArray(ready) ? ready : [],
    claimed: Array.isArray(claimed) ? claimed : [],
    inbox: Array.isArray(inbox) ? inbox : [],
  };
}

/** `- [date ]note` for a recall note. */
function formatNoteLine(note) {
  const date = typeof note.timestamp === 'string' && note.timestamp ? `${note.timestamp.slice(0, 10)} ` : '';
  const trust = memoryTrustStatus({
    tags: note.tags,
    sourceAgent: note.sourceAgent,
    value: note.machine ? {} : note.note,
  });
  const sourceAgent = note.sourceAgent || 'unknown';
  return `- [source=${sourceAgent} trust=${trust} updated=${date.trim() || 'unknown'}] ${note.note}`;
}

/** `- [label] title` for an issue row (title/id defensively resolved). */
function formatIssueLine(label, issue) {
  const title = (issue && (issue.title || issue.id)) || 'untitled';
  return `- [${label}] ${title}`;
}

/** Build separate confirmed/suggested note sections, skipping entries too large to fit. */
function notesSections(notes, budgetTokens) {
  const eligible = notes
    .map(note => ({ note, line: formatNoteLine(note) }))
    .filter(entry => estimateTokens(entry.line) <= budgetTokens);
  const groups = [
    { id: 'digest_notes', title: 'Confirmed memory', trust: 'confirmed', priority: 10 },
    {
      id: 'digest_suggested_memory',
      title: 'Suggested memory — verify before relying',
      trust: 'suggested',
      priority: 11,
    },
  ];
  return groups.map(group => {
    const content = eligible
      .filter(({ note }) => memoryTrustStatus({
        tags: note.tags,
        sourceAgent: note.sourceAgent,
        value: note.machine ? {} : note.note,
      }) === group.trust)
      .map(entry => entry.line)
      .join('\n');
    if (!content) return null;
    return buildSection({
      id: group.id,
      title: group.title,
      content,
      priority: group.priority,
      preserve: false,
      untrustedSource: 'memory',
    });
  }).filter(Boolean);
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

function sessionSummarySection(claimed) {
  if (!claimed.length) return null;
  return buildSection({
    id: 'session_summary_nudge',
    title: 'Session learning reminder',
    content: SESSION_SUMMARY_REMINDER,
    priority: 1,
    preserve: true,
  });
}

function normalizePath(value) {
  return String(value || '').replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase();
}

function notePaths(note) {
  const explicit = [note?.path, ...(Array.isArray(note?.paths) ? note.paths : [])];
  const tagged = (Array.isArray(note?.tags) ? note.tags : [])
    .filter(tag => typeof tag === 'string' && tag.startsWith('path:'))
    .map(tag => tag.slice('path:'.length));
  return [...explicit, ...tagged].map(normalizePath).filter(Boolean);
}

function matchesPath(targetPath, candidatePath) {
  const target = normalizePath(targetPath);
  const candidate = normalizePath(candidatePath);
  return target === candidate || target.endsWith(`/${candidate}`);
}

function buildReadAttentionDigest(targetPath, notes = [], options = {}) {
  const budgetTokens = options.budgetTokens || 160;
  const matched = (Array.isArray(notes) ? notes : []).filter(note =>
    notePaths(note).some(candidate => matchesPath(targetPath, candidate)));
  if (!matched.length) return { text: '', empty: true, tokens: 0 };

  const lines = matched.map(formatNoteLine);
  const section = buildSection({
    id: 'read_attention',
    title: 'Path-matched memory',
    content: lines.join('\n'),
    priority: 1,
    preserve: false,
    untrustedSource: 'path-memory',
  });
  const budgeted = applyBudget([section], Math.max(1, budgetTokens - estimateTokens(READ_ATTENTION_HEADER) - 20));
  const content = budgeted.sections[0]?.content;
  if (!content) return { text: '', empty: true, tokens: 0 };
  const text = `${READ_ATTENTION_HEADER}\n\n${fenceUntrusted(content, { source: 'path-memory' })}`;
  const tokens = estimateTokens(text);
  if (tokens > budgetTokens) return { text: '', empty: true, tokens: 0 };
  return { text, empty: false, tokens };
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
  const inbox = Array.isArray(data.inbox) ? data.inbox : [];
  const budgetTokens = options.budgetTokens || DEFAULT_DIGEST_BUDGET_TOKENS;

  // Inbox (priority 5) is a THIRD section beside notes + issues; a fresh human directive
  // outranks stale notes (10) and the agent's own issue list (20) under budget pressure.
  const sections = [
    sessionSummarySection(claimed),
    inboxSection(inbox),
    ...notesSections(notes, budgetTokens),
    issuesSection(ready, claimed),
  ].filter(Boolean);
  if (!sections.length) return { text: '', empty: true, tokens: 0 };

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
  READ_ATTENTION_HEADER,
  SESSION_SUMMARY_REMINDER,
  buildMemoryDigest,
  buildReadAttentionDigest,
  collectDigestData,
  extractIssues,
  // exported for focused reuse / tests
  defaultFetchNotes,
  defaultFetchIssues,
  defaultFetchInbox,
};
