const { describe, test, expect, setDefaultTimeout, beforeAll, afterAll } = require('bun:test');

const { cleanupTmpDir, createMockBd, daysAgo, runSmartStatus } = require('./smart-status.helpers');
const { createMockGitWithDiff } = require('./smart-status.conflicts.helpers');

setDefaultTimeout(20000);

describe('smart-status.sh > file-level conflict detection', () => {
  let mockBd;

  beforeAll(() => {
    mockBd = createMockBd({
      issues: [
        { id: 'i1', title: 'Work', priority: 'P2', type: 'feature', status: 'open', dependent_count: 0, updated_at: daysAgo(1) },
      ],
    });
  });

  afterAll(() => {
    cleanupTmpDir(mockBd?.tmpDir);
  });

  test.concurrent('shows Changed: line with files for each active session branch', () => {
    const porcelain = [
      'worktree /repo', 'HEAD abc123', 'branch refs/heads/master', '',
      'worktree /repo/.worktrees/alpha', 'HEAD def456', 'branch refs/heads/feat/alpha', '',
      'worktree /repo/.worktrees/beta', 'HEAD ghi789', 'branch refs/heads/feat/beta', '',
    ].join('\n');
    const branchFiles = {
      'feat/alpha': ['src/a.js', 'src/b.js'],
      'feat/beta': ['src/c.js'],
    };
    const mockGit = createMockGitWithDiff(porcelain, branchFiles);
    try {
      const result = runSmartStatus([], {
        BD_CMD: mockBd.mockScript, GIT_CMD: mockGit.mockScript, NO_COLOR: '1',
      });
      expect(result.status).toBe(0);
      expect(result.stdout).toContain('ACTIVE SESSIONS');
      expect(result.stdout).toContain('feat/alpha');
      expect(result.stdout).toContain('Changed:');
      expect(result.stdout).toContain('src/a.js');
      expect(result.stdout).toContain('src/b.js');
      expect(result.stdout).toContain('feat/beta');
      expect(result.stdout).toContain('src/c.js');
    } finally {
      cleanupTmpDir(mockGit.tmpDir);
    }
  });

  test.concurrent('truncates to 3 files with +N more', () => {
    const porcelain = [
      'worktree /repo', 'HEAD abc123', 'branch refs/heads/master', '',
      'worktree /repo/.worktrees/big', 'HEAD def456', 'branch refs/heads/feat/big', '',
      'worktree /repo/.worktrees/other', 'HEAD ghi789', 'branch refs/heads/feat/other', '',
    ].join('\n');
    const branchFiles = {
      'feat/big': ['f1.js', 'f2.js', 'f3.js', 'f4.js', 'f5.js'],
      'feat/other': ['x.js'],
    };
    const mockGit = createMockGitWithDiff(porcelain, branchFiles);
    try {
      const result = runSmartStatus([], {
        BD_CMD: mockBd.mockScript, GIT_CMD: mockGit.mockScript, NO_COLOR: '1',
      });
      expect(result.status).toBe(0);
      expect(result.stdout).toContain('f1.js');
      expect(result.stdout).toContain('f2.js');
      expect(result.stdout).toContain('f3.js');
      expect(result.stdout).toContain('+2 more');
      expect(result.stdout).not.toContain('f4.js');
      expect(result.stdout).not.toContain('f5.js');
    } finally {
      cleanupTmpDir(mockGit.tmpDir);
    }
  });

  test.concurrent('shows conflict risk when branches share files', () => {
    const porcelain = [
      'worktree /repo', 'HEAD abc123', 'branch refs/heads/master', '',
      'worktree /repo/.worktrees/alpha', 'HEAD def456', 'branch refs/heads/feat/alpha', '',
      'worktree /repo/.worktrees/beta', 'HEAD ghi789', 'branch refs/heads/feat/beta', '',
    ].join('\n');
    const branchFiles = {
      'feat/alpha': ['shared.js', 'alpha-only.js'],
      'feat/beta': ['shared.js', 'beta-only.js'],
    };
    const mockGit = createMockGitWithDiff(porcelain, branchFiles);
    try {
      const result = runSmartStatus([], {
        BD_CMD: mockBd.mockScript, GIT_CMD: mockGit.mockScript, NO_COLOR: '1',
      });
      expect(result.status).toBe(0);
      expect(result.stdout).toMatch(/[Cc]onflict risk/);
      expect(result.stdout).toContain('shared.js');
    } finally {
      cleanupTmpDir(mockGit.tmpDir);
    }
  });

  test.concurrent('no conflict risk when branches have no overlapping files', () => {
    const porcelain = [
      'worktree /repo', 'HEAD abc123', 'branch refs/heads/master', '',
      'worktree /repo/.worktrees/alpha', 'HEAD def456', 'branch refs/heads/feat/alpha', '',
      'worktree /repo/.worktrees/beta', 'HEAD ghi789', 'branch refs/heads/feat/beta', '',
    ].join('\n');
    const branchFiles = {
      'feat/alpha': ['alpha.js'],
      'feat/beta': ['beta.js'],
    };
    const mockGit = createMockGitWithDiff(porcelain, branchFiles);
    try {
      const result = runSmartStatus([], {
        BD_CMD: mockBd.mockScript, GIT_CMD: mockGit.mockScript, NO_COLOR: '1',
      });
      expect(result.status).toBe(0);
      expect(result.stdout).not.toMatch(/[Cc]onflict risk/);
    } finally {
      cleanupTmpDir(mockGit.tmpDir);
    }
  });

  test.concurrent('no Changed line for branch with no changed files', () => {
    const porcelain = [
      'worktree /repo', 'HEAD abc123', 'branch refs/heads/master', '',
      'worktree /repo/.worktrees/empty', 'HEAD def456', 'branch refs/heads/feat/empty', '',
      'worktree /repo/.worktrees/full', 'HEAD ghi789', 'branch refs/heads/feat/full', '',
    ].join('\n');
    const branchFiles = {
      'feat/empty': [],
      'feat/full': ['a.js'],
    };
    const mockGit = createMockGitWithDiff(porcelain, branchFiles);
    try {
      const result = runSmartStatus([], {
        BD_CMD: mockBd.mockScript, GIT_CMD: mockGit.mockScript, NO_COLOR: '1',
      });
      expect(result.status).toBe(0);
      expect(result.stdout).toContain('feat/full');
      expect(result.stdout).toContain('a.js');
    } finally {
      cleanupTmpDir(mockGit.tmpDir);
    }
  });
});
