const { describe, expect, test } = require('bun:test');

const {
	applyMergeTreeConflicts,
	computeFileConflicts,
	matchInProgressIssues,
	parseMergeTreeNameOnly,
	parseWorktreePorcelain,
} = require('../../lib/smart-status/conflicts');

describe('smart-status conflict helpers', () => {
	test('parseWorktreePorcelain excludes the base branch and preserves worktree paths', () => {
		const porcelain = [
			'worktree /repo',
			'HEAD abc123',
			'branch refs/heads/master',
			'',
			'worktree /repo/.worktrees/alpha',
			'HEAD def456',
			'branch refs/heads/feat/alpha',
			'',
			'worktree /repo/.worktrees/beta',
			'HEAD ghi789',
			'branch refs/heads/fix/beta',
			'',
		].join('\n');

		expect(parseWorktreePorcelain(porcelain, 'master')).toEqual([
			{ branch: 'feat/alpha', path: '/repo/.worktrees/alpha' },
			{ branch: 'fix/beta', path: '/repo/.worktrees/beta' },
		]);
	});

	test('matchInProgressIssues matches branch slugs against issue titles and leaves unmatched worktrees untracked', () => {
		const worktrees = [
			{ branch: 'feat/p2-bug-fixes', path: '/repo/.worktrees/p2-bug-fixes' },
			{ branch: 'feat/orphan-branch', path: '/repo/.worktrees/orphan-branch' },
		];
		const issues = [
			{ id: 'forge-iv1p', title: 'P2 bug fixes batch 1' },
			{ id: 'forge-cpnj', title: 'P2 bug fixes batch 2' },
			{ id: 'forge-other', title: 'Completely different work' },
		];

		expect(matchInProgressIssues(worktrees, issues)).toEqual([
			{
				branch: 'feat/p2-bug-fixes',
				path: '/repo/.worktrees/p2-bug-fixes',
				issue_ids: ['forge-iv1p', 'forge-cpnj'],
				issue_count: 2,
			},
			{
				branch: 'feat/orphan-branch',
				path: '/repo/.worktrees/orphan-branch',
				issue_ids: [],
				issue_count: 0,
			},
		]);
	});

	test('computeFileConflicts adds changed files and overlap annotations per branch', () => {
		const sessions = [
			{ branch: 'feat/alpha', path: '/repo/.worktrees/alpha', issue_ids: ['i1'], issue_count: 1 },
			{ branch: 'feat/beta', path: '/repo/.worktrees/beta', issue_ids: [], issue_count: 0 },
			{ branch: 'feat/empty', path: '/repo/.worktrees/empty', issue_ids: [], issue_count: 0 },
		];
		const branchFiles = [
			{ branch: 'feat/alpha', files: ['shared.js', 'alpha-only.js', 'shared.js'] },
			{ branch: 'feat/beta', files: ['shared.js', 'beta-only.js'] },
			{ branch: 'feat/empty', files: [] },
		];

		expect(computeFileConflicts(sessions, branchFiles)).toEqual([
			{
				branch: 'feat/alpha',
				path: '/repo/.worktrees/alpha',
				issue_ids: ['i1'],
				issue_count: 1,
				changed_files: ['shared.js', 'alpha-only.js'],
				conflicts: [{ branch: 'feat/beta', files: ['shared.js'] }],
			},
			{
				branch: 'feat/beta',
				path: '/repo/.worktrees/beta',
				issue_ids: [],
				issue_count: 0,
				changed_files: ['shared.js', 'beta-only.js'],
				conflicts: [{ branch: 'feat/alpha', files: ['shared.js'] }],
			},
			{
				branch: 'feat/empty',
				path: '/repo/.worktrees/empty',
				issue_ids: [],
				issue_count: 0,
				changed_files: [],
				conflicts: [],
			},
		]);
	});

	test('computeFileConflicts ignores malformed branch file payloads', () => {
		const sessions = [
			{ branch: 'feat/alpha', path: '/repo/.worktrees/alpha', issue_ids: [], issue_count: 0 },
		];

		expect(computeFileConflicts(sessions, [
			{ branch: 'feat/alpha', files: 'shared.js' },
		])).toEqual([
			{
				branch: 'feat/alpha',
				path: '/repo/.worktrees/alpha',
				issue_ids: [],
				issue_count: 0,
				changed_files: [],
				conflicts: [],
			},
		]);
	});

	test('parseMergeTreeNameOnly skips the synthetic tree SHA and empty lines', () => {
		const output = [
			'abc123def456abc123def456abc123def456abc1234',
			'',
			'shared.js',
			'other.js',
			'',
		].join('\n');

		expect(parseMergeTreeNameOnly(output)).toEqual(['shared.js', 'other.js']);
	});

	test('applyMergeTreeConflicts annotates both branches only when merge-tree reports real conflicts', () => {
		const sessions = [
			{
				branch: 'feat/alpha',
				path: '/repo/.worktrees/alpha',
				issue_ids: [],
				issue_count: 0,
				changed_files: ['shared.js'],
				conflicts: [{ branch: 'feat/beta', files: ['shared.js'] }],
			},
			{
				branch: 'feat/beta',
				path: '/repo/.worktrees/beta',
				issue_ids: [],
				issue_count: 0,
				changed_files: ['shared.js'],
				conflicts: [{ branch: 'feat/alpha', files: ['shared.js'] }],
			},
		];

		expect(applyMergeTreeConflicts(sessions, [
			{
				left: 'feat/alpha',
				right: 'feat/beta',
				exitCode: 1,
				output: ['abc123def456abc123def456abc123def456abc1234', 'shared.js'].join('\n'),
			},
			{
				left: 'feat/alpha',
				right: 'feat/gamma',
				exitCode: 0,
				output: '',
			},
		])).toEqual([
			{
				branch: 'feat/alpha',
				path: '/repo/.worktrees/alpha',
				issue_ids: [],
				issue_count: 0,
				changed_files: ['shared.js'],
				conflicts: [{ branch: 'feat/beta', files: ['shared.js'] }],
				merge_conflicts: [{ branch: 'feat/beta', files: ['shared.js'] }],
			},
			{
				branch: 'feat/beta',
				path: '/repo/.worktrees/beta',
				issue_ids: [],
				issue_count: 0,
				changed_files: ['shared.js'],
				conflicts: [{ branch: 'feat/alpha', files: ['shared.js'] }],
				merge_conflicts: [{ branch: 'feat/alpha', files: ['shared.js'] }],
			},
		]);
	});

	test('applyMergeTreeConflicts ignores merge-tree error exit codes', () => {
		const sessions = [
			{
				branch: 'feat/alpha',
				path: '/repo/.worktrees/alpha',
				issue_ids: [],
				issue_count: 0,
				changed_files: ['shared.js'],
				conflicts: [],
			},
		];

		expect(applyMergeTreeConflicts(sessions, [
			{
				left: 'feat/alpha',
				right: 'feat/beta',
				exitCode: 2,
				output: ['abc123def456abc123def456abc123def456abc1234', 'shared.js'].join('\n'),
			},
		])).toEqual(sessions);
	});
});
