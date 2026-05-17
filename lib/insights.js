'use strict';

const fs = require('node:fs');
const path = require('node:path');
const typedMemory = require('./memory/typed-api');

const ISSUE_REFS = ['forge-besw.12', 'forge-1gry', 'forge-5q7s'];
const DEFAULT_MIN_COUNT = 5;
const DEFAULT_LIMIT = 10;
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

function interactionPatterns(projectRoot, options, map) {
  const rows = readJsonl(path.join(projectRoot, '.beads', 'interactions.jsonl'));
  for (const row of rows) {
    if (!row || typeof row !== 'object' || row._parseError || !isSince(row.created_at, options.since)) continue;
    const extra = row.extra && typeof row.extra === 'object' ? row.extra : {};
    if (row.kind === 'field_change' && extra.field) {
      const family = reasonFamily(extra.reason);
      const key = `interaction:${extra.field}:${extra.new_value || 'changed'}:${family}`;
      addPattern(map, key, {
        kind: 'interaction',
        title: `${extra.field} changed to ${extra.new_value || 'changed'} (${family})`,
        evidence: row.issue_id || row.id,
        source: '.beads/interactions.jsonl',
        lastSeen: row.created_at,
      });
    } else if (row.kind) {
      addPattern(map, `interaction:${row.kind}`, {
        kind: 'interaction',
        title: `Interaction event: ${row.kind}`,
        evidence: row.issue_id || row.id,
        source: '.beads/interactions.jsonl',
        lastSeen: row.created_at,
      });
    }
  }
  return rows;
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

function issuePatterns(projectRoot, options, map) {
  const rows = readJsonl(path.join(projectRoot, '.beads', 'issues.jsonl'))
    .filter(row => row && !row._parseError && row._type === 'issue');
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
      source: '.beads/issues.jsonl',
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

function analyzeInsights(projectRoot, options = {}) {
  const normalized = normalizeOptions(options);
  const map = new Map();
  const interactions = interactionPatterns(projectRoot, normalized, map);
  const issues = issuePatterns(projectRoot, normalized, map);
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
      'Sparse Beads interactions or missing audit logs reduce confidence.',
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
    beadsRefs: ISSUE_REFS,
    provenance: {
      actor: 'forge insights',
      reason: `Insight suggestion ${status}`,
      source: 'forge insights',
    },
  });
}

function issueSummary(issues) {
  return issues.reduce((summary, issue) => {
    summary.total += 1;
    if (issue.status === 'closed') summary.closed += 1;
    else summary.open += 1;
    return summary;
  }, { total: 0, open: 0, closed: 0 });
}

function buildRecap(projectRoot, options = {}) {
  const normalized = normalizeOptions(options);
  const insights = analyzeInsights(projectRoot, options);
  const issues = readJsonl(path.join(projectRoot, '.beads', 'issues.jsonl'))
    .filter(row => row && !row._parseError && row._type === 'issue')
    .filter(issue => isSince(issue.updated_at || issue.closed_at || issue.created_at, normalized.since));
  const interactions = readJsonl(path.join(projectRoot, '.beads', 'interactions.jsonl'))
    .filter(row => row && typeof row === 'object' && !row._parseError)
    .filter(row => isSince(row.created_at, normalized.since));
  const reviewOutcomes = interactions.filter(row => {
    const reason = row.extra?.reason || '';
    return reasonFamily(reason) === 'merged-and-verified' || String(reason).toLowerCase().includes('review');
  }).length;
  const recentIssues = [...issues]
    .sort((a, b) => String(b.updated_at || b.closed_at || b.created_at || '').localeCompare(String(a.updated_at || a.closed_at || a.created_at || '')))
    .slice(0, normalized.limit)
    .map(issue => ({
      id: issue.id,
      title: issue.title,
      status: issue.status,
    }));

  return {
    generatedAt: new Date().toISOString(),
    issueSummary: issueSummary(issues),
    reviewOutcomes,
    recentIssues,
    insights,
  };
}

function formatRecapText(recap) {
  const lines = [
    'Forge recap',
    `Issues: ${recap.issueSummary.total} total, ${recap.issueSummary.open} open, ${recap.issueSummary.closed} closed`,
    `Review outcomes found: ${recap.reviewOutcomes}`,
    'Recent work:',
  ];
  for (const issue of recap.recentIssues) {
    lines.push(`- ${issue.id}: ${issue.title} [${issue.status || 'unknown'}]`);
  }
  lines.push('Insight candidates:');
  if (recap.insights.candidates.length === 0) {
    lines.push('- No strong recurring patterns found.');
  } else {
    for (const candidate of recap.insights.candidates) {
      lines.push(`- ${candidate.id}: ${candidate.title}`);
    }
  }
  lines.push('Limitations:');
  for (const limitation of recap.insights.limitations) lines.push(`- ${limitation}`);
  return `${lines.join('\n')}\n`;
}

module.exports = {
  ISSUE_REFS,
  analyzeInsights,
  buildRecap,
  formatInsightsText,
  formatRecapText,
  readJsonl,
  recordInsightDecision,
};
