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
	if (contents === undefined) {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dep-guard-analyzer-'));
		tempDirs.push(dir);
		const filePath = path.join(dir, 'tasks.md');
		fs.writeFileSync(filePath, root, 'utf8');
		return filePath;
	}

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
					importCallChain: 3,
					contractDependencies: 3,
					behavioralDependencies: 2,
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
					contracts: ['scripts\\dep-guard.sh:checkRipple(modified)'],
					files: ['features\\dashboard.js'],
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
				files: ['features/dashboard.js'],
				notes: '',
			},
		]);
		expect(normalized.repositoryRoot).toBe('C:\\repo-root');
	});

	test('normalizePhase3Input normalizes contract paths embedded in notes', () => {
		const normalized = normalizePhase3Input({
			currentIssue: {
				id: 'forge-9zv',
				title: 'Logic-level dependency detection in /plan Phase 3',
			},
			openIssues: [
				{
					id: 'forge-puh',
					title: 'Multi-developer workflow',
					notes: 'contracts@2026-03-18T10:43:07Z: lib\\summary.js:formatPlanSummary(modified)',
				},
			],
			taskContext: {
				path: 'docs/plans/sample-tasks.md',
				taskCount: 0,
				tasks: [],
			},
		});

		expect(normalized.openIssues[0].notes).toContain('lib/summary.js:formatPlanSummary(modified)');
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

	test('analyzePhase3Dependencies surfaces contract dependency findings from stored notes', async () => {
		const repositoryRoot = createTempRepo({
			'lib/summary.js': 'function formatPlanSummary() { return "summary"; }\n',
		});
		const taskFile = createTaskFile(repositoryRoot, `# Task List: logic-level-dependency-detection

## Task 1: Update plan summary formatting

File(s): \`lib/summary.js\`

What to implement: Update formatPlanSummary() for the new dashboard wording.

Expected output: contract detection finds downstream consumers.
`);

		const result = await analyzePhase3Dependencies({
			currentIssue: {
				id: 'forge-9zv',
				title: 'Logic-level dependency detection in /plan Phase 3',
			},
			openIssues: [
				{
					id: 'forge-puh',
					title: 'Multi-developer workflow',
					notes: 'contracts@2026-03-18T10:43:07Z: lib/summary.js:formatPlanSummary(modified)',
				},
			],
			repositoryRoot,
			taskFile,
		});

		expect(result.scores.contractDependencies).toBeGreaterThan(0);
		expect(result.contractDependencies).toEqual(
			expect.objectContaining({
				score: expect.any(Number),
				evidence: expect.arrayContaining([
					expect.objectContaining({
						type: 'contract',
						symbol: 'formatPlanSummary',
					}),
				]),
				findings: expect.arrayContaining([
					expect.objectContaining({
						targetIssueId: 'forge-puh',
					}),
				]),
			}),
		);
	});

	test('analyzePhase3Dependencies surfaces data-format and command-contract evidence and no-match stays clean', async () => {
		const repositoryRoot = createTempRepo({
			'lib/summary.js': 'const planSummaryFormat = { version: 2 };\n',
			'bin/forge-status.js': 'const statusCommandContract = { output: "json" };\n',
		});
		const taskFile = createTaskFile(repositoryRoot, `# Task List: logic-level-dependency-detection

## Task 1: Update summary and CLI contracts

File(s): \`lib/summary.js\`, \`bin/forge-status.js\`

What to implement: Update planSummaryFormat and statusCommandContract for the new dashboard wording.

Expected output: contract detection finds downstream consumers.
`);

		const positiveResult = await analyzePhase3Dependencies({
			currentIssue: {
				id: 'forge-9zv',
				title: 'Logic-level dependency detection in /plan Phase 3',
			},
			openIssues: [
				{
					id: 'forge-puh',
					title: 'Multi-developer workflow',
					contracts: ['lib/summary.js:legacyContract(modified)'],
					notes: 'contracts@2026-03-18T10:43:07Z: lib/summary.js:planSummaryFormat(data-format) bin/forge-status.js:statusCommandContract(command-contract)',
				},
			],
			repositoryRoot,
			taskFile,
		});

		expect(positiveResult.contractDependencies.evidence).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					contractType: 'data-format',
					symbol: 'planSummaryFormat',
				}),
				expect.objectContaining({
					contractType: 'command-contract',
					symbol: 'statusCommandContract',
				}),
			]),
		);

		const negativeResult = await analyzePhase3Dependencies({
			currentIssue: {
				id: 'forge-9zv',
				title: 'Logic-level dependency detection in /plan Phase 3',
			},
			openIssues: [
				{
					id: 'forge-other',
					title: 'Documentation automation',
					notes: 'contracts@2026-03-18T10:43:07Z: lib/summary.js:releaseNotesFormat(data-format)',
				},
			],
			repositoryRoot,
			taskFile,
		});

		expect(negativeResult.scores.contractDependencies).toBe(0);
		expect(negativeResult.contractDependencies).toEqual({
			score: 0,
			evidence: [],
			findings: [],
		});
	});

	test('analyzePhase3Dependencies escalates uncertain behavioral overlap and detector disagreement', async () => {
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

## Task 1: Tighten review policy

File(s): \`lib/progress.js\`, \`docs/workflow.md\`

What to implement: Update parseProgress() and tighten approval rules, confidence threshold handling, and manual review behavior for planning decisions.

Expected output: behavior detection finds downstream consumers.
`);

		const result = await analyzePhase3Dependencies({
			currentIssue: {
				id: 'forge-9zv',
				title: 'Logic-level dependency detection in /plan Phase 3',
			},
			openIssues: [
				{
					id: 'forge-puh',
					title: 'Multi-developer workflow review policy',
					description: 'Manual review rules and confidence threshold handling for coordinated work.',
					files: ['features/dashboard.js'],
				},
			],
			repositoryRoot,
			taskFile,
		});

		expect(result.scores.importCallChain).toBeGreaterThan(0);
		expect(result.scores.behavioralDependencies).toBeGreaterThan(0);
		expect(result.detectorConflicts.length).toBeGreaterThan(0);
		expect(result.detectorConflicts).toEqual(expect.arrayContaining([
			expect.stringMatching(/detector|behavioral|manual review|uncertain/i),
		]));
		expect(result.needsUserDecision).toBe(true);
		expect(result.confidence.belowThreshold).toBe(true);
		expect(result.proposals).toEqual([
			expect.objectContaining({
				action: 'add-dependency',
				dependentIssueId: 'forge-puh',
				dependsOnIssueId: 'forge-9zv',
				requiresApproval: true,
				pros: expect.arrayContaining([expect.stringMatching(/independence|sequence/i)]),
				cons: expect.arrayContaining([expect.stringMatching(/coordination|delay|noise/i)]),
			}),
		]);
		expect(result.rubric.summary).toMatch(/conflict|confidence|behavior/i);
	});
});
