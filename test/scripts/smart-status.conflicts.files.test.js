const { describe, test, expect, setDefaultTimeout, beforeAll, afterAll } = require('bun:test');

const { cleanupTmpDir, createMockBd, daysAgo, runSmartStatus } = require('./smart-status.helpers');
const { createMockGitWithDiff } = require('./smart-status.conflicts.helpers');

setDefaultTimeout(20000);

describe('smart-status.sh > file-level conflict detection', () => {
  let mockBd;
  let scenarios;

  beforeAll(() => {
    mockBd = createMockBd({
      issues: [
        { id: 'i1', title: 'Work', priority: 'P2', type: 'feature', status: 'open', dependent_count: 0, updated_at: daysAgo(1) },
      ],
    });
    scenarios = {
      changedLines: createMockGitWithDiff([
        'worktree /repo', 'HEAD abc123', 'branch refs/heads/master', '',
        'worktree /repo/.worktrees/alpha', 'HEAD def456', 'branch refs/heads/feat/alpha', '',
        'worktree /repo/.worktrees/beta', 'HEAD ghi789', 'branch refs/heads/feat/beta', '',
      ].join('\n'), {
        'feat/alpha': ['src/a.js', 'src/b.js'],
        'feat/beta': ['src/c.js'],
      }),
      truncated: createMockGitWithDiff([
        'worktree /repo', 'HEAD abc123', 'branch refs/heads/master', '',
        'worktree /repo/.worktrees/big', 'HEAD def456', 'branch refs/heads/feat/big', '',
        'worktree /repo/.worktrees/other', 'HEAD ghi789', 'branch refs/heads/feat/other', '',
      ].join('\n'), {
        'feat/big': ['f1.js', 'f2.js', 'f3.js', 'f4.js', 'f5.js'],
        'feat/other': ['x.js'],
      }),
      overlap: createMockGitWithDiff([
        'worktree /repo', 'HEAD abc123', 'branch refs/heads/master', '',
        'worktree /repo/.worktrees/alpha', 'HEAD def456', 'branch refs/heads/feat/alpha', '',
        'worktree /repo/.worktrees/beta', 'HEAD ghi789', 'branch refs/heads/feat/beta', '',
      ].join('\n'), {
        'feat/alpha': ['shared.js', 'alpha-only.js'],
        'feat/beta': ['shared.js', 'beta-only.js'],
      }),
      isolated: createMockGitWithDiff([
        'worktree /repo', 'HEAD abc123', 'branch refs/heads/master', '',
        'worktree /repo/.worktrees/alpha', 'HEAD def456', 'branch refs/heads/feat/alpha', '',
        'worktree /repo/.worktrees/beta', 'HEAD ghi789', 'branch refs/heads/feat/beta', '',
      ].join('\n'), {
        'feat/alpha': ['alpha.js'],
        'feat/beta': ['beta.js'],
      }),
      emptyBranch: createMockGitWithDiff([
        'worktree /repo', 'HEAD abc123', 'branch refs/heads/master', '',
        'worktree /repo/.worktrees/empty', 'HEAD def456', 'branch refs/heads/feat/empty', '',
        'worktree /repo/.worktrees/full', 'HEAD ghi789', 'branch refs/heads/feat/full', '',
      ].join('\n'), {
        'feat/empty': [],
        'feat/full': ['a.js'],
      }),
    };
  });

  afterAll(() => {
    cleanupTmpDir(mockBd?.tmpDir);
    for (const scenario of Object.values(scenarios || {})) {
      cleanupTmpDir(scenario?.tmpDir);
    }
  });

  test.concurrent('shows Changed: line with files for each active session branch', () => {
    const result = runSmartStatus([], {
      BD_CMD: mockBd.mockScript, GIT_CMD: scenarios.changedLines.mockScript, NO_COLOR: '1',
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('ACTIVE SESSIONS');
    expect(result.stdout).toContain('feat/alpha');
    expect(result.stdout).toContain('Changed:');
    expect(result.stdout).toContain('src/a.js');
    expect(result.stdout).toContain('src/b.js');
    expect(result.stdout).toContain('feat/beta');
    expect(result.stdout).toContain('src/c.js');
  });

  test.concurrent('truncates to 3 files with +N more', () => {
    const result = runSmartStatus([], {
      BD_CMD: mockBd.mockScript, GIT_CMD: scenarios.truncated.mockScript, NO_COLOR: '1',
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('f1.js');
    expect(result.stdout).toContain('f2.js');
    expect(result.stdout).toContain('f3.js');
    expect(result.stdout).toContain('+2 more');
    expect(result.stdout).not.toContain('f4.js');
    expect(result.stdout).not.toContain('f5.js');
  });

  test.concurrent('shows conflict risk when branches share files', () => {
    const result = runSmartStatus([], {
      BD_CMD: mockBd.mockScript, GIT_CMD: scenarios.overlap.mockScript, NO_COLOR: '1',
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/[Cc]onflict risk/);
    expect(result.stdout).toContain('shared.js');
  });

  test.concurrent('no conflict risk when branches have no overlapping files', () => {
    const result = runSmartStatus([], {
      BD_CMD: mockBd.mockScript, GIT_CMD: scenarios.isolated.mockScript, NO_COLOR: '1',
    });
    expect(result.status).toBe(0);
    expect(result.stdout).not.toMatch(/[Cc]onflict risk/);
  });

  test.concurrent('no Changed line for branch with no changed files', () => {
    const result = runSmartStatus([], {
      BD_CMD: mockBd.mockScript, GIT_CMD: scenarios.emptyBranch.mockScript, NO_COLOR: '1',
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('feat/full');
    expect(result.stdout).toContain('a.js');
  });
});
