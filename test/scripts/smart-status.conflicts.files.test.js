const { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } = require('bun:test');

const { cleanupTmpDir, createMockBd, daysAgo, runSmartStatus } = require('./smart-status.helpers');
const { createMockGitWithDiff } = require('./smart-status.conflicts.helpers');

setDefaultTimeout(20000);

describe('smart-status.sh > file-level conflict detection smoke', () => {
	let mockBd;
	let scenarios;

	beforeAll(() => {
		mockBd = createMockBd({
			issues: [
				{ id: 'i1', title: 'Work', priority: 'P2', type: 'feature', status: 'open', dependent_count: 0, updated_at: daysAgo(1) },
			],
		});
		scenarios = {
			truncatedNoConflict: createMockGitWithDiff([
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
		};
	});

	afterAll(() => {
		cleanupTmpDir(mockBd?.tmpDir);
		for (const scenario of Object.values(scenarios || {})) {
			cleanupTmpDir(scenario?.tmpDir);
		}
	});

	test('truncates long changed-file lists in the shell output', () => {
		const result = runSmartStatus([], {
			BD_CMD: mockBd.mockScript,
			GIT_CMD: scenarios.truncatedNoConflict.mockScript,
			REAL_GIT: scenarios.truncatedNoConflict.realGit,
			NO_COLOR: '1',
		});

		expect(result.status).toBe(0);
		expect(result.stdout).toContain('f1.js');
		expect(result.stdout).toContain('f2.js');
		expect(result.stdout).toContain('f3.js');
		expect(result.stdout).toContain('+2 more');
		expect(result.stdout).not.toContain('f4.js');
		expect(result.stdout).not.toMatch(/[Cc]onflict risk/);
	});

	test('renders conflict risk for overlapping files', () => {
		const result = runSmartStatus([], {
			BD_CMD: mockBd.mockScript,
			GIT_CMD: scenarios.overlap.mockScript,
			REAL_GIT: scenarios.overlap.realGit,
			NO_COLOR: '1',
		});

		expect(result.status).toBe(0);
		expect(result.stdout).toMatch(/[Cc]onflict risk/);
		expect(result.stdout).toContain('shared.js');
	});
});
