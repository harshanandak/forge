const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { afterEach, describe, expect, test } = require('bun:test');

const { normalizePhase3Input } = require('../../lib/dep-guard/analyzer.js');
const { scoreBehavioralDependencies } = require('../../lib/dep-guard/behavior-detector.js');

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

function createTaskFile(contents) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dep-guard-behavior-detector-'));
	const filePath = path.join(dir, 'tasks.md');
	fs.writeFileSync(filePath, contents, 'utf8');
	tempDirs.push(dir);
	return filePath;
}

describe('lib/dep-guard/behavior-detector.js', () => {
	test('scoreBehavioralDependencies leaves uncertainty off for a strong rule-change overlap', async () => {
		const taskFile = createTaskFile(`# Task List: logic-level-dependency-detection

## Task 1: Tighten review policy

File(s): \`docs/workflow.md\`

What to implement: Tighten approval rules, confidence threshold handling, and manual review behavior for planning decisions.

Expected output: behavior detection finds downstream consumers.
`);

		const result = await scoreBehavioralDependencies(normalizePhase3Input({
			currentIssue: {
				id: 'forge-9zv',
				title: 'Logic-level dependency detection in /plan Phase 3',
			},
			openIssues: [
				{
					id: 'forge-puh',
					title: 'Multi-developer workflow review policy',
					description: 'Manual review rules and confidence threshold handling for coordinated work.',
				},
			],
			taskFile,
		}));

		expect(result.score).toBeGreaterThan(0);
		expect(result.uncertain).toBe(false);
		expect(result.findings).toEqual([
			expect.objectContaining({
				targetIssueId: 'forge-puh',
				behavioralSignal: 'rule-change-overlap',
				evidence: expect.arrayContaining([
					expect.objectContaining({
						type: 'behavior',
						sharedTerms: expect.arrayContaining(['review', 'rules']),
						scoreContribution: expect.any(Number),
					}),
				]),
			}),
		]);
	});

	test('scoreBehavioralDependencies flags uncertainty for a weak behavioral overlap', async () => {
		const taskFile = createTaskFile(`# Task List: logic-level-dependency-detection

## Task 1: Adjust workflow defaults

File(s): \`docs/workflow.md\`

What to implement: Adjust workflow behavior and default output ordering for planning decisions.

Expected output: behavior detection finds downstream consumers.
`);

		const result = await scoreBehavioralDependencies(normalizePhase3Input({
			currentIssue: {
				id: 'forge-9zv',
				title: 'Logic-level dependency detection in /plan Phase 3',
			},
			openIssues: [
				{
					id: 'forge-puh',
					title: 'Workflow output ordering',
					description: 'Default workflow output ordering for planning summaries.',
				},
			],
			taskFile,
		}));

		expect(result.score).toBeGreaterThan(0);
		expect(result.uncertain).toBe(true);
	});

	test('scoreBehavioralDependencies stays empty when issue text does not share enough behavior terms', async () => {
		const taskFile = createTaskFile(`# Task List: logic-level-dependency-detection

## Task 1: Tighten review policy

File(s): \`docs/workflow.md\`

What to implement: Tighten approval rules, confidence threshold handling, and manual review behavior for planning decisions.

Expected output: behavior detection finds downstream consumers.
`);

		const result = await scoreBehavioralDependencies(normalizePhase3Input({
			currentIssue: {
				id: 'forge-9zv',
				title: 'Logic-level dependency detection in /plan Phase 3',
			},
			openIssues: [
				{
					id: 'forge-jvc',
					title: 'Documentation automation',
					description: 'Render static release note pages and sitemap metadata.',
				},
			],
			taskFile,
		}));

		expect(result).toEqual({
			score: 0,
			findings: [],
			evidence: [],
			uncertain: false,
		});
	});
});
