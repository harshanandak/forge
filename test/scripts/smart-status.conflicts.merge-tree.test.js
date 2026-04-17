const { describe, test, expect, setDefaultTimeout, beforeAll, afterAll } = require('bun:test');

const { cleanupTmpDir, createMockBd, daysAgo, runSmartStatus } = require('./smart-status.helpers');
const { createMockGitTier2, twoBranchPorcelain } = require('./smart-status.conflicts.helpers');

setDefaultTimeout(20000);

describe('smart-status.sh > tier-2 merge-tree conflict detection', () => {
  let mockBd;
  let scenarios;

  beforeAll(() => {
    mockBd = createMockBd({
      issues: [
        { id: 'i1', title: 'Work', priority: 'P2', type: 'feature', status: 'open', dependent_count: 0, updated_at: daysAgo(1) },
      ],
    });
    scenarios = {
      realConflict: createMockGitTier2(twoBranchPorcelain, {
        'feat/alpha': ['shared.js', 'alpha-only.js'],
        'feat/beta': ['shared.js', 'beta-only.js'],
      }, 'git version 2.45.0', {
        'feat/alpha feat/beta': { exitCode: 1, output: 'shared.js' },
      }),
      overlapOnly: createMockGitTier2(twoBranchPorcelain, {
        'feat/alpha': ['shared.js', 'alpha-only.js'],
        'feat/beta': ['shared.js', 'beta-only.js'],
      }, 'git version 2.45.0', {
        'feat/alpha feat/beta': { exitCode: 0, output: '' },
      }),
      legacyGit: createMockGitTier2(twoBranchPorcelain, {
        'feat/alpha': ['shared.js'],
        'feat/beta': ['shared.js'],
      }, 'git version 2.37.1', {}),
      jsonConflict: createMockGitTier2(twoBranchPorcelain, {
        'feat/alpha': ['shared.js'],
        'feat/beta': ['shared.js'],
      }, 'git version 2.45.0', {
        'feat/alpha feat/beta': { exitCode: 1, output: 'shared.js' },
      }),
      jsonNoConflict: createMockGitTier2(twoBranchPorcelain, {
        'feat/alpha': ['shared.js'],
        'feat/beta': ['shared.js'],
      }, 'git version 2.45.0', {
        'feat/alpha feat/beta': { exitCode: 0, output: '' },
      }),
    };
  });

  afterAll(() => {
    cleanupTmpDir(mockBd?.tmpDir);
    for (const scenario of Object.values(scenarios || {})) {
      cleanupTmpDir(scenario?.tmpDir);
    }
  });

  test.concurrent('shows !! Merge conflict for real conflicts (exit 1)', () => {
    const result = runSmartStatus([], {
      BD_CMD: mockBd.mockScript, GIT_CMD: scenarios.realConflict.mockScript, NO_COLOR: '1',
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('!! Merge conflict');
    expect(result.stdout).toContain('shared.js');
  });

  test.concurrent('keeps ! Conflict risk for file-overlap-only (exit 0, no real conflict)', () => {
    const result = runSmartStatus([], {
      BD_CMD: mockBd.mockScript, GIT_CMD: scenarios.overlapOnly.mockScript, NO_COLOR: '1',
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/! Conflict risk/);
    expect(result.stdout).not.toContain('!! Merge conflict');
  });

  test.concurrent('skips Tier 2 silently when git version < 2.38', () => {
    const result = runSmartStatus([], {
      BD_CMD: mockBd.mockScript, GIT_CMD: scenarios.legacyGit.mockScript, NO_COLOR: '1',
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/! Conflict risk/);
    expect(result.stdout).not.toContain('!! Merge conflict');
  });

  test.concurrent('JSON output includes merge_conflicts field for real conflicts', () => {
    const result = runSmartStatus(['--json'], {
      BD_CMD: mockBd.mockScript, GIT_CMD: scenarios.jsonConflict.mockScript, NO_COLOR: '1',
    });
    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed).toHaveProperty('sessions');
    const allConflicts = parsed.sessions.flatMap(s => s.merge_conflicts || []);
    expect(allConflicts.length).toBeGreaterThan(0);
    expect(allConflicts[0]).toHaveProperty('branch');
    expect(allConflicts[0]).toHaveProperty('files');
    expect(allConflicts[0].files).toContain('shared.js');
  });

  test.concurrent('no merge_conflicts when git >= 2.38 but no real conflicts', () => {
    const result = runSmartStatus(['--json'], {
      BD_CMD: mockBd.mockScript, GIT_CMD: scenarios.jsonNoConflict.mockScript, NO_COLOR: '1',
    });
    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout);
    const allConflicts = parsed.sessions.flatMap(s => s.merge_conflicts || []);
    expect(allConflicts.length).toBe(0);
  });
});
