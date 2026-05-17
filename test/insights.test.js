const { afterEach, describe, expect, test } = require('bun:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  analyzeInsights,
  buildRecap,
  formatInsightsText,
  formatRecapText,
  recordInsightDecision,
} = require('../lib/insights');

const tempRoots = [];

function makeRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-insights-'));
  tempRoots.push(root);
  fs.mkdirSync(path.join(root, '.beads'), { recursive: true });
  return root;
}

function writeJsonl(filePath, rows) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${rows.map(row => JSON.stringify(row)).join('\n')}\n`, 'utf8');
}

function interaction(index, extra = {}) {
  return {
    id: `int-${index}`,
    kind: 'field_change',
    created_at: `2026-05-${String(index).padStart(2, '0')}T12:00:00Z`,
    actor: 'Codex',
    issue_id: `forge-${index}`,
    extra: {
      field: 'status',
      old_value: 'open',
      new_value: 'closed',
      reason: 'Merged and verified on master after review',
      ...extra,
    },
  };
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('insights analysis', () => {
  test('extracts ranked patterns from interactions, issues, and audit evidence', () => {
    const root = makeRepo();
    writeJsonl(path.join(root, '.beads', 'interactions.jsonl'), [
      interaction(1),
      interaction(2),
      interaction(3),
      interaction(4),
      interaction(5),
      interaction(6, { new_value: 'in_progress', reason: 'Claimed for implementation' }),
    ]);
    writeJsonl(path.join(root, '.beads', 'issues.jsonl'), [
      { _type: 'issue', id: 'forge-a', title: 'Windows hook false positive', status: 'closed' },
      { _type: 'issue', id: 'forge-b', title: 'Windows hook validation mismatch', status: 'open' },
      { _type: 'issue', id: 'forge-c', title: 'Review evidence persistence', status: 'closed' },
    ]);
    writeJsonl(path.join(root, '.forge', 'audit.log'), [
      { kind: 'review_outcome', issue_id: 'forge-a' },
      { kind: 'review_outcome', issue_id: 'forge-b' },
    ]);

    const result = analyzeInsights(root, { minCount: 2, limit: 5 });

    expect(result.lowSignal).toBe(false);
    expect(result.patterns[0]).toMatchObject({
      kind: 'interaction',
      count: 5,
    });
    expect(result.patterns.map(pattern => pattern.kind)).toContain('audit');
    expect(result.candidates[0].id).toStartWith('insight-');
    expect(result.candidates[0].score).toBeGreaterThan(result.candidates.at(-1).score - 1);
  });

  test('reads supplemental Forge audit evidence from log.jsonl', () => {
    const root = makeRepo();
    writeJsonl(path.join(root, '.forge', 'log.jsonl'), [
      { kind: 'fallback_metadata', issue_id: 'forge-a', timestamp: '2026-05-10T10:00:00Z' },
      { kind: 'fallback_metadata', issue_id: 'forge-b', timestamp: '2026-05-11T10:00:00Z' },
    ]);

    const result = analyzeInsights(root, { minCount: 2 });

    expect(result.sources.audit).toBe(2);
    expect(result.patterns).toContainEqual(expect.objectContaining({
      kind: 'audit',
      key: 'audit:fallback_metadata',
      sources: ['.forge/log.jsonl'],
    }));
  });

  test('reports empty and low-signal history without inventing suggestions', () => {
    const root = makeRepo();
    writeJsonl(path.join(root, '.beads', 'interactions.jsonl'), [interaction(1)]);
    writeJsonl(path.join(root, '.beads', 'issues.jsonl'), [
      { _type: 'issue', id: 'forge-a', title: 'One-off task', status: 'open' },
    ]);

    const result = analyzeInsights(root, { minCount: 3 });
    const output = formatInsightsText(result);

    expect(result.lowSignal).toBe(true);
    expect(result.candidates).toHaveLength(0);
    expect(output).toContain('No strong recurring patterns found');
  });

  test('records accept and reject decisions through typed memory', () => {
    const root = makeRepo();
    const writes = [];
    const memory = {
      write(_projectRoot, entry) {
        writes.push(entry);
        return entry;
      },
    };

    const accepted = recordInsightDecision(root, 'insight-review-outcome', 'accepted', {
      note: 'Create a local review checklist skill',
      memory,
    });
    const rejected = recordInsightDecision(root, 'insight-noise', 'rejected', {
      note: 'Too generic',
      memory,
    });

    expect(accepted.key).toBe('skills:insight-review-outcome');
    expect(rejected.key).toBe('skills:insight-noise');
    expect(writes).toHaveLength(2);
    expect(writes[0].value.data.status).toBe('accepted');
    expect(writes[1].value.data.status).toBe('rejected');
    expect(writes[0].beadsRefs).toEqual(['forge-besw.12', 'forge-1gry', 'forge-5q7s']);
  });

  test('builds recap output with recent work, evidence, and limitations', () => {
    const root = makeRepo();
    writeJsonl(path.join(root, '.beads', 'interactions.jsonl'), [
      interaction(1),
      interaction(2),
      interaction(3),
    ]);
    writeJsonl(path.join(root, '.beads', 'issues.jsonl'), [
      { _type: 'issue', id: 'forge-a', title: 'Review evidence persistence', status: 'closed', closed_at: '2026-05-15T10:00:00Z' },
      { _type: 'issue', id: 'forge-b', title: 'Pattern detector UX', status: 'open', priority: 1 },
    ]);

    const recap = buildRecap(root, { minCount: 2 });
    const output = formatRecapText(recap);

    expect(recap.issueSummary.total).toBe(2);
    expect(recap.reviewOutcomes).toBeGreaterThanOrEqual(3);
    expect(output).toContain('Forge recap');
    expect(output).toContain('Limitations');
  });

  test('recap applies the since window to issues and interactions', () => {
    const root = makeRepo();
    writeJsonl(path.join(root, '.beads', 'interactions.jsonl'), [
      interaction(1, { reason: 'Merged and verified on master after review' }),
      interaction(9, { reason: 'Merged and verified on master after review' }),
    ]);
    writeJsonl(path.join(root, '.beads', 'issues.jsonl'), [
      { _type: 'issue', id: 'forge-old', title: 'Old review evidence', status: 'closed', updated_at: '2026-05-01T10:00:00Z' },
      { _type: 'issue', id: 'forge-new', title: 'New review evidence', status: 'open', updated_at: '2026-05-09T10:00:00Z' },
    ]);

    const recap = buildRecap(root, { since: '2026-05-05', minCount: 1 });

    expect(recap.issueSummary.total).toBe(1);
    expect(recap.reviewOutcomes).toBe(1);
    expect(recap.recentIssues.map(issue => issue.id)).toEqual(['forge-new']);
  });

  test('since filtering excludes undated rows and malformed scalar JSONL values', () => {
    const root = makeRepo();
    writeJsonl(path.join(root, '.beads', 'interactions.jsonl'), [
      null,
      'bad-row',
      { id: 'undated', kind: 'field_change', issue_id: 'forge-undated', extra: { field: 'status', new_value: 'closed' } },
      interaction(9, { reason: 'Merged and verified on master after review' }),
    ]);
    writeJsonl(path.join(root, '.beads', 'issues.jsonl'), [
      { _type: 'issue', id: 'forge-undated', title: 'Undated review evidence', status: 'closed' },
      {
        _type: 'issue',
        id: 'forge-description',
        title: 'Small task',
        description: 'recurringdescriptiontoken recurringdescriptiontoken',
        status: 'open',
        updated_at: '2026-05-09T10:00:00Z',
      },
    ]);

    const insights = analyzeInsights(root, { since: '2026-05-05', minCount: 1 });
    const recap = buildRecap(root, { since: '2026-05-05', minCount: 1 });

    expect(insights.patterns.some(pattern => pattern.evidence.includes('forge-undated'))).toBe(false);
    expect(insights.patterns.some(pattern => pattern.key === 'issue-theme:recurringdescriptiontoken')).toBe(true);
    expect(recap.issueSummary.total).toBe(1);
    expect(recap.reviewOutcomes).toBe(1);
  });

  test('rejects invalid since dates instead of disabling filtering', () => {
    const root = makeRepo();

    expect(() => analyzeInsights(root, { since: 'not-a-date' })).toThrow('Invalid --since date');
    expect(() => buildRecap(root, { since: 'not-a-date' })).toThrow('Invalid --since date');
  });
});
