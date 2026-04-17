const { describe, test, expect, setDefaultTimeout } = require('bun:test');

const { daysAgo } = require('./smart-status.helpers');
const { runScoringJson } = require('./smart-status.scoring.helpers');

setDefaultTimeout(20000);

describe('smart-status.sh', () => {
  describe('scoring factors', () => {
    test.concurrent('priority_weight: P0=5 > P1=4 > P2=3 > P3=2 > P4=1', () => {
      const { result, scored } = runScoringJson({
        issues: [
          { id: 'a', title: 'P4 issue', priority: 'P4', type: 'feature', status: 'open', dependent_count: 0, updated_at: daysAgo(1) },
          { id: 'b', title: 'P0 issue', priority: 'P0', type: 'feature', status: 'open', dependent_count: 0, updated_at: daysAgo(1) },
          { id: 'c', title: 'P2 issue', priority: 'P2', type: 'feature', status: 'open', dependent_count: 0, updated_at: daysAgo(1) },
        ],
      });

      expect(result.status).toBe(0);
      expect(scored[0].id).toBe('b');
      expect(scored[1].id).toBe('c');
      expect(scored[2].id).toBe('a');
    });

    test.concurrent('type_weight: bug=1.2 > feature=1.0 > task=0.8', () => {
      const { result, scored } = runScoringJson({
        issues: [
          { id: 'task1', title: 'Task', priority: 'P2', type: 'task', status: 'open', dependent_count: 0, updated_at: daysAgo(1) },
          { id: 'bug1', title: 'Bug', priority: 'P2', type: 'bug', status: 'open', dependent_count: 0, updated_at: daysAgo(1) },
          { id: 'feat1', title: 'Feature', priority: 'P2', type: 'feature', status: 'open', dependent_count: 0, updated_at: daysAgo(1) },
        ],
      });

      expect(result.status).toBe(0);
      expect(scored[0].id).toBe('bug1');
      expect(scored[1].id).toBe('feat1');
      expect(scored[2].id).toBe('task1');
    });

    test.concurrent('status_boost: in_progress=1.5 > open=1.0', () => {
      const { result, scored } = runScoringJson({
        issues: [
          { id: 'open1', title: 'Open', priority: 'P2', type: 'feature', status: 'open', dependent_count: 0, updated_at: daysAgo(1) },
          { id: 'wip1', title: 'WIP', priority: 'P2', type: 'feature', status: 'in_progress', dependent_count: 0, updated_at: daysAgo(1) },
        ],
      });

      expect(result.status).toBe(0);
      expect(scored[0].id).toBe('wip1');
      expect(scored[1].id).toBe('open1');
    });

    test.concurrent('unblock_chain: higher dependent_count scores higher', () => {
      const { result, scored } = runScoringJson({
        issues: [
          { id: 'low', title: 'Low deps', priority: 'P2', type: 'feature', status: 'open', dependent_count: 0, updated_at: daysAgo(1) },
          { id: 'high', title: 'High deps', priority: 'P2', type: 'feature', status: 'open', dependent_count: 5, updated_at: daysAgo(1) },
        ],
      });

      expect(result.status).toBe(0);
      expect(scored[0].id).toBe('high');
      expect(scored[1].id).toBe('low');
    });

    test.concurrent('staleness_boost: older issues score higher', () => {
      const { result, scored } = runScoringJson({
        issues: [
          { id: 'fresh', title: 'Fresh', priority: 'P2', type: 'feature', status: 'open', dependent_count: 0, updated_at: daysAgo(1) },
          { id: 'stale', title: 'Stale', priority: 'P2', type: 'feature', status: 'open', dependent_count: 0, updated_at: daysAgo(35) },
          { id: 'medium', title: 'Medium', priority: 'P2', type: 'feature', status: 'open', dependent_count: 0, updated_at: daysAgo(20) },
        ],
      });

      expect(result.status).toBe(0);
      expect(scored[0].id).toBe('stale');
      expect(scored[1].id).toBe('medium');
      expect(scored[2].id).toBe('fresh');
    });
  });

  describe('composite scoring and sorting', () => {
    test.concurrent('sorts by composite score descending with mixed factors', () => {
      const { result, scored } = runScoringJson({
        issues: [
          { id: 'x', title: 'X', priority: 'P4', type: 'bug', status: 'in_progress', dependent_count: 3, updated_at: daysAgo(35) },
          { id: 'y', title: 'Y', priority: 'P0', type: 'feature', status: 'open', dependent_count: 0, updated_at: daysAgo(1) },
          { id: 'z', title: 'Z', priority: 'P1', type: 'task', status: 'open', dependent_count: 10, updated_at: daysAgo(10) },
        ],
      });

      expect(result.status).toBe(0);
      expect(scored.length).toBe(3);
      expect(scored[0].id).toBe('z');
      expect(scored[1].id).toBe('x');
      expect(scored[2].id).toBe('y');
      expect(scored[0]).toHaveProperty('score');
      expect(scored[0]).toHaveProperty('priority_weight');
      expect(scored[0]).toHaveProperty('unblock_chain');
      expect(scored[0]).toHaveProperty('type_weight');
      expect(scored[0]).toHaveProperty('status_boost');
      expect(scored[0]).toHaveProperty('staleness_boost');
    });

    test.concurrent('each scored item includes score breakdown fields', () => {
      const { result, scored } = runScoringJson({
        issues: [
          { id: 'a', title: 'A', priority: 'P2', type: 'bug', status: 'in_progress', dependent_count: 2, updated_at: daysAgo(10) },
        ],
      });

      expect(result.status).toBe(0);
      const item = scored[0];
      expect(item.priority_weight).toBe(3);
      expect(item.unblock_chain).toBe(3);
      expect(item.type_weight).toBe(1.2);
      expect(item.status_boost).toBe(1.5);
      expect(item.staleness_boost).toBe(1.1);
      expect(item.score).toBeCloseTo(17.82, 1);
    });
  });
});
