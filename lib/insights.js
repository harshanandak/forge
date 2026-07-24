'use strict';

const fs = require('node:fs');
const path = require('node:path');
const typedMemory = require('./memory/typed-api');
const { runIssueOperation: defaultRunIssueOperation } = require('./forge-issues');
const { buildMigratedKernelIssueDeps } = require('./kernel/cli-broker-factory');

const ISSUE_REFS = ['forge-besw.12', 'forge-1gry', 'forge-5q7s'];
const DEFAULT_MIN_COUNT = 5;
const DEFAULT_LIMIT = 10;
// Upper bound on kernel_events scanned for interaction patterns — a spot-read, not a
// full history walk. Newest-first, so recent activity dominates the signal.
const EVENT_READ_LIMIT = 2000;

// Default kernel activity read for `forge insights` (Slice C2). Builds a short-lived
// migrated broker, reads recent kernel_events, and ALWAYS closes the driver (Windows
// CI fails on a leaked handle). Injectable via analyzeInsights options for tests.
async function defaultListRecentEvents(projectRoot, { since = null, limit = null } = {}) {
  let deps;
  try {
    deps = await buildMigratedKernelIssueDeps({ projectRoot });
  } catch {
    return [];
  }
  try {
    return await deps.kernelBroker.listRecentEvents({ since, limit });
  } catch {
    return [];
  } finally {
    if (deps.kernelDriver && typeof deps.kernelDriver.close === 'function') {
      deps.kernelDriver.close();
    }
  }
}

// Map a kernel_events row back to the interaction shape insights consumes. Imported beads
// interactions carry event_type `beads.interaction.<kind>` and payload_json `{ kind, ...extra }`
// where field/new_value/reason live at the top level alongside kind (see beads-kernel-compat
// mapBeadsInteractionToKernel). Native kernel events fall back to their event_type as the kind.
function eventToInteraction(row) {
  if (!row || typeof row !== 'object') return null;
  let parsed;
  try {
    parsed = row.payload_json ? JSON.parse(row.payload_json) : row.payload;
  } catch {
    parsed = null;
  }
  // A scalar or array payload carries no interaction fields — treat it as empty.
  const payload = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  const kind = payload.kind
    || String(row.event_type || '').replace(/^beads\.interaction\./, '')
    || 'interaction';
  return {
    kind,
    id: row.id,
    issue_id: row.entity_id || null,
    created_at: row.created_at || null,
    extra: payload,
  };
}

// Read all issues from the Kernel (the sole issue-state authority) for theme mining.
// Resilient: any read failure degrades to empty issue evidence rather than throwing.
async function listKernelIssues(projectRoot, runIssueOperation, env) {
  try {
    const result = await runIssueOperation('list', [], projectRoot, { issueBackend: 'kernel', env });
    if (result && result.ok && result.data && Array.isArray(result.data.issues)) {
      return result.data.issues;
    }
  } catch {
    // best-effort: insights never crashes on a kernel read failure
  }
  return [];
}
const STOP_WORDS = new Set([
  'after',
  'against',
  'and',
  'are',
  'beads',
  'command',
  'commands',
  'forge',
  'from',
  'into',
  'issue',
  'stage',
  'task',
  'that',
  'the',
  'this',
  'with',
  'work',
  'workflow',
  'workflows',
]);

function readJsonl(filePath) {
  if (!fs.existsSync(filePath)) return [];
  return fs.readFileSync(filePath, 'utf8')
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)
    .map((line, index) => {
      try {
        return JSON.parse(line);
      } catch (error) {
        return {
          _parseError: true,
          line: index + 1,
          error: error.message,
        };
      }
    });
}

function asDate(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function isSince(value, since) {
  if (!since) return true;
  const date = asDate(value);
  return date ? date >= since : false;
}

function slug(value) {
  const chars = [];
  let previousWasDash = true;
  for (const char of String(value || 'pattern').toLowerCase()) {
    const isAlphaNumeric = (char >= 'a' && char <= 'z') || (char >= '0' && char <= '9');
    if (isAlphaNumeric) {
      chars.push(char);
      previousWasDash = false;
    } else if (!previousWasDash) {
      chars.push('-');
      previousWasDash = true;
    }
  }
  if (chars.at(-1) === '-') chars.pop();
  const normalized = chars.join('');
  return normalized || 'pattern';
}

function reasonFamily(reason = '') {
  const lower = String(reason).toLowerCase();
  if (lower.includes('merged') && lower.includes('verified')) return 'merged-and-verified';
  if (lower.includes('superseded')) return 'superseded';
  if (lower.includes('completed')) return 'completed';
  if (lower.includes('review')) return 'review-outcome';
  if (lower.includes('claim')) return 'claimed';
  return 'unspecified';
}

function addPattern(map, key, patch) {
  const existing = map.get(key) ?? {
    key,
    kind: patch.kind,
    title: patch.title,
    count: 0,
    evidence: [],
    sources: new Set(),
    lastSeen: null,
  };
  existing.count += patch.count ?? 1;
  if (patch.evidence) existing.evidence.push(patch.evidence);
  if (patch.source) existing.sources.add(patch.source);
  const seen = asDate(patch.lastSeen);
  if (seen && (!existing.lastSeen || seen > existing.lastSeen)) {
    existing.lastSeen = seen;
  }
  map.set(key, existing);
}

async function interactionPatterns(projectRoot, options, map) {
  const listRecentEvents = options.listRecentEvents || defaultListRecentEvents;
  const since = options.since ? options.since.toISOString() : null;
  const rawEvents = await listRecentEvents(projectRoot, { since, limit: EVENT_READ_LIMIT, env: options.env });
  const interactions = (Array.isArray(rawEvents) ? rawEvents : [])
    .map(eventToInteraction)
    .filter(Boolean);
  for (const row of interactions) {
    if (!isSince(row.created_at, options.since)) continue;
    const extra = row.extra && typeof row.extra === 'object' ? row.extra : {};
    if (row.kind === 'field_change' && extra.field) {
      const family = reasonFamily(extra.reason);
      const key = `interaction:${extra.field}:${extra.new_value || 'changed'}:${family}`;
      addPattern(map, key, {
        kind: 'interaction',
        title: `${extra.field} changed to ${extra.new_value || 'changed'} (${family})`,
        evidence: row.issue_id || row.id,
        source: 'kernel_events',
        lastSeen: row.created_at,
      });
    } else if (row.kind) {
      addPattern(map, `interaction:${row.kind}`, {
        kind: 'interaction',
        title: `Interaction event: ${row.kind}`,
        evidence: row.issue_id || row.id,
        source: 'kernel_events',
        lastSeen: row.created_at,
      });
    }
  }
  return interactions;
}

function words(value) {
  const tokens = [];
  let current = '';
  const startsWithLetter = token => token.length > 0 && token[0] >= 'a' && token[0] <= 'z';
  for (const char of String(value || '').toLowerCase()) {
    const isAlphaNumeric = (char >= 'a' && char <= 'z') || (char >= '0' && char <= '9');
    if (isAlphaNumeric || (char === '-' && current.length > 0)) {
      current += char;
      continue;
    }
    if (startsWithLetter(current) && current.length >= 4) tokens.push(current);
    current = '';
  }
  if (startsWithLetter(current) && current.length >= 4) tokens.push(current);
  return tokens;
}

async function issuePatterns(projectRoot, options, map) {
  const runIssueOperation = options.runIssueOperation || defaultRunIssueOperation;
  const rows = await listKernelIssues(projectRoot, runIssueOperation, options.env);
  const perWord = new Map();
  for (const issue of rows) {
    if (!isSince(issue.updated_at || issue.closed_at || issue.created_at, options.since)) continue;
    const seen = new Set(words(`${issue.title || ''} ${issue.description || ''}`)
      .filter(word => !STOP_WORDS.has(word)));
    for (const word of seen) {
      if (!perWord.has(word)) perWord.set(word, []);
      perWord.get(word).push(issue);
    }
  }
  for (const [word, issues] of perWord) {
    if (issues.length < options.minCount) continue;
    addPattern(map, `issue-theme:${word}`, {
      kind: 'issue-theme',
      title: `Recurring issue theme: ${word}`,
      count: issues.length,
      evidence: issues.slice(0, 5).map(issue => issue.id).join(', '),
      source: 'kernel',
      lastSeen: issues.map(issue => asDate(issue.updated_at || issue.closed_at || issue.created_at))
        .filter(Boolean)
        .sort((a, b) => b - a)[0],
    });
  }
  return rows;
}

function auditPatterns(projectRoot, options, map) {
  const sources = ['.forge/log.jsonl', '.forge/audit.log'];
  const rows = sources.flatMap(source => readJsonl(path.join(projectRoot, source))
    .map(row => ({ row, source })));
  for (const { row, source } of rows) {
    if (!row || typeof row !== 'object' || row._parseError || !isSince(row.timestamp || row.created_at, options.since)) continue;
    const kind = row.kind || row.event || row.type;
    if (!kind) continue;
    addPattern(map, `audit:${kind}`, {
      kind: 'audit',
      title: `Audit event: ${kind}`,
      evidence: row.issue_id || row.taskId || row.id || kind,
      source,
      lastSeen: row.timestamp || row.created_at,
    });
  }
  return rows;
}

function normalizeOptions(options = {}) {
  const minCount = Number.isFinite(Number(options.minCount)) ? Number(options.minCount) : DEFAULT_MIN_COUNT;
  const limit = Number.isFinite(Number(options.limit)) ? Number(options.limit) : DEFAULT_LIMIT;
  const since = options.since ? asDate(options.since) : null;
  if (options.since && !since) {
    throw new Error(`Invalid --since date: ${options.since}`);
  }
  return {
    minCount: Math.max(1, minCount),
    limit: Math.max(1, limit),
    since,
  };
}

function toPatternList(map, options) {
  return [...map.values()]
    .map(pattern => {
      const weight = pattern.kind === 'issue-theme' ? 1 : 10;
      return {
        ...pattern,
        sources: [...pattern.sources],
        evidence: [...new Set(pattern.evidence)].slice(0, 6),
        lastSeen: pattern.lastSeen ? pattern.lastSeen.toISOString() : null,
        score: pattern.count * weight + pattern.sources.size * 5 + Math.min(pattern.evidence.length, 5),
      };
    })
    .filter(pattern => pattern.count >= options.minCount)
    .sort((a, b) => b.score - a.score || b.count - a.count || a.key.localeCompare(b.key))
    .slice(0, options.limit);
}

function candidateFromPattern(pattern) {
  const id = `insight-${slug(pattern.key).slice(0, 52)}`;
  return {
    id,
    title: pattern.title,
    score: pattern.score,
    patternKey: pattern.key,
    nextStep: `Review ${pattern.kind} evidence and consider a local workflow skill only if the pattern is still useful.`,
    evidence: pattern.evidence,
  };
}

async function analyzeInsights(projectRoot, options = {}) {
  const normalized = normalizeOptions(options);
  // Read options carry the normalized thresholds PLUS the injectable kernel seams
  // (defaulted to the real cli-broker-factory-backed reads) so tests can supply fakes.
  const readOptions = {
    ...normalized,
    runIssueOperation: options.runIssueOperation,
    listRecentEvents: options.listRecentEvents,
    env: options.env,
  };
  const map = new Map();
  const interactions = await interactionPatterns(projectRoot, readOptions, map);
  const issues = await issuePatterns(projectRoot, readOptions, map);
  const audit = auditPatterns(projectRoot, normalized, map);
  const patterns = toPatternList(map, normalized);
  const candidates = patterns.map(candidateFromPattern);

  return {
    generatedAt: new Date().toISOString(),
    minCount: normalized.minCount,
    limit: normalized.limit,
    sources: {
      interactions: interactions.length,
      issues: issues.length,
      audit: audit.length,
    },
    lowSignal: candidates.length === 0,
    patterns,
    candidates,
    limitations: [
      'Insights are local workflow signals, not proof of correctness.',
      'Sparse kernel events or missing audit logs reduce confidence.',
      'Accepting a suggestion records a decision; it does not install trusted executable code.',
    ],
  };
}

function formatInsightsText(result) {
  const lines = [
    'Forge insights',
    `Sources: interactions=${result.sources.interactions}, issues=${result.sources.issues}, audit=${result.sources.audit}`,
  ];
  if (result.lowSignal) {
    lines.push(
      'No strong recurring patterns found.',
      `Threshold: min-count=${result.minCount}`,
    );
  } else {
    lines.push('Ranked candidates:');
    for (const candidate of result.candidates) {
      lines.push(
        `- ${candidate.id} (${candidate.score}): ${candidate.title}`,
        `  Next: ${candidate.nextStep}`,
      );
    }
  }
  return `${[
    ...lines,
    'Limitations:',
    ...result.limitations.map(limitation => `- ${limitation}`),
  ].join('\n')}\n`;
}

function recordInsightDecision(projectRoot, candidateId, status, options = {}) {
  if (!['accepted', 'rejected'].includes(status)) {
    throw new Error('Insight decision status must be accepted or rejected');
  }
  if (!candidateId || typeof candidateId !== 'string') {
    throw new Error('Insight candidate id is required');
  }
  return typedMemory.writeSkill(projectRoot, candidateId, {
    candidateId,
    status,
    note: options.note || '',
    decidedAt: new Date().toISOString(),
  }, {
    memory: options.memory,
    tags: ['insights', status],
    // `beadsRefs` is a persisted typed-memory field name kept for data-shape compat
    // (imported/legacy memories carry it); the values are historical issue references.
    beadsRefs: ISSUE_REFS,
    provenance: {
      actor: 'forge insights',
      reason: `Insight suggestion ${status}`,
      source: 'forge insights',
    },
  });
}

module.exports = {
  ISSUE_REFS,
  analyzeInsights,
  formatInsightsText,
  readJsonl,
  recordInsightDecision,
};
