const { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } = require('bun:test');

const { cleanupTmpDir, createMockBd, daysAgo, runSmartStatus } = require('./smart-status.helpers');
const { createMockGitTier2, twoBranchPorcelain } = require('./smart-status.conflicts.helpers');

setDefaultTimeout(20000);

describe('smart-status.sh > merge-tree conflict detection smoke', () => {
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

	test('shows merge conflict annotations when merge-tree reports a real conflict', () => {
		const result = runSmartStatus([], {
			BD_CMD: mockBd.mockScript,
			GIT_CMD: scenarios.realConflict.mockScript,
			REAL_GIT: scenarios.realConflict.realGit,
			NO_COLOR: '1',
		});

		expect(result.status).toBe(0);
		expect(result.stdout).toContain('!! Merge conflict');
		expect(result.stdout).toContain('shared.js');
	});

	test('omits merge_conflicts from JSON output when merge-tree finds no real conflict', () => {
		const result = runSmartStatus(['--json'], {
			BD_CMD: mockBd.mockScript,
			GIT_CMD: scenarios.jsonNoConflict.mockScript,
			REAL_GIT: scenarios.jsonNoConflict.realGit,
			NO_COLOR: '1',
		});

		expect(result.status).toBe(0);
		const parsed = JSON.parse(result.stdout);
		const allConflicts = parsed.sessions.flatMap((session) => session.merge_conflicts || []);
		expect(allConflicts.length).toBe(0);
	});
});
