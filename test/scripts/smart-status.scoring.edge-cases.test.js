const { describe, test, expect, beforeAll, setDefaultTimeout } = require('bun:test');

const { daysAgo } = require('./smart-status.helpers');
const { runScoringJson, runScoringText } = require('./smart-status.scoring.helpers');

setDefaultTimeout(20000);

describe('smart-status.sh', () => {
  let emptyResult;
  let emptyScored;
  let singleResult;
  let singleScored;
  let combinedJsonResult;
  let combinedJsonScored;
  let combinedTextResult;

  beforeAll(() => {
    ({ result: emptyResult, scored: emptyScored } = runScoringJson({ issues: [] }));

    ({ result: singleResult, scored: singleScored } = runScoringJson({
      issues: [
        { id: 'solo', title: 'Solo', priority: 'P3', type: 'feature', status: 'open', dependent_count: 0, updated_at: daysAgo(3) },
      ],
    }));

    ({ result: combinedJsonResult, scored: combinedJsonScored } = runScoringJson({
      issues: [
        { id: 'nodeps', title: 'No deps field', priority: 'P2', type: 'feature', status: 'open', updated_at: daysAgo(1) },
        { id: 'unk-priority', title: 'Unknown pri', priority: 'P9', type: 'feature', status: 'open', dependent_count: 0, updated_at: daysAgo(1) },
        { id: 'num-pri', title: 'Numeric pri', priority: 2, type: 'bug', status: 'open', dependent_count: 0, updated_at: daysAgo(1) },
        { id: 'null-type', title: 'Null type issue', priority: 'P2', type: null, status: 'open', dependent_count: 0, updated_at: daysAgo(1) },
        { id: 'unknown-type', title: 'Unknown type', priority: 'P2', type: 'chore', status: 'open', dependent_count: 0, updated_at: daysAgo(1) },
        { id: 'unknown-status', title: 'Unknown status', priority: 'P2', type: 'feature', status: 'closed', dependent_count: 0, updated_at: daysAgo(1) },
      ],
    }));

    combinedTextResult = runScoringText({
      issues: [
        { id: 'backlog-num', title: 'Backlog numeric', priority: 4, type: 'task', status: 'open', dependent_count: 0, updated_at: daysAgo(1) },
        { id: 'p-prefix', title: 'P prefix test', priority: 2, type: 'bug', status: 'open', dependent_count: 0, updated_at: daysAgo(1) },
      ],
    });
  });

  describe('edge cases', () => {
    test.concurrent('empty issue list returns empty array', () => {
      expect(emptyResult.status).toBe(0);
      expect(emptyScored).toEqual([]);
    });

    test.concurrent('single issue returns array with one scored item', () => {
      expect(singleResult.status).toBe(0);
      expect(singleScored.length).toBe(1);
      expect(singleScored[0].id).toBe('solo');
      expect(singleScored[0].priority_weight).toBe(2);
      expect(singleScored[0].type_weight).toBe(1.0);
      expect(singleScored[0].status_boost).toBe(1.0);
      expect(singleScored[0].staleness_boost).toBe(1.0);
    });

    test.concurrent('missing dependent_count defaults to 0 (chain=1)', () => {
      expect(combinedJsonResult.status).toBe(0);
      expect(combinedJsonScored.find((issue) => issue.id === 'nodeps').unblock_chain).toBe(1);
    });

    test.concurrent('unknown priority defaults to weight 1', () => {
      expect(combinedJsonResult.status).toBe(0);
      expect(combinedJsonScored.find((issue) => issue.id === 'unk-priority').priority_weight).toBe(1);
    });

    test.concurrent('numeric priority 2 gets same weight as P2', () => {
      expect(combinedJsonResult.status).toBe(0);
      expect(combinedJsonScored.find((issue) => issue.id === 'num-pri').priority_weight).toBe(3);
    });

    test.concurrent('numeric priority 4 is grouped into BACKLOG', () => {
      expect(combinedTextResult.status).toBe(0);
      expect(combinedTextResult.stdout).toContain('BACKLOG');
    });

    test.concurrent('null type defaults to task weight 0.8', () => {
      expect(combinedJsonResult.status).toBe(0);
      expect(combinedJsonScored.find((issue) => issue.id === 'null-type').type_weight).toBe(0.8);
    });

    test.concurrent('numeric priority displays with P prefix in output', () => {
      expect(combinedTextResult.status).toBe(0);
      expect(combinedTextResult.stdout).toContain('(P2 bug)');
      expect(combinedTextResult.stdout).not.toContain('(2 bug)');
    });

    test.concurrent('unknown type defaults to weight 1.0', () => {
      expect(combinedJsonResult.status).toBe(0);
      expect(combinedJsonScored.find((issue) => issue.id === 'unknown-type').type_weight).toBe(1.0);
    });

    test.concurrent('unknown status defaults to boost 1.0', () => {
      expect(combinedJsonResult.status).toBe(0);
      expect(combinedJsonScored.find((issue) => issue.id === 'unknown-status').status_boost).toBe(1.0);
    });
  });
});
