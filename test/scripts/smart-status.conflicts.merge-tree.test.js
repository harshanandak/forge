const { describe, test, expect, setDefaultTimeout } = require('bun:test');

const { cleanupTmpDir, createMockBd, daysAgo, runSmartStatus } = require('./smart-status.helpers');
const { createMockGitTier2, twoBranchPorcelain } = require('./smart-status.conflicts.helpers');

setDefaultTimeout(20000);

describe('smart-status.sh > tier-2 merge-tree conflict detection', () => {
  test.concurrent('shows !! Merge conflict for real conflicts (exit 1)', () => {
    const branchFiles = {
      'feat/alpha': ['shared.js', 'alpha-only.js'],
      'feat/beta': ['shared.js', 'beta-only.js'],
    };
    const mergeTreeResults = {
      'feat/alpha feat/beta': { exitCode: 1, output: 'shared.js' },
    };
    const mockBd = createMockBd({
      issues: [
        { id: 'i1', title: 'Work', priority: 'P2', type: 'feature', status: 'open', dependent_count: 0, updated_at: daysAgo(1) },
      ],
    });
    const mockGit = createMockGitTier2(twoBranchPorcelain, branchFiles, 'git version 2.45.0', mergeTreeResults);
    try {
      const result = runSmartStatus([], {
        BD_CMD: mockBd.mockScript, GIT_CMD: mockGit.mockScript, NO_COLOR: '1',
      });
      expect(result.status).toBe(0);
      expect(result.stdout).toContain('!! Merge conflict');
      expect(result.stdout).toContain('shared.js');
    } finally {
      cleanupTmpDir(mockBd.tmpDir);
      cleanupTmpDir(mockGit.tmpDir);
    }
  });

  test.concurrent('keeps ! Conflict risk for file-overlap-only (exit 0, no real conflict)', () => {
    const branchFiles = {
      'feat/alpha': ['shared.js', 'alpha-only.js'],
      'feat/beta': ['shared.js', 'beta-only.js'],
    };
    const mergeTreeResults = {
      'feat/alpha feat/beta': { exitCode: 0, output: '' },
    };
    const mockBd = createMockBd({
      issues: [
        { id: 'i1', title: 'Work', priority: 'P2', type: 'feature', status: 'open', dependent_count: 0, updated_at: daysAgo(1) },
      ],
    });
    const mockGit = createMockGitTier2(twoBranchPorcelain, branchFiles, 'git version 2.45.0', mergeTreeResults);
    try {
      const result = runSmartStatus([], {
        BD_CMD: mockBd.mockScript, GIT_CMD: mockGit.mockScript, NO_COLOR: '1',
      });
      expect(result.status).toBe(0);
      expect(result.stdout).toMatch(/! Conflict risk/);
      expect(result.stdout).not.toContain('!! Merge conflict');
    } finally {
      cleanupTmpDir(mockBd.tmpDir);
      cleanupTmpDir(mockGit.tmpDir);
    }
  });

  test.concurrent('skips Tier 2 silently when git version < 2.38', () => {
    const branchFiles = {
      'feat/alpha': ['shared.js'],
      'feat/beta': ['shared.js'],
    };
    const mockBd = createMockBd({
      issues: [
        { id: 'i1', title: 'Work', priority: 'P2', type: 'feature', status: 'open', dependent_count: 0, updated_at: daysAgo(1) },
      ],
    });
    const mockGit = createMockGitTier2(twoBranchPorcelain, branchFiles, 'git version 2.37.1', {});
    try {
      const result = runSmartStatus([], {
        BD_CMD: mockBd.mockScript, GIT_CMD: mockGit.mockScript, NO_COLOR: '1',
      });
      expect(result.status).toBe(0);
      expect(result.stdout).toMatch(/! Conflict risk/);
      expect(result.stdout).not.toContain('!! Merge conflict');
    } finally {
      cleanupTmpDir(mockBd.tmpDir);
      cleanupTmpDir(mockGit.tmpDir);
    }
  });

  test.concurrent('JSON output includes merge_conflicts field for real conflicts', () => {
    const branchFiles = {
      'feat/alpha': ['shared.js'],
      'feat/beta': ['shared.js'],
    };
    const mergeTreeResults = {
      'feat/alpha feat/beta': { exitCode: 1, output: 'shared.js' },
    };
    const mockBd = createMockBd({
      issues: [
        { id: 'i1', title: 'Work', priority: 'P2', type: 'feature', status: 'open', dependent_count: 0, updated_at: daysAgo(1) },
      ],
    });
    const mockGit = createMockGitTier2(twoBranchPorcelain, branchFiles, 'git version 2.45.0', mergeTreeResults);
    try {
      const result = runSmartStatus(['--json'], {
        BD_CMD: mockBd.mockScript, GIT_CMD: mockGit.mockScript, NO_COLOR: '1',
      });
      expect(result.status).toBe(0);
      const parsed = JSON.parse(result.stdout);
      expect(parsed).toHaveProperty('sessions');
      const allConflicts = parsed.sessions.flatMap(s => s.merge_conflicts || []);
      expect(allConflicts.length).toBeGreaterThan(0);
      expect(allConflicts[0]).toHaveProperty('branch');
      expect(allConflicts[0]).toHaveProperty('files');
      expect(allConflicts[0].files).toContain('shared.js');
    } finally {
      cleanupTmpDir(mockBd.tmpDir);
      cleanupTmpDir(mockGit.tmpDir);
    }
  });

  test.concurrent('no merge_conflicts when git >= 2.38 but no real conflicts', () => {
    const branchFiles = {
      'feat/alpha': ['shared.js'],
      'feat/beta': ['shared.js'],
    };
    const mergeTreeResults = {
      'feat/alpha feat/beta': { exitCode: 0, output: '' },
    };
    const mockBd = createMockBd({
      issues: [
        { id: 'i1', title: 'Work', priority: 'P2', type: 'feature', status: 'open', dependent_count: 0, updated_at: daysAgo(1) },
      ],
    });
    const mockGit = createMockGitTier2(twoBranchPorcelain, branchFiles, 'git version 2.45.0', mergeTreeResults);
    try {
      const result = runSmartStatus(['--json'], {
        BD_CMD: mockBd.mockScript, GIT_CMD: mockGit.mockScript, NO_COLOR: '1',
      });
      expect(result.status).toBe(0);
      const parsed = JSON.parse(result.stdout);
      const allConflicts = parsed.sessions.flatMap(s => s.merge_conflicts || []);
      expect(allConflicts.length).toBe(0);
    } finally {
      cleanupTmpDir(mockBd.tmpDir);
      cleanupTmpDir(mockGit.tmpDir);
    }
  });
});
