const { describe, test, expect, beforeAll, setDefaultTimeout } = require('bun:test');

const { scoreIssues } = require('../../lib/smart-status/scoring.js');
const { daysAgo } = require('./smart-status.helpers');
const { runScoringText } = require('./smart-status.scoring.helpers');

setDefaultTimeout(20000);

describe('smart-status edge cases', () => {
  let emptyScored;
  let singleScored;
  let combinedJsonScored;
  let combinedTextResult;

  beforeAll(() => {
    emptyScored = scoreIssues([]);

    singleScored = scoreIssues([
      { id: 'solo', title: 'Solo', priority: 'P3', type: 'feature', status: 'open', dependent_count: 0, updated_at: daysAgo(3) },
    ]);

    combinedJsonScored = scoreIssues([
      { id: 'nodeps', title: 'No deps field', priority: 'P2', type: 'feature', status: 'open', updated_at: daysAgo(1) },
      { id: 'unk-priority', title: 'Unknown pri', priority: 'P9', type: 'feature', status: 'open', dependent_count: 0, updated_at: daysAgo(1) },
      { id: 'num-pri', title: 'Numeric pri', priority: 2, type: 'bug', status: 'open', dependent_count: 0, updated_at: daysAgo(1) },
      { id: 'null-type', title: 'Null type issue', priority: 'P2', type: null, status: 'open', dependent_count: 0, updated_at: daysAgo(1) },
      { id: 'unknown-type', title: 'Unknown type', priority: 'P2', type: 'chore', status: 'open', dependent_count: 0, updated_at: daysAgo(1) },
      { id: 'unknown-status', title: 'Unknown status', priority: 'P2', type: 'feature', status: 'closed', dependent_count: 0, updated_at: daysAgo(1) },
    ]);

    combinedTextResult = runScoringText({
      issues: [
        { id: 'backlog-num', title: 'Backlog numeric', priority: 4, type: 'task', status: 'open', dependent_count: 0, updated_at: daysAgo(1) },
        { id: 'p-prefix', title: 'P prefix test', priority: 2, type: 'bug', status: 'open', dependent_count: 0, updated_at: daysAgo(1) },
      ],
    });
  });

  describe('edge cases', () => {
    test('empty issue list returns empty array', () => {
      expect(emptyScored).toEqual([]);
    });

    test('single issue returns array with one scored item', () => {
      expect(singleScored.length).toBe(1);
      expect(singleScored[0].id).toBe('solo');
      expect(singleScored[0].priority_weight).toBe(2);
      expect(singleScored[0].type_weight).toBe(1);
      expect(singleScored[0].status_boost).toBe(1);
      expect(singleScored[0].staleness_boost).toBe(1);
    });

    test('missing dependent_count defaults to 0 (chain=1)', () => {
      expect(combinedJsonScored.find((issue) => issue.id === 'nodeps').unblock_chain).toBe(1);
    });

    test('unknown priority defaults to weight 1', () => {
      expect(combinedJsonScored.find((issue) => issue.id === 'unk-priority').priority_weight).toBe(1);
    });

    test('numeric priority 2 gets same weight as P2', () => {
      expect(combinedJsonScored.find((issue) => issue.id === 'num-pri').priority_weight).toBe(3);
    });

    test('numeric priority 4 is grouped into BACKLOG', () => {
      expect(combinedTextResult.status).toBe(0);
      expect(combinedTextResult.stdout).toContain('BACKLOG');
    });

    test('null type defaults to task weight 0.8', () => {
      expect(combinedJsonScored.find((issue) => issue.id === 'null-type').type_weight).toBe(0.8);
    });

    test('numeric priority displays with P prefix in output', () => {
      expect(combinedTextResult.status).toBe(0);
      expect(combinedTextResult.stdout).toContain('(P2 bug)');
      expect(combinedTextResult.stdout).not.toContain('(2 bug)');
    });

    test('unknown type defaults to weight 1.0', () => {
      expect(combinedJsonScored.find((issue) => issue.id === 'unknown-type').type_weight).toBe(1);
    });

    test('unknown status defaults to boost 1.0', () => {
      expect(combinedJsonScored.find((issue) => issue.id === 'unknown-status').status_boost).toBe(1);
    });
  });
});
