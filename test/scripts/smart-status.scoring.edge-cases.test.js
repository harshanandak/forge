const { describe, test, expect, setDefaultTimeout } = require('bun:test');

const { daysAgo } = require('./smart-status.helpers');
const { runScoringJson, runScoringText } = require('./smart-status.scoring.helpers');

setDefaultTimeout(20000);

describe('smart-status.sh', () => {
  describe('edge cases', () => {
    test.concurrent('empty issue list returns empty array', () => {
      const { result, scored } = runScoringJson({ issues: [] });

      expect(result.status).toBe(0);
      expect(scored).toEqual([]);
    });

    test.concurrent('single issue returns array with one scored item', () => {
      const { result, scored } = runScoringJson({
        issues: [
          { id: 'solo', title: 'Solo', priority: 'P3', type: 'feature', status: 'open', dependent_count: 0, updated_at: daysAgo(3) },
        ],
      });

      expect(result.status).toBe(0);
      expect(scored.length).toBe(1);
      expect(scored[0].id).toBe('solo');
      expect(scored[0].priority_weight).toBe(2);
      expect(scored[0].type_weight).toBe(1.0);
      expect(scored[0].status_boost).toBe(1.0);
      expect(scored[0].staleness_boost).toBe(1.0);
    });

    test.concurrent('missing dependent_count defaults to 0 (chain=1)', () => {
      const { result, scored } = runScoringJson({
        issues: [
          { id: 'nodeps', title: 'No deps field', priority: 'P2', type: 'feature', status: 'open', updated_at: daysAgo(1) },
        ],
      });

      expect(result.status).toBe(0);
      expect(scored[0].unblock_chain).toBe(1);
    });

    test.concurrent('unknown priority defaults to weight 1', () => {
      const { result, scored } = runScoringJson({
        issues: [
          { id: 'unk', title: 'Unknown pri', priority: 'P9', type: 'feature', status: 'open', dependent_count: 0, updated_at: daysAgo(1) },
        ],
      });

      expect(result.status).toBe(0);
      expect(scored[0].priority_weight).toBe(1);
    });

    test.concurrent('numeric priority 2 gets same weight as P2', () => {
      const { result, scored } = runScoringJson({
        issues: [
          { id: 'num-pri', title: 'Numeric pri', priority: 2, type: 'bug', status: 'open', dependent_count: 0, updated_at: daysAgo(1) },
        ],
      });

      expect(result.status).toBe(0);
      expect(scored[0].priority_weight).toBe(3);
    });

    test.concurrent('numeric priority 4 is grouped into BACKLOG', () => {
      const result = runScoringText({
        issues: [
          { id: 'backlog-num', title: 'Backlog numeric', priority: 4, type: 'task', status: 'open', dependent_count: 0, updated_at: daysAgo(1) },
        ],
      });

      expect(result.status).toBe(0);
      expect(result.stdout).toContain('BACKLOG');
    });

    test.concurrent('null type defaults to task weight 0.8', () => {
      const { result, scored } = runScoringJson({
        issues: [
          { id: 'null-type', title: 'Null type issue', priority: 'P2', type: null, status: 'open', dependent_count: 0, updated_at: daysAgo(1) },
        ],
      });

      expect(result.status).toBe(0);
      expect(scored[0].type_weight).toBe(0.8);
    });

    test.concurrent('numeric priority displays with P prefix in output', () => {
      const result = runScoringText({
        issues: [
          { id: 'p-prefix', title: 'P prefix test', priority: 2, type: 'bug', status: 'open', dependent_count: 0, updated_at: daysAgo(1) },
        ],
      });

      expect(result.status).toBe(0);
      expect(result.stdout).toContain('(P2 bug)');
      expect(result.stdout).not.toContain('(2 bug)');
    });

    test.concurrent('unknown type defaults to weight 1.0', () => {
      const { result, scored } = runScoringJson({
        issues: [
          { id: 'unk', title: 'Unknown type', priority: 'P2', type: 'chore', status: 'open', dependent_count: 0, updated_at: daysAgo(1) },
        ],
      });

      expect(result.status).toBe(0);
      expect(scored[0].type_weight).toBe(1.0);
    });

    test.concurrent('unknown status defaults to boost 1.0', () => {
      const { result, scored } = runScoringJson({
        issues: [
          { id: 'unk', title: 'Unknown status', priority: 'P2', type: 'feature', status: 'closed', dependent_count: 0, updated_at: daysAgo(1) },
        ],
      });

      expect(result.status).toBe(0);
      expect(scored[0].status_boost).toBe(1.0);
    });
  });
});
