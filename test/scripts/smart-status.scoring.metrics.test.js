const { describe, test, expect, beforeAll, setDefaultTimeout } = require('bun:test');

const { daysAgo } = require('./smart-status.helpers');
const { runScoringJson } = require('./smart-status.scoring.helpers');

setDefaultTimeout(20000);

describe('smart-status.sh', () => {
  let factorResult;
  let factorScored;
  let compositeResult;
  let compositeScored;
  let breakdownResult;
  let breakdownItem;

  beforeAll(() => {
    ({ result: factorResult, scored: factorScored } = runScoringJson({
      issues: [
        { id: 'p4', title: 'P4 issue', priority: 'P4', type: 'feature', status: 'open', dependent_count: 0, updated_at: daysAgo(1) },
        { id: 'p0', title: 'P0 issue', priority: 'P0', type: 'feature', status: 'open', dependent_count: 0, updated_at: daysAgo(1) },
        { id: 'p2', title: 'P2 issue', priority: 'P2', type: 'feature', status: 'open', dependent_count: 0, updated_at: daysAgo(1) },
        { id: 'task1', title: 'Task', priority: 'P2', type: 'task', status: 'open', dependent_count: 0, updated_at: daysAgo(1) },
        { id: 'bug1', title: 'Bug', priority: 'P2', type: 'bug', status: 'open', dependent_count: 0, updated_at: daysAgo(1) },
        { id: 'feat1', title: 'Feature', priority: 'P2', type: 'feature', status: 'open', dependent_count: 0, updated_at: daysAgo(1) },
        { id: 'open1', title: 'Open', priority: 'P2', type: 'feature', status: 'open', dependent_count: 0, updated_at: daysAgo(1) },
        { id: 'wip1', title: 'WIP', priority: 'P2', type: 'feature', status: 'in_progress', dependent_count: 0, updated_at: daysAgo(1) },
        { id: 'low', title: 'Low deps', priority: 'P2', type: 'feature', status: 'open', dependent_count: 0, updated_at: daysAgo(1) },
        { id: 'high', title: 'High deps', priority: 'P2', type: 'feature', status: 'open', dependent_count: 5, updated_at: daysAgo(1) },
        { id: 'fresh', title: 'Fresh', priority: 'P2', type: 'feature', status: 'open', dependent_count: 0, updated_at: daysAgo(1) },
        { id: 'medium', title: 'Medium', priority: 'P2', type: 'feature', status: 'open', dependent_count: 0, updated_at: daysAgo(20) },
        { id: 'stale', title: 'Stale', priority: 'P2', type: 'feature', status: 'open', dependent_count: 0, updated_at: daysAgo(35) },
      ],
    }));

    ({ result: compositeResult, scored: compositeScored } = runScoringJson({
      issues: [
        { id: 'x', title: 'X', priority: 'P4', type: 'bug', status: 'in_progress', dependent_count: 3, updated_at: daysAgo(35) },
        { id: 'y', title: 'Y', priority: 'P0', type: 'feature', status: 'open', dependent_count: 0, updated_at: daysAgo(1) },
        { id: 'z', title: 'Z', priority: 'P1', type: 'task', status: 'open', dependent_count: 10, updated_at: daysAgo(10) },
      ],
    }));

    ({ result: breakdownResult, scored: [breakdownItem] } = runScoringJson({
      issues: [
        { id: 'a', title: 'A', priority: 'P2', type: 'bug', status: 'in_progress', dependent_count: 2, updated_at: daysAgo(10) },
      ],
    }));
  });

  describe('scoring factors', () => {
    test.concurrent('priority_weight: P0=5 > P1=4 > P2=3 > P3=2 > P4=1', () => {
      expect(factorResult.status).toBe(0);
      expect(factorScored.find((issue) => issue.id === 'p0').priority_weight).toBe(5);
      expect(factorScored.find((issue) => issue.id === 'p2').priority_weight).toBe(3);
      expect(factorScored.find((issue) => issue.id === 'p4').priority_weight).toBe(1);
      expect(factorScored.findIndex((issue) => issue.id === 'p0'))
        .toBeLessThan(factorScored.findIndex((issue) => issue.id === 'p2'));
      expect(factorScored.findIndex((issue) => issue.id === 'p2'))
        .toBeLessThan(factorScored.findIndex((issue) => issue.id === 'p4'));
    });

    test.concurrent('type_weight: bug=1.2 > feature=1.0 > task=0.8', () => {
      expect(factorResult.status).toBe(0);
      expect(factorScored.find((issue) => issue.id === 'bug1').type_weight).toBe(1.2);
      expect(factorScored.find((issue) => issue.id === 'feat1').type_weight).toBe(1.0);
      expect(factorScored.find((issue) => issue.id === 'task1').type_weight).toBe(0.8);
      expect(factorScored.findIndex((issue) => issue.id === 'bug1'))
        .toBeLessThan(factorScored.findIndex((issue) => issue.id === 'feat1'));
      expect(factorScored.findIndex((issue) => issue.id === 'feat1'))
        .toBeLessThan(factorScored.findIndex((issue) => issue.id === 'task1'));
    });

    test.concurrent('status_boost: in_progress=1.5 > open=1.0', () => {
      expect(factorResult.status).toBe(0);
      expect(factorScored.find((issue) => issue.id === 'wip1').status_boost).toBe(1.5);
      expect(factorScored.find((issue) => issue.id === 'open1').status_boost).toBe(1.0);
      expect(factorScored.findIndex((issue) => issue.id === 'wip1'))
        .toBeLessThan(factorScored.findIndex((issue) => issue.id === 'open1'));
    });

    test.concurrent('unblock_chain: higher dependent_count scores higher', () => {
      expect(factorResult.status).toBe(0);
      expect(factorScored.find((issue) => issue.id === 'high').unblock_chain).toBe(6);
      expect(factorScored.find((issue) => issue.id === 'low').unblock_chain).toBe(1);
      expect(factorScored.findIndex((issue) => issue.id === 'high'))
        .toBeLessThan(factorScored.findIndex((issue) => issue.id === 'low'));
    });

    test.concurrent('staleness_boost: older issues score higher', () => {
      expect(factorResult.status).toBe(0);
      expect(factorScored.find((issue) => issue.id === 'stale').staleness_boost).toBe(1.5);
      expect(factorScored.find((issue) => issue.id === 'medium').staleness_boost).toBe(1.2);
      expect(factorScored.find((issue) => issue.id === 'fresh').staleness_boost).toBe(1.0);
      expect(factorScored.findIndex((issue) => issue.id === 'stale'))
        .toBeLessThan(factorScored.findIndex((issue) => issue.id === 'medium'));
      expect(factorScored.findIndex((issue) => issue.id === 'medium'))
        .toBeLessThan(factorScored.findIndex((issue) => issue.id === 'fresh'));
    });
  });

  describe('composite scoring and sorting', () => {
    test.concurrent('sorts by composite score descending with mixed factors', () => {
      expect(compositeResult.status).toBe(0);
      expect(compositeScored.length).toBe(3);
      expect(compositeScored[0].id).toBe('z');
      expect(compositeScored[1].id).toBe('x');
      expect(compositeScored[2].id).toBe('y');
      expect(compositeScored[0]).toHaveProperty('score');
      expect(compositeScored[0]).toHaveProperty('priority_weight');
      expect(compositeScored[0]).toHaveProperty('unblock_chain');
      expect(compositeScored[0]).toHaveProperty('type_weight');
      expect(compositeScored[0]).toHaveProperty('status_boost');
      expect(compositeScored[0]).toHaveProperty('staleness_boost');
    });

    test.concurrent('each scored item includes score breakdown fields', () => {
      expect(breakdownResult.status).toBe(0);
      expect(breakdownItem.priority_weight).toBe(3);
      expect(breakdownItem.unblock_chain).toBe(3);
      expect(breakdownItem.type_weight).toBe(1.2);
      expect(breakdownItem.status_boost).toBe(1.5);
      expect(breakdownItem.staleness_boost).toBe(1.1);
      expect(breakdownItem.score).toBeCloseTo(17.82, 1);
    });
  });
});
