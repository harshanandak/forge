'use strict';

const { describe, test, expect } = require('bun:test');

const {
  getStalenessBoost,
  scoreIssues,
} = require('../../lib/smart-status/scoring.js');

function daysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString();
}

describe('lib/smart-status/scoring.js', () => {
  test('scores and sorts issues using the same priority/type/status/unblock/staleness model', () => {
    const scored = scoreIssues([
      { id: 'p4', title: 'Low', priority: 'P4', type: 'feature', status: 'open', dependent_count: 0, updated_at: daysAgo(1) },
      { id: 'p0', title: 'Urgent', priority: 'P0', type: 'feature', status: 'open', dependent_count: 0, updated_at: daysAgo(1) },
      { id: 'bug', title: 'Bug', priority: 'P2', type: 'bug', status: 'in_progress', dependent_count: 2, updated_at: daysAgo(10) },
      { id: 'stale', title: 'Stale', priority: 'P2', type: 'feature', status: 'open', dependent_count: 0, updated_at: daysAgo(35) },
    ]);

    expect(scored.map((issue) => issue.id)).toEqual(['bug', 'p0', 'stale', 'p4']);
    expect(scored.find((issue) => issue.id === 'p0').priority_weight).toBe(5);
    expect(scored.find((issue) => issue.id === 'bug').type_weight).toBe(1.2);
    expect(scored.find((issue) => issue.id === 'bug').status_boost).toBe(1.5);
    expect(scored.find((issue) => issue.id === 'bug').unblock_chain).toBe(3);
    expect(scored.find((issue) => issue.id === 'stale').staleness_boost).toBe(1.5);
  });

  test('builds dependents and epic proximity into the score payload', () => {
    const scored = scoreIssues([
      { id: 'epic1', title: 'Epic', type: 'epic', status: 'open', updated_at: daysAgo(1) },
      { id: 'child', title: 'Child', priority: 'P2', type: 'feature', status: 'open', dependent_count: 0, updated_at: daysAgo(1), parent_id: 'epic1' },
      { id: 'consumer-a', title: 'Consumer A', priority: 'P2', type: 'task', status: 'open', dependent_count: 0, updated_at: daysAgo(1), dependencies: [{ depends_on_id: 'child' }] },
      { id: 'consumer-b', title: 'Consumer B', priority: 'P2', type: 'task', status: 'open', dependent_count: 0, updated_at: daysAgo(1), dependencies: [{ depends_on_id: 'child' }] },
    ], {
      epicStats: {
        epic1: { closed: 4, total: 5 },
      },
    });

    const child = scored.find((issue) => issue.id === 'child');
    expect(child.dependents).toEqual(['consumer-a', 'consumer-b']);
    expect(child.epic_proximity).toBeCloseTo(1.4, 1);
  });

  test('treats numeric and unknown values the same way as the shell scorer', () => {
    const scored = scoreIssues([
      { id: 'numeric', title: 'Numeric priority', priority: 2, type: null, status: 'closed', updated_at: daysAgo(1) },
      { id: 'unknown', title: 'Unknown priority', priority: 'P9', type: 'chore', status: 'open', updated_at: daysAgo(1) },
    ]);

    const numeric = scored.find((issue) => issue.id === 'numeric');
    const unknown = scored.find((issue) => issue.id === 'unknown');

    expect(numeric.priority_weight).toBe(3);
    expect(numeric.type_weight).toBe(0.8);
    expect(numeric.status_boost).toBe(1.0);
    expect(unknown.priority_weight).toBe(1);
    expect(unknown.type_weight).toBe(1.0);
  });

  test('staleness thresholds match the shell ladder', () => {
    expect(getStalenessBoost(daysAgo(3))).toBe(1.0);
    expect(getStalenessBoost(daysAgo(10))).toBe(1.1);
    expect(getStalenessBoost(daysAgo(20))).toBe(1.2);
    expect(getStalenessBoost(daysAgo(35))).toBe(1.5);
  });
});
