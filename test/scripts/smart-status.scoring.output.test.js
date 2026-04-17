const { describe, test, expect, setDefaultTimeout } = require('bun:test');
const { spawnSync } = require('node:child_process');

const {
  PROJECT_ROOT,
  SCRIPT,
  cleanupTmpDir,
  createMockBd,
  daysAgo,
  resolveBashCommand,
} = require('./smart-status.helpers');
const { runScoringJson, runScoringText } = require('./smart-status.scoring.helpers');

setDefaultTimeout(20000);

describe('smart-status.sh', () => {
  describe('grouped output', () => {
    test.concurrent('in_progress issues appear under RESUME group', () => {
      const result = runScoringText({
        issues: [
          { id: 'wip1', title: 'Active work', priority: 'P1', type: 'feature', status: 'in_progress', dependent_count: 0, updated_at: daysAgo(1) },
          { id: 'open1', title: 'Open work', priority: 'P2', type: 'feature', status: 'open', dependent_count: 0, updated_at: daysAgo(1) },
        ],
      }, { NO_COLOR: '1' });

      expect(result.status).toBe(0);
      expect(result.stdout).toContain('RESUME');
      expect(result.stdout.indexOf('wip1')).toBeGreaterThan(result.stdout.indexOf('RESUME'));
    });

    test.concurrent('P4 issues appear under BACKLOG group', () => {
      const result = runScoringText({
        issues: [
          { id: 'p4item', title: 'Low priority backlog', priority: 'P4', type: 'task', status: 'open', dependent_count: 0, updated_at: daysAgo(1) },
        ],
      }, { NO_COLOR: '1' });

      expect(result.status).toBe(0);
      expect(result.stdout).toContain('BACKLOG');
      expect(result.stdout.indexOf('p4item')).toBeGreaterThan(result.stdout.indexOf('BACKLOG'));
    });

    test.concurrent('blocked issues (dependency_count > 0, not closed) appear under BLOCKED group', () => {
      const result = runScoringText({
        issues: [
          { id: 'blocked1', title: 'Blocked item', priority: 'P2', type: 'feature', status: 'open', dependent_count: 0, dependency_count: 2, updated_at: daysAgo(1) },
        ],
      }, { NO_COLOR: '1' });

      expect(result.status).toBe(0);
      expect(result.stdout).toContain('BLOCKED');
      expect(result.stdout.indexOf('blocked1')).toBeGreaterThan(result.stdout.indexOf('BLOCKED'));
    });

    test.concurrent('high dependent_count (>=2) non-in_progress issues appear under UNBLOCK CHAINS', () => {
      const result = runScoringText({
        issues: [
          { id: 'chain1', title: 'Unblock chain item', priority: 'P2', type: 'feature', status: 'open', dependent_count: 3, dependency_count: 0, updated_at: daysAgo(1) },
        ],
      }, { NO_COLOR: '1' });

      expect(result.status).toBe(0);
      expect(result.stdout).toContain('UNBLOCK CHAINS');
      expect(result.stdout.indexOf('chain1')).toBeGreaterThan(result.stdout.indexOf('UNBLOCK CHAINS'));
    });

    test.concurrent('open issues with no blockers and no dependencies go to READY WORK', () => {
      const result = runScoringText({
        issues: [
          { id: 'ready1', title: 'Ready to go', priority: 'P2', type: 'feature', status: 'open', dependent_count: 0, dependency_count: 0, updated_at: daysAgo(1) },
        ],
      }, { NO_COLOR: '1' });

      expect(result.status).toBe(0);
      expect(result.stdout).toContain('READY WORK');
      expect(result.stdout.indexOf('ready1')).toBeGreaterThan(result.stdout.indexOf('READY WORK'));
    });

    test.concurrent('group ordering: RESUME > UNBLOCK CHAINS > READY WORK > BLOCKED > BACKLOG', () => {
      const result = runScoringText({
        issues: [
          { id: 'wip', title: 'WIP', priority: 'P1', type: 'feature', status: 'in_progress', dependent_count: 0, dependency_count: 0, updated_at: daysAgo(1) },
          { id: 'chain', title: 'Chain', priority: 'P2', type: 'feature', status: 'open', dependent_count: 3, dependency_count: 0, updated_at: daysAgo(1) },
          { id: 'ready', title: 'Ready', priority: 'P2', type: 'feature', status: 'open', dependent_count: 0, dependency_count: 0, updated_at: daysAgo(1) },
          { id: 'blocked', title: 'Blocked', priority: 'P2', type: 'feature', status: 'open', dependent_count: 0, dependency_count: 1, updated_at: daysAgo(1) },
          { id: 'backlog', title: 'Backlog', priority: 'P4', type: 'task', status: 'open', dependent_count: 0, dependency_count: 0, updated_at: daysAgo(1) },
        ],
      }, { NO_COLOR: '1' });

      expect(result.status).toBe(0);
      const resumeIdx = result.stdout.indexOf('RESUME');
      const chainIdx = result.stdout.indexOf('UNBLOCK CHAINS');
      const readyIdx = result.stdout.indexOf('READY WORK');
      const blockedIdx = result.stdout.indexOf('BLOCKED');
      const backlogIdx = result.stdout.indexOf('BACKLOG');
      expect(resumeIdx).toBeLessThan(chainIdx);
      expect(chainIdx).toBeLessThan(readyIdx);
      expect(readyIdx).toBeLessThan(blockedIdx);
      expect(blockedIdx).toBeLessThan(backlogIdx);
    });

    test.concurrent('entry format: N. [score] id (priority type) -- title [status Nd]', () => {
      const result = runScoringText({
        issues: [
          { id: 'fmt1', title: 'Format test', priority: 'P1', type: 'bug', status: 'open', dependent_count: 0, dependency_count: 0, updated_at: daysAgo(3) },
        ],
      }, { NO_COLOR: '1' });

      expect(result.status).toBe(0);
      expect(result.stdout).toMatch(/1\.\s+\[\d+(\.\d+)?\]\s+fmt1\s+\(P1 bug\)\s+--\s+Format test\s+\[open \d+d\]/);
    });

    test.concurrent('unblock chain annotation shows what issue unblocks', () => {
      const result = runScoringText({
        issues: [
          { id: 'blocker1', title: 'Blocker', priority: 'P1', type: 'feature', status: 'open', dependent_count: 2, dependency_count: 0, updated_at: daysAgo(1) },
          { id: 'dep-a', title: 'Dep A', priority: 'P2', type: 'task', status: 'open', dependent_count: 0, dependency_count: 1, updated_at: daysAgo(1), dependencies: [{ depends_on_id: 'blocker1' }] },
          { id: 'dep-b', title: 'Dep B', priority: 'P2', type: 'task', status: 'open', dependent_count: 0, dependency_count: 1, updated_at: daysAgo(1), dependencies: [{ depends_on_id: 'blocker1' }] },
        ],
      }, { NO_COLOR: '1' });

      expect(result.status).toBe(0);
      expect(result.stdout).toMatch(/-> Unblocks:/);
      expect(result.stdout).toContain('dep-a');
      expect(result.stdout).toContain('dep-b');
    });
  });

  describe('staleness flag', () => {
    test.concurrent('stale flag appears for issues older than 7 days', () => {
      const result = runScoringText({
        issues: [
          { id: 'stale1', title: 'Stale item', priority: 'P2', type: 'feature', status: 'open', dependent_count: 0, dependency_count: 0, updated_at: daysAgo(14) },
        ],
      }, { NO_COLOR: '1' });

      expect(result.status).toBe(0);
      expect(result.stdout).toMatch(/\[stale 14d\]/);
    });

    test.concurrent('no stale flag for issues less than 7 days old', () => {
      const result = runScoringText({
        issues: [
          { id: 'fresh1', title: 'Fresh item', priority: 'P2', type: 'feature', status: 'open', dependent_count: 0, dependency_count: 0, updated_at: daysAgo(3) },
        ],
      }, { NO_COLOR: '1' });

      expect(result.status).toBe(0);
      expect(result.stdout).not.toMatch(/\[stale/);
    });
  });

  describe('NO_COLOR support', () => {
    test.concurrent('NO_COLOR disables ANSI escape codes', () => {
      const result = runScoringText({
        issues: [
          { id: 'nc1', title: 'No color test', priority: 'P1', type: 'feature', status: 'in_progress', dependent_count: 0, dependency_count: 0, updated_at: daysAgo(1) },
        ],
      }, { NO_COLOR: '1' });

      expect(result.status).toBe(0);
      expect(result.stdout).not.toMatch(/\x1b\[/);
    });

    test.concurrent('colors are present when NO_COLOR is not set', () => {
      const { tmpDir, mockScript } = createMockBd({
        issues: [
          { id: 'c1', title: 'Color test', priority: 'P1', type: 'feature', status: 'in_progress', dependent_count: 0, dependency_count: 0, updated_at: daysAgo(1) },
        ],
      });

      try {
        const env = { ...process.env, BD_CMD: mockScript, GIT_CMD: 'true' };
        delete env.NO_COLOR;

        const result = spawnSync(resolveBashCommand(), [SCRIPT], {
          cwd: PROJECT_ROOT,
          encoding: 'utf-8',
          timeout: 15000,
          env,
        });

        expect((result.stdout || '').trim()).toMatch(/\x1b\[/);
      } finally {
        cleanupTmpDir(tmpDir);
      }
    });
  });

  describe('epic_proximity', () => {
    test.concurrent('epic proximity boosts issues near completion', () => {
      const { result, scored } = runScoringJson({
        issues: [
          { id: 'epic1', title: 'Epic 1', priority: 'P2', type: 'epic', status: 'open', dependent_count: 0, updated_at: daysAgo(1) },
          { id: 'child1', title: 'Child 1', priority: 'P2', type: 'feature', status: 'open', dependent_count: 0, updated_at: daysAgo(1), parent_id: 'epic1' },
        ],
        epicChildren: [
          {
            id: 'epic1',
            children: [
              { id: 'c1', status: 'closed' },
              { id: 'c2', status: 'closed' },
              { id: 'c3', status: 'closed' },
              { id: 'c4', status: 'closed' },
              { id: 'child1', status: 'open' },
            ],
          },
        ],
      });

      expect(result.status).toBe(0);
      const child = scored.find((issue) => issue.id === 'child1');
      expect(child).toBeDefined();
      expect(child.epic_proximity).toBeCloseTo(1.4, 1);
    });
  });
});
