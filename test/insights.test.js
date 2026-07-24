const { afterEach, describe, expect, test } = require('bun:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  analyzeInsights,
  formatInsightsText,
  recordInsightDecision,
} = require('../lib/insights');

const tempRoots = [];

function makeRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-insights-'));
  tempRoots.push(root);
  return root;
}

function writeJsonl(filePath, rows) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${rows.map(row => JSON.stringify(row)).join('\n')}\n`, 'utf8');
}

// A kernel_events row as the driver returns it. Imported beads interactions carry
// `beads.interaction.<kind>` plus a payload_json of `{ kind, ...extra }`, so the fixtures
// mirror that shape exactly rather than the retired `.beads/interactions.jsonl` record.
function eventRow({ id, issueId, kind, createdAt, payload = {} }) {
  return {
    id,
    entity_type: 'issue',
    entity_id: issueId ?? null,
    event_type: `beads.interaction.${kind}`,
    actor: 'Codex',
    origin: 'beads_import',
    payload_json: JSON.stringify({ kind, ...payload }),
    created_at: createdAt ?? null,
  };
}

function fieldChangeEvent(index, extra = {}) {
  return eventRow({
    id: `int-${index}`,
    issueId: `forge-${index}`,
    kind: 'field_change',
    createdAt: `2026-05-${String(index).padStart(2, '0')}T12:00:00Z`,
    payload: {
      field: 'status',
      old_value: 'open',
      new_value: 'closed',
      reason: 'Merged and verified on master after review',
      ...extra,
    },
  });
}

// Injected seams: `listRecentEvents` stands in for the kernel activity read and
// `runIssueOperation` for the `issue list` envelope (data.issues), so no test needs a
// real broker, a database, or an on-disk issue store.
function fakeEvents(rows) {
  return async () => rows;
}

function fakeIssues(issues) {
  return async (command) => {
    if (command !== 'list') return { ok: false };
    return { ok: true, data: { issues } };
  };
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('insights analysis', () => {
  test('extracts ranked patterns from kernel events, kernel issues, and audit evidence', async () => {
    const root = makeRepo();
    writeJsonl(path.join(root, '.forge', 'audit.log'), [
      { kind: 'review_outcome', issue_id: 'forge-a' },
      { kind: 'review_outcome', issue_id: 'forge-b' },
    ]);

    const result = await analyzeInsights(root, {
      minCount: 2,
      limit: 5,
      listRecentEvents: fakeEvents([
        fieldChangeEvent(1),
        fieldChangeEvent(2),
        fieldChangeEvent(3),
        fieldChangeEvent(4),
        fieldChangeEvent(5),
        fieldChangeEvent(6, { new_value: 'in_progress', reason: 'Claimed for implementation' }),
      ]),
      runIssueOperation: fakeIssues([
        { id: 'forge-a', title: 'Windows hook false positive', status: 'closed' },
        { id: 'forge-b', title: 'Windows hook validation mismatch', status: 'open' },
        { id: 'forge-c', title: 'Review evidence persistence', status: 'closed' },
      ]),
    });

    expect(result.lowSignal).toBe(false);
    expect(result.sources).toMatchObject({ interactions: 6, issues: 3, audit: 2 });
    expect(result.patterns[0]).toMatchObject({
      kind: 'interaction',
      count: 5,
    });
    expect(result.patterns.map(pattern => pattern.kind)).toContain('audit');
    expect(result.candidates[0].id).toStartWith('insight-');
    expect(result.candidates[0].score).toBeGreaterThan(result.candidates.at(-1).score - 1);
  });

  test('interaction patterns are sourced from kernel_events, and issue themes from the kernel', async () => {
    const root = makeRepo();

    const result = await analyzeInsights(root, {
      minCount: 2,
      listRecentEvents: fakeEvents([fieldChangeEvent(1), fieldChangeEvent(2)]),
      runIssueOperation: fakeIssues([
        { id: 'forge-a', title: 'Windows hook false positive', status: 'closed' },
        { id: 'forge-b', title: 'Windows hook validation mismatch', status: 'open' },
      ]),
    });

    expect(result.patterns).toContainEqual(expect.objectContaining({
      kind: 'interaction',
      sources: ['kernel_events'],
    }));
    expect(result.patterns).toContainEqual(expect.objectContaining({
      key: 'issue-theme:windows',
      sources: ['kernel'],
    }));
  });

  test('non-field_change kernel events still count as interaction evidence by kind', async () => {
    const root = makeRepo();

    const result = await analyzeInsights(root, {
      minCount: 2,
      listRecentEvents: fakeEvents([
        eventRow({ id: 'n-1', issueId: 'forge-a', kind: 'note', createdAt: '2026-05-01T10:00:00Z' }),
        eventRow({ id: 'n-2', issueId: 'forge-b', kind: 'note', createdAt: '2026-05-02T10:00:00Z' }),
      ]),
      runIssueOperation: fakeIssues([]),
    });

    expect(result.patterns).toContainEqual(expect.objectContaining({
      key: 'interaction:note',
      count: 2,
    }));
  });

  test('a native kernel event with no payload kind falls back to its event_type', async () => {
    const root = makeRepo();

    const result = await analyzeInsights(root, {
      minCount: 2,
      listRecentEvents: fakeEvents([
        { id: 'k-1', entity_id: 'forge-a', event_type: 'issue.update', payload_json: '{}', created_at: '2026-05-01T10:00:00Z' },
        { id: 'k-2', entity_id: 'forge-b', event_type: 'issue.update', payload_json: 'not-json', created_at: '2026-05-02T10:00:00Z' },
      ]),
      runIssueOperation: fakeIssues([]),
    });

    expect(result.patterns).toContainEqual(expect.objectContaining({
      key: 'interaction:issue.update',
      count: 2,
    }));
  });

  test('reads supplemental Forge audit evidence from log.jsonl', async () => {
    const root = makeRepo();
    writeJsonl(path.join(root, '.forge', 'log.jsonl'), [
      { kind: 'fallback_metadata', issue_id: 'forge-a', timestamp: '2026-05-10T10:00:00Z' },
      { kind: 'fallback_metadata', issue_id: 'forge-b', timestamp: '2026-05-11T10:00:00Z' },
    ]);

    const result = await analyzeInsights(root, {
      minCount: 2,
      listRecentEvents: fakeEvents([]),
      runIssueOperation: fakeIssues([]),
    });

    expect(result.sources.audit).toBe(2);
    expect(result.patterns).toContainEqual(expect.objectContaining({
      kind: 'audit',
      key: 'audit:fallback_metadata',
      sources: ['.forge/log.jsonl'],
    }));
  });

  test('reports empty and low-signal history without inventing suggestions', async () => {
    const root = makeRepo();

    const result = await analyzeInsights(root, {
      minCount: 3,
      listRecentEvents: fakeEvents([fieldChangeEvent(1)]),
      runIssueOperation: fakeIssues([{ id: 'forge-a', title: 'One-off task', status: 'open' }]),
    });
    const output = formatInsightsText(result);

    expect(result.lowSignal).toBe(true);
    expect(result.candidates).toHaveLength(0);
    expect(output).toContain('No strong recurring patterns found');
  });

  test('a failing kernel read degrades to empty evidence instead of throwing', async () => {
    const root = makeRepo();

    const result = await analyzeInsights(root, {
      minCount: 2,
      listRecentEvents: fakeEvents([]),
      runIssueOperation: async () => { throw new Error('kernel unavailable'); },
    });

    expect(result.sources).toMatchObject({ interactions: 0, issues: 0 });
    expect(result.lowSignal).toBe(true);
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
    // `beadsRefs` is a persisted typed-memory field name kept for data-shape compat.
    expect(writes[0].beadsRefs).toEqual(['forge-besw.12', 'forge-1gry', 'forge-5q7s']);
  });

  test('since is forwarded to the kernel event read as an ISO cutoff', async () => {
    const root = makeRepo();
    const seen = [];

    await analyzeInsights(root, {
      since: '2026-05-05',
      minCount: 1,
      listRecentEvents: async (_projectRoot, window) => {
        seen.push(window);
        return [];
      },
      runIssueOperation: fakeIssues([]),
    });

    expect(seen).toHaveLength(1);
    expect(seen[0].since).toBe(new Date('2026-05-05').toISOString());
    expect(seen[0].limit).toBeGreaterThan(0);
  });

  test('since filtering excludes undated rows and rows older than the window', async () => {
    const root = makeRepo();

    const result = await analyzeInsights(root, {
      since: '2026-05-05',
      minCount: 1,
      listRecentEvents: fakeEvents([
        null,
        'bad-row',
        eventRow({ id: 'undated', issueId: 'forge-undated', kind: 'field_change', createdAt: null, payload: { field: 'status', new_value: 'closed' } }),
        fieldChangeEvent(9),
      ]),
      runIssueOperation: fakeIssues([
        { id: 'forge-undated', title: 'Undated review evidence', status: 'closed' },
        {
          id: 'forge-description',
          title: 'Small task',
          description: 'recurringdescriptiontoken recurringdescriptiontoken',
          status: 'open',
          updated_at: '2026-05-09T10:00:00Z',
        },
      ]),
    });

    expect(result.patterns.some(pattern => pattern.evidence.includes('forge-undated'))).toBe(false);
    expect(result.patterns.some(pattern => pattern.key === 'issue-theme:recurringdescriptiontoken')).toBe(true);
  });

  test('rejects invalid since dates instead of disabling filtering', async () => {
    const root = makeRepo();

    await expect(analyzeInsights(root, { since: 'not-a-date' })).rejects.toThrow('Invalid --since date');
  });
});
