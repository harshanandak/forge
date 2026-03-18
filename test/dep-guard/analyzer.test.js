const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { afterEach, describe, expect, test } = require('bun:test');

const {
	analyzePhase3Dependencies,
	DETECTOR_KEYS,
	normalizePhase3Input,
} = require('../../lib/dep-guard/analyzer.js');

const tempDirs = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		try {
			fs.rmSync(dir, { recursive: true, force: true });
		} catch (_error) {
			// Ignore temp-dir cleanup errors in tests.
		}
	}
});

function createTempRepo(files) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dep-guard-import-'));
	for (const [relativePath, contents] of Object.entries(files)) {
		const absolutePath = path.join(root, relativePath);
		fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
		fs.writeFileSync(absolutePath, contents, 'utf8');
	}
	tempDirs.push(root);
	return root;
}

function createTaskFile(root, contents) {
	const taskFile = path.join(root, 'tasks.md');
	fs.writeFileSync(taskFile, contents, 'utf8');
	return taskFile;
}

describe('lib/dep-guard/analyzer.js', () => {
	test('normalizePhase3Input rejects missing issue metadata', () => {
		expect(() => normalizePhase3Input()).toThrow(/current issue/i);
		expect(() => normalizePhase3Input({ currentIssue: {} })).toThrow(/current issue id/i);
	});

	test('analyzePhase3Dependencies returns the stable top-level JSON contract for minimal valid input', async () => {
		const result = await analyzePhase3Dependencies({
			currentIssue: {
				id: 'forge-9zv',
				title: 'Logic-level dependency detection in /plan Phase 3',
			},
			openIssues: [],
			taskFile: 'docs/plans/2026-03-18-logic-level-dependency-detection-tasks.md',
		});

		expect(result).toMatchObject({
			currentIssue: {
				id: 'forge-9zv',
			},
			issues: [],
			scores: {
				importCallChain: 0,
				contractDependencies: 0,
				behavioralDependencies: 0,
				rubric: 0,
			},
			rubric: {
				score: 0,
				summary: 'No detector findings yet.',
				weights: {
					importCallChain: 0,
					contractDependencies: 0,
					behavioralDependencies: 0,
				},
			},
			confidence: {
				score: 1,
				belowThreshold: false,
			},
			proposals: [],
			needsUserDecision: false,
		});
		expect(result.taskContext.taskCount).toBe(8);
		expect(result.detectorConflicts).toEqual([]);
		expect(result.importCallChain).toEqual({
			score: 0,
			evidence: [],
			findings: [],
		});
	});

	test('normalizePhase3Input normalizes open issues and repository root overrides', () => {
		const normalized = normalizePhase3Input({
			currentIssue: {
				id: 'forge-9zv',
				title: 'Logic-level dependency detection in /plan Phase 3',
			},
			openIssues: [
				{
					id: 'forge-puh',
					title: 'Multi-developer workflow',
					contracts: ['scripts/dep-guard.sh:checkRipple(modified)'],
				},
			],
			taskContext: {
				path: 'docs/plans/sample-tasks.md',
				taskCount: 0,
				tasks: [],
			},
			repositoryRoot: 'C:\\repo-root',
		});

		expect(normalized.openIssues).toEqual([
			{
				id: 'forge-puh',
				title: 'Multi-developer workflow',
				description: '',
				status: '',
				contracts: ['scripts/dep-guard.sh:checkRipple(modified)'],
				files: [],
			},
		]);
		expect(normalized.repositoryRoot).toBe('C:\\repo-root');
	});

	test('detector sections stay aligned on the same detector keys', async () => {
		const result = await analyzePhase3Dependencies({
			currentIssue: {
				id: 'forge-9zv',
				title: 'Logic-level dependency detection in /plan Phase 3',
			},
			openIssues: [],
			taskFile: 'docs/plans/2026-03-18-logic-level-dependency-detection-tasks.md',
		});

		expect(Object.keys(result.rubric.weights)).toEqual(DETECTOR_KEYS);
		expect(Object.keys(result.detectorEvidence)).toEqual(DETECTOR_KEYS);
		expect(Object.keys(result.scores)).toEqual([...DETECTOR_KEYS, 'rubric']);
	});

	test('analyzePhase3Dependencies surfaces import and call-chain evidence for a shared symbol', async () => {
		const repositoryRoot = createTempRepo({
			'lib/progress.js': `function parseProgress(raw) {
  return raw.trim().toUpperCase();
}

module.exports = {
  parseProgress,
};
`,
			'features/dashboard.js': `const { parseProgress } = require('../lib/progress');

function renderDashboard(raw) {
  return parseProgress(raw);
}

module.exports = {
  renderDashboard,
};
`,
		});
		const taskFile = createTaskFile(repositoryRoot, `# Task List: logic-level-dependency-detection

## Task 1: Update progress parsing

File(s): \`lib/progress.js\`

What to implement: Update parseProgress() for the new plan status format.

Expected output: import detection finds downstream consumers.
`);
		const input = {
			currentIssue: {
				id: 'forge-9zv',
				title: 'Logic-level dependency detection in /plan Phase 3',
			},
			openIssues: [
				{
					id: 'forge-puh',
					title: 'Multi-developer workflow',
					files: ['features/dashboard.js'],
				},
			],
			repositoryRoot,
			taskFile,
		};

		const analyzerResult = await analyzePhase3Dependencies(input);
		expect(analyzerResult.scores.importCallChain).toBeGreaterThan(0);
		expect(analyzerResult.detectorEvidence.importCallChain).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					sourceFile: 'features/dashboard.js',
					symbol: 'parseProgress',
				}),
			]),
		);
		expect(analyzerResult.importCallChain).toEqual(
			expect.objectContaining({
				score: expect.any(Number),
				evidence: expect.arrayContaining([
					expect.objectContaining({
						sourceFile: 'features/dashboard.js',
						symbol: 'parseProgress',
					}),
				]),
				findings: expect.arrayContaining([
					expect.objectContaining({
						targetIssueId: 'forge-puh',
					}),
				]),
			}),
		);
		expect(analyzerResult.issues).toEqual([
			expect.objectContaining({
				sourceIssueId: 'forge-9zv',
				targetIssueId: 'forge-puh',
			}),
		]);
	});
});
