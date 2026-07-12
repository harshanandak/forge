'use strict';

const { describe, test, expect } = require('bun:test');
const {
  formatRunNextLines,
  formatZeroArgStatus,
  buildPersonalStatusJson,
} = require('../../lib/status/presenter.js');

function workflowResult(overrides = {}) {
  return {
    stageId: 'ship',
    stageName: 'Shipping',
    runCommand: 'ship',
    nextCommand: 'review',
    nextStages: ['review'],
    workflowState: {
      completedStages: ['plan', 'dev', 'validate'],
      workflowDecisions: { classification: 'standard' },
    },
    ...overrides,
  };
}

const baseContext = {
  branch: 'feat/x',
  inWorktree: true,
  worktreePath: '/repo/.worktrees/x',
  mainWorktree: '/repo',
  workingTree: { clean: true, summary: 'clean' },
};

describe('formatRunNextLines', () => {
  test('emits Run-now and Next-after-this when a next command exists', () => {
    expect(formatRunNextLines(workflowResult())).toEqual([
      'Run now: /ship',
      'Next after this: /review',
    ]);
  });

  test('omits Next-after-this by default at a terminal stage', () => {
    expect(formatRunNextLines(workflowResult({ nextCommand: null }))).toEqual(['Run now: /ship']);
  });

  test('emits explicit none at a terminal stage when asked', () => {
    expect(formatRunNextLines(workflowResult({ nextCommand: null }), { noneWhenMissing: true }))
      .toEqual(['Run now: /ship', 'Next after this: none']);
  });
});

describe('formatZeroArgStatus — one-glance view', () => {
  const snapshot = {
    activeAssigned: [{ id: 'forge-abc', title: 'Do the thing', status: 'in_progress' }],
    ready: [{ id: 'forge-r1', title: 'Ready one' }, { id: 'forge-r2', title: 'Ready two' }],
    blocked: [{ id: 'forge-b', title: 'Blocked', status: 'open' }],
    stale: [{ id: 'forge-s', title: 'Stale', status: 'open' }],
    recentCompleted: [{ id: 'forge-d', title: 'Done' }],
  };

  test('renders the four blocks in order with a canonical stage heading', () => {
    const out = formatZeroArgStatus({ context: baseContext, snapshot, workflowResult: workflowResult() });
    expect(out.indexOf('You are here')).toBeLessThan(out.indexOf('Context'));
    expect(out.indexOf('Context')).toBeLessThan(out.indexOf('Your work'));
    expect(out.indexOf('Your work')).toBeLessThan(out.indexOf('New here?'));
    expect(out).toContain('Stage 4 of 5 — Ship (standard workflow)');
    expect(out).toContain('Run now: /ship');
    expect(out).toContain('Next after this: /review');
    expect(out).toContain('Why: validation passed; PR not yet created.');
    expect(out).toContain('feat/x — worktree, clean');
    expect(out).toContain('Active: forge-abc Do the thing [in_progress]');
    expect(out).toContain('Ready: 2 more (forge issue ready)');
  });

  test('hides blocked/stale/recent detail unless --full', () => {
    const compact = formatZeroArgStatus({ context: baseContext, snapshot, workflowResult: workflowResult() });
    expect(compact).not.toContain('Blocked');
    expect(compact).not.toContain('Recent Completions');

    const full = formatZeroArgStatus({ context: baseContext, snapshot, workflowResult: workflowResult(), full: true });
    expect(full).toContain('Blocked');
    expect(full).toContain('Stale');
    expect(full).toContain('Recent Completions');
    expect(full).toContain('forge-b');
  });

  test('state-aware fallback points at the top ready issue when no workflow is active', () => {
    const out = formatZeroArgStatus({ context: baseContext, snapshot, workflowResult: null });
    expect(out).toContain('You are here');
    expect(out).toContain('No active workflow. Next: forge claim forge-r1, then /plan (or /dev for a small fix).');
  });

  test('state-aware fallback points at /plan when nothing is ready', () => {
    const out = formatZeroArgStatus({
      context: baseContext,
      snapshot: { activeAssigned: [], ready: [] },
      workflowResult: null,
    });
    expect(out).toContain('No active workflow and no ready issues. Next: /plan "<describe the feature>" to start one.');
    expect(out).toContain('Active: none');
    expect(out).toContain('Ready: none');
  });

  test('Why falls back gracefully with no completed stages', () => {
    const wr = workflowResult({ workflowState: { completedStages: [], workflowDecisions: { classification: 'standard' } } });
    const out = formatZeroArgStatus({ context: baseContext, snapshot, workflowResult: wr });
    expect(out).toContain('Why: just getting started.');
  });
});

describe('buildPersonalStatusJson stays full-fidelity (machine consumers)', () => {
  test('keeps all personal sections regardless of the text view collapse', () => {
    const json = buildPersonalStatusJson({
      context: baseContext,
      snapshot: {
        activeAssigned: [{ id: 'a', title: 'A' }],
        ready: [{ id: 'r', title: 'R' }],
        blocked: [{ id: 'b', title: 'B' }],
        stale: [{ id: 's', title: 'S' }],
        parked: [{ id: 'p', title: 'P' }],
        recentCompleted: [{ id: 'd', title: 'D' }],
      },
      workflowResult: workflowResult(),
    });
    expect(json.personal.blocked.map(i => i.id)).toEqual(['b']);
    expect(json.personal.parked.map(i => i.id)).toEqual(['p']);
    expect(json.personal.recentCompleted.map(i => i.id)).toEqual(['d']);
    expect(json.workflow.runCommand).toBe('ship');
  });
});
