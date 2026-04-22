const { describe, test, expect, setDefaultTimeout, beforeAll, afterAll } = require('bun:test');
const { spawnSync } = require('node:child_process');

const {
  PROJECT_ROOT,
  SCRIPT,
  cleanupTmpDir,
  createMockBd,
  daysAgo,
  parseIssues,
  resolveBashCommand,
  runSmartStatus,
} = require('./smart-status.helpers');

setDefaultTimeout(20000);

const ansiEscapePrefix = '\u001b[';

describe('smart-status.sh', () => {
  describe('grouped output and display behavior', () => {
    let groupedMock;
    let freshMock;
    let colorMock;
    let epicMock;
    let groupedResult;
    let freshResult;
    let colorStdout;
    let epicIssues;

    beforeAll(() => {
      groupedMock = createMockBd({
        issues: [
          { id: 'wip1', title: 'Active work', priority: 'P1', type: 'feature', status: 'in_progress', dependent_count: 0, dependency_count: 0, updated_at: daysAgo(1) },
          { id: 'chain1', title: 'Unblock chain item', priority: 'P2', type: 'feature', status: 'open', dependent_count: 3, dependency_count: 0, updated_at: daysAgo(1) },
          { id: 'ready1', title: 'Ready to go', priority: 'P2', type: 'feature', status: 'open', dependent_count: 0, dependency_count: 0, updated_at: daysAgo(1) },
          { id: 'blocked1', title: 'Blocked item', priority: 'P2', type: 'feature', status: 'open', dependent_count: 0, dependency_count: 2, updated_at: daysAgo(1) },
          { id: 'p4item', title: 'Low priority backlog', priority: 'P4', type: 'task', status: 'open', dependent_count: 0, dependency_count: 0, updated_at: daysAgo(1) },
          { id: 'blocker1', title: 'Blocker', priority: 'P1', type: 'feature', status: 'open', dependent_count: 2, dependency_count: 0, updated_at: daysAgo(1) },
          { id: 'dep-a', title: 'Dep A', priority: 'P2', type: 'task', status: 'open', dependent_count: 0, dependency_count: 1, updated_at: daysAgo(1), dependencies: [{ depends_on_id: 'blocker1' }] },
          { id: 'dep-b', title: 'Dep B', priority: 'P2', type: 'task', status: 'open', dependent_count: 0, dependency_count: 1, updated_at: daysAgo(1), dependencies: [{ depends_on_id: 'blocker1' }] },
          { id: 'stale1', title: 'Stale item', priority: 'P2', type: 'feature', status: 'open', dependent_count: 0, dependency_count: 0, updated_at: daysAgo(14) },
        ],
      });

      freshMock = createMockBd({
        issues: [
          { id: 'fresh1', title: 'Fresh item', priority: 'P2', type: 'feature', status: 'open', dependent_count: 0, dependency_count: 0, updated_at: daysAgo(3) },
        ],
      });

      colorMock = createMockBd({
        issues: [
          { id: 'c1', title: 'Color test', priority: 'P1', type: 'feature', status: 'in_progress', dependent_count: 0, dependency_count: 0, updated_at: daysAgo(1) },
        ],
      });

      epicMock = createMockBd({
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

      groupedResult = runSmartStatus([], { BD_CMD: groupedMock.mockScript, NO_COLOR: '1' });
      freshResult = runSmartStatus([], { BD_CMD: freshMock.mockScript, NO_COLOR: '1' });

      const env = { ...process.env, BD_CMD: colorMock.mockScript, GIT_CMD: 'true' };
      delete env.NO_COLOR;
      colorStdout = (spawnSync(resolveBashCommand(), [SCRIPT], {
        cwd: PROJECT_ROOT,
        encoding: 'utf-8',
        timeout: 15000,
        env,
      }).stdout || '').trim();

      epicIssues = parseIssues(runSmartStatus(['--json'], {
        BD_CMD: epicMock.mockScript,
      }).stdout);
    });

    afterAll(() => {
      cleanupTmpDir(groupedMock?.tmpDir);
      cleanupTmpDir(freshMock?.tmpDir);
      cleanupTmpDir(colorMock?.tmpDir);
      cleanupTmpDir(epicMock?.tmpDir);
    });

    test('in_progress issues appear under RESUME group', () => {
      expect(groupedResult.status).toBe(0);
      expect(groupedResult.stdout).toContain('RESUME');
      expect(groupedResult.stdout.indexOf('wip1')).toBeGreaterThan(groupedResult.stdout.indexOf('RESUME'));
    });

    test('P4 issues appear under BACKLOG group', () => {
      expect(groupedResult.status).toBe(0);
      expect(groupedResult.stdout).toContain('BACKLOG');
      expect(groupedResult.stdout.indexOf('p4item')).toBeGreaterThan(groupedResult.stdout.indexOf('BACKLOG'));
    });

    test('blocked issues (dependency_count > 0, not closed) appear under BLOCKED group', () => {
      expect(groupedResult.status).toBe(0);
      expect(groupedResult.stdout).toContain('BLOCKED');
      expect(groupedResult.stdout.indexOf('blocked1')).toBeGreaterThan(groupedResult.stdout.indexOf('BLOCKED'));
    });

    test('high dependent_count (>=2) non-in_progress issues appear under UNBLOCK CHAINS', () => {
      expect(groupedResult.status).toBe(0);
      expect(groupedResult.stdout).toContain('UNBLOCK CHAINS');
      expect(groupedResult.stdout.indexOf('chain1')).toBeGreaterThan(groupedResult.stdout.indexOf('UNBLOCK CHAINS'));
    });

    test('open issues with no blockers and no dependencies go to READY WORK', () => {
      expect(groupedResult.status).toBe(0);
      expect(groupedResult.stdout).toContain('READY WORK');
      expect(groupedResult.stdout.indexOf('ready1')).toBeGreaterThan(groupedResult.stdout.indexOf('READY WORK'));
    });

    test('group ordering: RESUME > UNBLOCK CHAINS > READY WORK > BLOCKED > BACKLOG', () => {
      expect(groupedResult.status).toBe(0);
      const resumeIdx = groupedResult.stdout.indexOf('RESUME');
      const chainIdx = groupedResult.stdout.indexOf('UNBLOCK CHAINS');
      const readyIdx = groupedResult.stdout.indexOf('READY WORK');
      const blockedIdx = groupedResult.stdout.indexOf('BLOCKED');
      const backlogIdx = groupedResult.stdout.indexOf('BACKLOG');
      expect(resumeIdx).toBeLessThan(chainIdx);
      expect(chainIdx).toBeLessThan(readyIdx);
      expect(readyIdx).toBeLessThan(blockedIdx);
      expect(blockedIdx).toBeLessThan(backlogIdx);
    });

    test('entry format: N. [score] id (priority type) -- title [status Nd]', () => {
      expect(groupedResult.status).toBe(0);
      expect(groupedResult.stdout).toMatch(/ready1\s+\(P2 feature\)\s+--\s+Ready to go\s+\[open \d+d\]/);
    });

    test('unblock chain annotation shows what issue unblocks', () => {
      expect(groupedResult.status).toBe(0);
      expect(groupedResult.stdout).toMatch(/-> Unblocks:/);
      expect(groupedResult.stdout).toContain('dep-a');
      expect(groupedResult.stdout).toContain('dep-b');
    });

    test('stale flag appears for issues older than 7 days', () => {
      expect(groupedResult.status).toBe(0);
      expect(groupedResult.stdout).toMatch(/\[stale 14d\]/);
    });

    test('no stale flag for issues less than 7 days old', () => {
      expect(freshResult.status).toBe(0);
      expect(freshResult.stdout).not.toMatch(/\[stale/);
    });

    test('NO_COLOR disables ANSI escape codes', () => {
      expect(groupedResult.status).toBe(0);
      expect(groupedResult.stdout.includes(ansiEscapePrefix)).toBe(false);
    });

    test('colors are present when NO_COLOR is not set', () => {
      expect(colorStdout.includes(ansiEscapePrefix)).toBe(true);
    });

    test('epic proximity boosts issues near completion', () => {
      const child = epicIssues.find((issue) => issue.id === 'child1');
      expect(child).toBeDefined();
      expect(child.epic_proximity).toBeCloseTo(1.4, 1);
    });

    test('parseIssues rejects malformed issue envelopes', () => {
      expect(() => parseIssues(JSON.stringify({ issues: { id: 'bad-shape' } }))).toThrow(
        /Expected \{sessions, issues\} envelope/,
      );
    });
  });
});
