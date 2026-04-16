const fs = require('node:fs');
const path = require('node:path');
const { describe, test, expect, setDefaultTimeout } = require('bun:test');
const { spawnSync } = require('node:child_process');

const {
  BASH_PATH_ENV,
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

describe('smart-status.sh', () => {
  describe('scoring factors', () => {
    test('priority_weight: P0=5 > P1=4 > P2=3 > P3=2 > P4=1', () => {
      const mockData = {
        issues: [
          { id: 'a', title: 'P4 issue', priority: 'P4', type: 'feature', status: 'open', dependent_count: 0, updated_at: daysAgo(1) },
          { id: 'b', title: 'P0 issue', priority: 'P0', type: 'feature', status: 'open', dependent_count: 0, updated_at: daysAgo(1) },
          { id: 'c', title: 'P2 issue', priority: 'P2', type: 'feature', status: 'open', dependent_count: 0, updated_at: daysAgo(1) },
        ],
      };
      const { tmpDir, mockScript } = createMockBd(mockData);
      try {
        const result = runSmartStatus(['--json'], { BD_CMD: mockScript });
        expect(result.status).toBe(0);
        const scored = parseIssues(result.stdout);
        expect(scored[0].id).toBe('b');
        expect(scored[1].id).toBe('c');
        expect(scored[2].id).toBe('a');
      } finally {
        cleanupTmpDir(tmpDir);
      }
    });

    test('type_weight: bug=1.2 > feature=1.0 > task=0.8', () => {
      const mockData = {
        issues: [
          { id: 'task1', title: 'Task', priority: 'P2', type: 'task', status: 'open', dependent_count: 0, updated_at: daysAgo(1) },
          { id: 'bug1', title: 'Bug', priority: 'P2', type: 'bug', status: 'open', dependent_count: 0, updated_at: daysAgo(1) },
          { id: 'feat1', title: 'Feature', priority: 'P2', type: 'feature', status: 'open', dependent_count: 0, updated_at: daysAgo(1) },
        ],
      };
      const { tmpDir, mockScript } = createMockBd(mockData);
      try {
        const result = runSmartStatus(['--json'], { BD_CMD: mockScript });
        expect(result.status).toBe(0);
        const scored = parseIssues(result.stdout);
        expect(scored[0].id).toBe('bug1');
        expect(scored[1].id).toBe('feat1');
        expect(scored[2].id).toBe('task1');
      } finally {
        cleanupTmpDir(tmpDir);
      }
    });

    test('status_boost: in_progress=1.5 > open=1.0', () => {
      const mockData = {
        issues: [
          { id: 'open1', title: 'Open', priority: 'P2', type: 'feature', status: 'open', dependent_count: 0, updated_at: daysAgo(1) },
          { id: 'wip1', title: 'WIP', priority: 'P2', type: 'feature', status: 'in_progress', dependent_count: 0, updated_at: daysAgo(1) },
        ],
      };
      const { tmpDir, mockScript } = createMockBd(mockData);
      try {
        const result = runSmartStatus(['--json'], { BD_CMD: mockScript });
        expect(result.status).toBe(0);
        const scored = parseIssues(result.stdout);
        expect(scored[0].id).toBe('wip1');
        expect(scored[1].id).toBe('open1');
      } finally {
        cleanupTmpDir(tmpDir);
      }
    });

    test('unblock_chain: higher dependent_count scores higher', () => {
      const mockData = {
        issues: [
          { id: 'low', title: 'Low deps', priority: 'P2', type: 'feature', status: 'open', dependent_count: 0, updated_at: daysAgo(1) },
          { id: 'high', title: 'High deps', priority: 'P2', type: 'feature', status: 'open', dependent_count: 5, updated_at: daysAgo(1) },
        ],
      };
      const { tmpDir, mockScript } = createMockBd(mockData);
      try {
        const result = runSmartStatus(['--json'], { BD_CMD: mockScript });
        expect(result.status).toBe(0);
        const scored = parseIssues(result.stdout);
        expect(scored[0].id).toBe('high');
        expect(scored[1].id).toBe('low');
      } finally {
        cleanupTmpDir(tmpDir);
      }
    });

    test('staleness_boost: older issues score higher', () => {
      const mockData = {
        issues: [
          { id: 'fresh', title: 'Fresh', priority: 'P2', type: 'feature', status: 'open', dependent_count: 0, updated_at: daysAgo(1) },
          { id: 'stale', title: 'Stale', priority: 'P2', type: 'feature', status: 'open', dependent_count: 0, updated_at: daysAgo(35) },
          { id: 'medium', title: 'Medium', priority: 'P2', type: 'feature', status: 'open', dependent_count: 0, updated_at: daysAgo(20) },
        ],
      };
      const { tmpDir, mockScript } = createMockBd(mockData);
      try {
        const result = runSmartStatus(['--json'], { BD_CMD: mockScript });
        expect(result.status).toBe(0);
        const scored = parseIssues(result.stdout);
        expect(scored[0].id).toBe('stale');
        expect(scored[1].id).toBe('medium');
        expect(scored[2].id).toBe('fresh');
      } finally {
        cleanupTmpDir(tmpDir);
      }
    });
  });

  describe('composite scoring and sorting', () => {
    test('sorts by composite score descending with mixed factors', () => {
      const mockData = {
        issues: [
          { id: 'x', title: 'X', priority: 'P4', type: 'bug', status: 'in_progress', dependent_count: 3, updated_at: daysAgo(35) },
          { id: 'y', title: 'Y', priority: 'P0', type: 'feature', status: 'open', dependent_count: 0, updated_at: daysAgo(1) },
          { id: 'z', title: 'Z', priority: 'P1', type: 'task', status: 'open', dependent_count: 10, updated_at: daysAgo(10) },
        ],
      };
      const { tmpDir, mockScript } = createMockBd(mockData);
      try {
        const result = runSmartStatus(['--json'], { BD_CMD: mockScript });
        expect(result.status).toBe(0);
        const scored = parseIssues(result.stdout);
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
      } finally {
        cleanupTmpDir(tmpDir);
      }
    });

    test('each scored item includes score breakdown fields', () => {
      const mockData = {
        issues: [
          { id: 'a', title: 'A', priority: 'P2', type: 'bug', status: 'in_progress', dependent_count: 2, updated_at: daysAgo(10) },
        ],
      };
      const { tmpDir, mockScript } = createMockBd(mockData);
      try {
        const result = runSmartStatus(['--json'], { BD_CMD: mockScript });
        expect(result.status).toBe(0);
        const scored = parseIssues(result.stdout);
        const item = scored[0];
        expect(item.priority_weight).toBe(3);
        expect(item.unblock_chain).toBe(3);
        expect(item.type_weight).toBe(1.2);
        expect(item.status_boost).toBe(1.5);
        expect(item.staleness_boost).toBe(1.1);
        expect(item.score).toBeCloseTo(17.82, 1);
      } finally {
        cleanupTmpDir(tmpDir);
      }
    });
  });

  describe('edge cases', () => {
    test('empty issue list returns empty array', () => {
      const mockData = { issues: [] };
      const { tmpDir, mockScript } = createMockBd(mockData);
      try {
        const result = runSmartStatus(['--json'], { BD_CMD: mockScript });
        expect(result.status).toBe(0);
        const scored = parseIssues(result.stdout);
        expect(scored).toEqual([]);
      } finally {
        cleanupTmpDir(tmpDir);
      }
    });

    test('single issue returns array with one scored item', () => {
      const mockData = {
        issues: [
          { id: 'solo', title: 'Solo', priority: 'P3', type: 'feature', status: 'open', dependent_count: 0, updated_at: daysAgo(3) },
        ],
      };
      const { tmpDir, mockScript } = createMockBd(mockData);
      try {
        const result = runSmartStatus(['--json'], { BD_CMD: mockScript });
        expect(result.status).toBe(0);
        const scored = parseIssues(result.stdout);
        expect(scored.length).toBe(1);
        expect(scored[0].id).toBe('solo');
        expect(scored[0].priority_weight).toBe(2);
        expect(scored[0].type_weight).toBe(1.0);
        expect(scored[0].status_boost).toBe(1.0);
        expect(scored[0].staleness_boost).toBe(1.0);
      } finally {
        cleanupTmpDir(tmpDir);
      }
    });

    test('missing dependent_count defaults to 0 (chain=1)', () => {
      const mockData = {
        issues: [
          { id: 'nodeps', title: 'No deps field', priority: 'P2', type: 'feature', status: 'open', updated_at: daysAgo(1) },
        ],
      };
      const { tmpDir, mockScript } = createMockBd(mockData);
      try {
        const result = runSmartStatus(['--json'], { BD_CMD: mockScript });
        expect(result.status).toBe(0);
        const scored = parseIssues(result.stdout);
        expect(scored[0].unblock_chain).toBe(1);
      } finally {
        cleanupTmpDir(tmpDir);
      }
    });

    test('unknown priority defaults to weight 1', () => {
      const mockData = {
        issues: [
          { id: 'unk', title: 'Unknown pri', priority: 'P9', type: 'feature', status: 'open', dependent_count: 0, updated_at: daysAgo(1) },
        ],
      };
      const { tmpDir, mockScript } = createMockBd(mockData);
      try {
        const result = runSmartStatus(['--json'], { BD_CMD: mockScript });
        expect(result.status).toBe(0);
        const scored = parseIssues(result.stdout);
        expect(scored[0].priority_weight).toBe(1);
      } finally {
        cleanupTmpDir(tmpDir);
      }
    });

    test('numeric priority 2 gets same weight as P2', () => {
      const mockData = {
        issues: [
          { id: 'num-pri', title: 'Numeric pri', priority: 2, type: 'bug', status: 'open', dependent_count: 0, updated_at: daysAgo(1) },
        ],
      };
      const { tmpDir, mockScript } = createMockBd(mockData);
      try {
        const result = runSmartStatus(['--json'], { BD_CMD: mockScript });
        expect(result.status).toBe(0);
        const scored = parseIssues(result.stdout);
        expect(scored[0].priority_weight).toBe(3);
      } finally {
        cleanupTmpDir(tmpDir);
      }
    });

    test('numeric priority 4 is grouped into BACKLOG', () => {
      const mockData = {
        issues: [
          { id: 'backlog-num', title: 'Backlog numeric', priority: 4, type: 'task', status: 'open', dependent_count: 0, updated_at: daysAgo(1) },
        ],
      };
      const { tmpDir, mockScript } = createMockBd(mockData);
      try {
        const result = runSmartStatus([], { BD_CMD: mockScript });
        expect(result.status).toBe(0);
        expect(result.stdout).toContain('BACKLOG');
      } finally {
        cleanupTmpDir(tmpDir);
      }
    });

    test('null type defaults to task weight 0.8', () => {
      const mockData = {
        issues: [
          { id: 'null-type', title: 'Null type issue', priority: 'P2', type: null, status: 'open', dependent_count: 0, updated_at: daysAgo(1) },
        ],
      };
      const { tmpDir, mockScript } = createMockBd(mockData);
      try {
        const result = runSmartStatus(['--json'], { BD_CMD: mockScript });
        expect(result.status).toBe(0);
        const scored = parseIssues(result.stdout);
        expect(scored[0].type_weight).toBe(0.8);
      } finally {
        cleanupTmpDir(tmpDir);
      }
    });

    test('numeric priority displays with P prefix in output', () => {
      const mockData = {
        issues: [
          { id: 'p-prefix', title: 'P prefix test', priority: 2, type: 'bug', status: 'open', dependent_count: 0, updated_at: daysAgo(1) },
        ],
      };
      const { tmpDir, mockScript } = createMockBd(mockData);
      try {
        const result = runSmartStatus([], { BD_CMD: mockScript });
        expect(result.status).toBe(0);
        expect(result.stdout).toContain('(P2 bug)');
        expect(result.stdout).not.toContain('(2 bug)');
      } finally {
        cleanupTmpDir(tmpDir);
      }
    });

    test('unknown type defaults to weight 1.0', () => {
      const mockData = {
        issues: [
          { id: 'unk', title: 'Unknown type', priority: 'P2', type: 'chore', status: 'open', dependent_count: 0, updated_at: daysAgo(1) },
        ],
      };
      const { tmpDir, mockScript } = createMockBd(mockData);
      try {
        const result = runSmartStatus(['--json'], { BD_CMD: mockScript });
        expect(result.status).toBe(0);
        const scored = parseIssues(result.stdout);
        expect(scored[0].type_weight).toBe(1.0);
      } finally {
        cleanupTmpDir(tmpDir);
      }
    });

    test('unknown status defaults to boost 1.0', () => {
      const mockData = {
        issues: [
          { id: 'unk', title: 'Unknown status', priority: 'P2', type: 'feature', status: 'closed', dependent_count: 0, updated_at: daysAgo(1) },
        ],
      };
      const { tmpDir, mockScript } = createMockBd(mockData);
      try {
        const result = runSmartStatus(['--json'], { BD_CMD: mockScript });
        expect(result.status).toBe(0);
        const scored = parseIssues(result.stdout);
        expect(scored[0].status_boost).toBe(1.0);
      } finally {
        cleanupTmpDir(tmpDir);
      }
    });
  });

  describe('grouped output', () => {
    test('in_progress issues appear under RESUME group', () => {
      const mockData = {
        issues: [
          { id: 'wip1', title: 'Active work', priority: 'P1', type: 'feature', status: 'in_progress', dependent_count: 0, updated_at: daysAgo(1) },
          { id: 'open1', title: 'Open work', priority: 'P2', type: 'feature', status: 'open', dependent_count: 0, updated_at: daysAgo(1) },
        ],
      };
      const { tmpDir, mockScript } = createMockBd(mockData);
      try {
        const result = runSmartStatus([], { BD_CMD: mockScript, NO_COLOR: '1' });
        expect(result.status).toBe(0);
        expect(result.stdout).toContain('RESUME');
        const resumeIdx = result.stdout.indexOf('RESUME');
        const wip1Idx = result.stdout.indexOf('wip1');
        expect(resumeIdx).not.toBe(-1);
        expect(wip1Idx).not.toBe(-1);
        expect(wip1Idx).toBeGreaterThan(resumeIdx);
      } finally {
        cleanupTmpDir(tmpDir);
      }
    });

    test('P4 issues appear under BACKLOG group', () => {
      const mockData = {
        issues: [
          { id: 'p4item', title: 'Low priority backlog', priority: 'P4', type: 'task', status: 'open', dependent_count: 0, updated_at: daysAgo(1) },
        ],
      };
      const { tmpDir, mockScript } = createMockBd(mockData);
      try {
        const result = runSmartStatus([], { BD_CMD: mockScript, NO_COLOR: '1' });
        expect(result.status).toBe(0);
        expect(result.stdout).toContain('BACKLOG');
        const backlogIdx = result.stdout.indexOf('BACKLOG');
        const itemIdx = result.stdout.indexOf('p4item');
        expect(itemIdx).toBeGreaterThan(backlogIdx);
      } finally {
        cleanupTmpDir(tmpDir);
      }
    });

    test('blocked issues (dependency_count > 0, not closed) appear under BLOCKED group', () => {
      const mockData = {
        issues: [
          { id: 'blocked1', title: 'Blocked item', priority: 'P2', type: 'feature', status: 'open', dependent_count: 0, dependency_count: 2, updated_at: daysAgo(1) },
        ],
      };
      const { tmpDir, mockScript } = createMockBd(mockData);
      try {
        const result = runSmartStatus([], { BD_CMD: mockScript, NO_COLOR: '1' });
        expect(result.status).toBe(0);
        expect(result.stdout).toContain('BLOCKED');
        const blockedIdx = result.stdout.indexOf('BLOCKED');
        const itemIdx = result.stdout.indexOf('blocked1');
        expect(itemIdx).toBeGreaterThan(blockedIdx);
      } finally {
        cleanupTmpDir(tmpDir);
      }
    });

    test('high dependent_count (>=2) non-in_progress issues appear under UNBLOCK CHAINS', () => {
      const mockData = {
        issues: [
          { id: 'chain1', title: 'Unblock chain item', priority: 'P2', type: 'feature', status: 'open', dependent_count: 3, dependency_count: 0, updated_at: daysAgo(1) },
        ],
      };
      const { tmpDir, mockScript } = createMockBd(mockData);
      try {
        const result = runSmartStatus([], { BD_CMD: mockScript, NO_COLOR: '1' });
        expect(result.status).toBe(0);
        expect(result.stdout).toContain('UNBLOCK CHAINS');
        const chainIdx = result.stdout.indexOf('UNBLOCK CHAINS');
        const itemIdx = result.stdout.indexOf('chain1');
        expect(itemIdx).toBeGreaterThan(chainIdx);
      } finally {
        cleanupTmpDir(tmpDir);
      }
    });

    test('open issues with no blockers and no dependencies go to READY WORK', () => {
      const mockData = {
        issues: [
          { id: 'ready1', title: 'Ready to go', priority: 'P2', type: 'feature', status: 'open', dependent_count: 0, dependency_count: 0, updated_at: daysAgo(1) },
        ],
      };
      const { tmpDir, mockScript } = createMockBd(mockData);
      try {
        const result = runSmartStatus([], { BD_CMD: mockScript, NO_COLOR: '1' });
        expect(result.status).toBe(0);
        expect(result.stdout).toContain('READY WORK');
        const readyIdx = result.stdout.indexOf('READY WORK');
        const itemIdx = result.stdout.indexOf('ready1');
        expect(itemIdx).toBeGreaterThan(readyIdx);
      } finally {
        cleanupTmpDir(tmpDir);
      }
    });

    test('group ordering: RESUME > UNBLOCK CHAINS > READY WORK > BLOCKED > BACKLOG', () => {
      const mockData = {
        issues: [
          { id: 'wip', title: 'WIP', priority: 'P1', type: 'feature', status: 'in_progress', dependent_count: 0, dependency_count: 0, updated_at: daysAgo(1) },
          { id: 'chain', title: 'Chain', priority: 'P2', type: 'feature', status: 'open', dependent_count: 3, dependency_count: 0, updated_at: daysAgo(1) },
          { id: 'ready', title: 'Ready', priority: 'P2', type: 'feature', status: 'open', dependent_count: 0, dependency_count: 0, updated_at: daysAgo(1) },
          { id: 'blocked', title: 'Blocked', priority: 'P2', type: 'feature', status: 'open', dependent_count: 0, dependency_count: 1, updated_at: daysAgo(1) },
          { id: 'backlog', title: 'Backlog', priority: 'P4', type: 'task', status: 'open', dependent_count: 0, dependency_count: 0, updated_at: daysAgo(1) },
        ],
      };
      const { tmpDir, mockScript } = createMockBd(mockData);
      try {
        const result = runSmartStatus([], { BD_CMD: mockScript, NO_COLOR: '1' });
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
      } finally {
        cleanupTmpDir(tmpDir);
      }
    });

    test('entry format: N. [score] id (priority type) -- title [status Nd]', () => {
      const mockData = {
        issues: [
          { id: 'fmt1', title: 'Format test', priority: 'P1', type: 'bug', status: 'open', dependent_count: 0, dependency_count: 0, updated_at: daysAgo(3) },
        ],
      };
      const { tmpDir, mockScript } = createMockBd(mockData);
      try {
        const result = runSmartStatus([], { BD_CMD: mockScript, NO_COLOR: '1' });
        expect(result.status).toBe(0);
        expect(result.stdout).toMatch(/1\.\s+\[\d+(\.\d+)?\]\s+fmt1\s+\(P1 bug\)\s+--\s+Format test\s+\[open \d+d\]/);
      } finally {
        cleanupTmpDir(tmpDir);
      }
    });

    test('unblock chain annotation shows what issue unblocks', () => {
      const mockData = {
        issues: [
          { id: 'blocker1', title: 'Blocker', priority: 'P1', type: 'feature', status: 'open', dependent_count: 2, dependency_count: 0, updated_at: daysAgo(1) },
          { id: 'dep-a', title: 'Dep A', priority: 'P2', type: 'task', status: 'open', dependent_count: 0, dependency_count: 1, updated_at: daysAgo(1), dependencies: [{ depends_on_id: 'blocker1' }] },
          { id: 'dep-b', title: 'Dep B', priority: 'P2', type: 'task', status: 'open', dependent_count: 0, dependency_count: 1, updated_at: daysAgo(1), dependencies: [{ depends_on_id: 'blocker1' }] },
        ],
      };
      const { tmpDir, mockScript } = createMockBd(mockData);
      try {
        const result = runSmartStatus([], { BD_CMD: mockScript, NO_COLOR: '1' });
        expect(result.status).toBe(0);
        expect(result.stdout).toMatch(/-> Unblocks:/);
        expect(result.stdout).toContain('dep-a');
        expect(result.stdout).toContain('dep-b');
      } finally {
        cleanupTmpDir(tmpDir);
      }
    });
  });

  describe('staleness flag', () => {
    test('stale flag appears for issues older than 7 days', () => {
      const mockData = {
        issues: [
          { id: 'stale1', title: 'Stale item', priority: 'P2', type: 'feature', status: 'open', dependent_count: 0, dependency_count: 0, updated_at: daysAgo(14) },
        ],
      };
      const { tmpDir, mockScript } = createMockBd(mockData);
      try {
        const result = runSmartStatus([], { BD_CMD: mockScript, NO_COLOR: '1' });
        expect(result.status).toBe(0);
        expect(result.stdout).toMatch(/\[stale 14d\]/);
      } finally {
        cleanupTmpDir(tmpDir);
      }
    });

    test('no stale flag for issues less than 7 days old', () => {
      const mockData = {
        issues: [
          { id: 'fresh1', title: 'Fresh item', priority: 'P2', type: 'feature', status: 'open', dependent_count: 0, dependency_count: 0, updated_at: daysAgo(3) },
        ],
      };
      const { tmpDir, mockScript } = createMockBd(mockData);
      try {
        const result = runSmartStatus([], { BD_CMD: mockScript, NO_COLOR: '1' });
        expect(result.status).toBe(0);
        expect(result.stdout).not.toMatch(/\[stale/);
      } finally {
        cleanupTmpDir(tmpDir);
      }
    });
  });

  describe('NO_COLOR support', () => {
    test('NO_COLOR disables ANSI escape codes', () => {
      const mockData = {
        issues: [
          { id: 'nc1', title: 'No color test', priority: 'P1', type: 'feature', status: 'in_progress', dependent_count: 0, dependency_count: 0, updated_at: daysAgo(1) },
        ],
      };
      const { tmpDir, mockScript } = createMockBd(mockData);
      try {
        const result = runSmartStatus([], { BD_CMD: mockScript, NO_COLOR: '1' });
        expect(result.status).toBe(0);
        expect(result.stdout).not.toMatch(/\x1b\[/);
      } finally {
        cleanupTmpDir(tmpDir);
      }
    });

    test('colors are present when NO_COLOR is not set', () => {
      const mockData = {
        issues: [
          { id: 'c1', title: 'Color test', priority: 'P1', type: 'feature', status: 'in_progress', dependent_count: 0, dependency_count: 0, updated_at: daysAgo(1) },
        ],
      };
      const { tmpDir, mockScript } = createMockBd(mockData);
      try {
        const fullEnv = { ...process.env, BD_CMD: mockScript, GIT_CMD: 'true' };
        delete fullEnv.NO_COLOR;
        const result = spawnSync(resolveBashCommand(), [SCRIPT], {
          cwd: PROJECT_ROOT,
          encoding: 'utf-8',
          timeout: 15000,
          env: fullEnv,
        });
        const stdout = (result.stdout || '').trim();
        expect(stdout).toMatch(/\x1b\[/);
      } finally {
        cleanupTmpDir(tmpDir);
      }
    });
  });

  describe('epic_proximity', () => {
    test('epic proximity boosts issues near completion', () => {
      const mockData = {
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
      };
      const { tmpDir, mockScript } = createMockBd(mockData);
      try {
        const result = runSmartStatus(['--json'], { BD_CMD: mockScript });
        expect(result.status).toBe(0);
        const scored = parseIssues(result.stdout);
        const child = scored.find((s) => s.id === 'child1');
        expect(child).toBeDefined();
        expect(child.epic_proximity).toBeCloseTo(1.4, 1);
      } finally {
        cleanupTmpDir(tmpDir);
      }
    });
  });
});
