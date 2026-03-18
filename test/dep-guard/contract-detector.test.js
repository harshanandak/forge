const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { afterEach, describe, expect, test } = require('bun:test');

const { normalizePhase3Input } = require('../../lib/dep-guard/analyzer.js');
const { scoreContractDependencies } = require('../../lib/dep-guard/contract-detector.js');

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

function createContractFixture(taskContents, files) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dep-guard-contract-fixture-'));
	for (const [relativePath, contents] of Object.entries(files)) {
		const absolutePath = path.join(dir, relativePath);
		fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
		fs.writeFileSync(absolutePath, contents, 'utf8');
	}

	const taskPath = path.join(dir, 'tasks.md');
	fs.writeFileSync(taskPath, taskContents, 'utf8');
	tempDirs.push(dir);
	return {
		dir,
		taskPath,
	};
}

describe('lib/dep-guard/contract-detector.js', () => {
	test('scoreContractDependencies detects overlap with the latest stored Beads contracts', async () => {
		const fixture = createContractFixture(`# Task List: logic-level-dependency-detection

## Task 1: Update plan summary formatting

File(s): \`lib/summary.js\`

What to implement: Update formatPlanSummary() for the new dashboard wording.

Expected output: contract detection finds downstream consumers.
`, {
			'lib/summary.js': 'function formatPlanSummary() { return "summary"; }\n',
		});
		const input = normalizePhase3Input({
			currentIssue: {
				id: 'forge-9zv',
				title: 'Logic-level dependency detection in /plan Phase 3',
			},
			openIssues: [
				{
					id: 'forge-puh',
					title: 'Multi-developer workflow',
					notes: `Task 1/8 done: scaffold analyzer\ncontracts@2026-03-18T08:00:00Z: lib/summary.js:oldFormat(modified)\ncontracts@2026-03-18T10:43:07Z: lib/summary.js:formatPlanSummary(modified)`,
				},
			],
			repositoryRoot: fixture.dir,
			taskFile: fixture.taskPath,
		});

		const result = await scoreContractDependencies(input);
		expect(result.score).toBeGreaterThan(0);
		expect(result.findings).toEqual([
			expect.objectContaining({
				sourceIssueId: 'forge-9zv',
				targetIssueId: 'forge-puh',
				score: expect.any(Number),
				evidence: expect.arrayContaining([
					expect.objectContaining({
						type: 'contract',
						symbol: 'formatPlanSummary',
						contract: 'lib/summary.js:formatPlanSummary(modified)',
						storedContract: 'lib/summary.js:formatPlanSummary(modified)',
						scoreContribution: 1,
					}),
				]),
			}),
		]);
	});

	test('scoreContractDependencies reconciles issue contracts with note-backed data-format and command-contract overlaps', async () => {
		const fixture = createContractFixture(`# Task List: logic-level-dependency-detection

## Task 1: Update summary and CLI contracts

File(s): \`lib/summary.js\`, \`bin/forge-status.js\`

What to implement: Update planSummaryFormat and statusCommandContract for the new dashboard wording.

Expected output: contract detection finds downstream consumers.
`, {
			'lib/summary.js': 'const planSummaryFormat = { version: 2 };\n',
			'bin/forge-status.js': 'const statusCommandContract = { output: "json" };\n',
		});
		const input = normalizePhase3Input({
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
			repositoryRoot: fixture.dir,
			taskFile: fixture.taskPath,
		});

		const result = await scoreContractDependencies(input);
		expect(result.findings).toEqual([
			expect.objectContaining({
				targetIssueId: 'forge-puh',
				evidence: expect.arrayContaining([
					expect.objectContaining({
						contractType: 'data-format',
						symbol: 'planSummaryFormat',
						storedContract: 'lib/summary.js:planSummaryFormat(data-format)',
					}),
					expect.objectContaining({
						contractType: 'command-contract',
						symbol: 'statusCommandContract',
						storedContract: 'bin/forge-status.js:statusCommandContract(command-contract)',
					}),
				]),
			}),
		]);
	});

	test('scoreContractDependencies ignores non-matching stored contracts', async () => {
		const fixture = createContractFixture(`# Task List: logic-level-dependency-detection

## Task 1: Update plan summary formatting

File(s): \`lib/summary.js\`

What to implement: Update formatPlanSummary() for the new dashboard wording.

Expected output: contract detection finds downstream consumers.
`, {
			'lib/summary.js': 'function formatPlanSummary() { return "summary"; }\n',
		});
		const input = normalizePhase3Input({
			currentIssue: {
				id: 'forge-9zv',
				title: 'Logic-level dependency detection in /plan Phase 3',
			},
			openIssues: [
				{
					id: 'forge-other',
					title: 'Documentation automation',
					notes: 'contracts@2026-03-18T10:43:07Z: lib/summary.js:renderReleaseNotes(modified)',
				},
			],
			repositoryRoot: fixture.dir,
			taskFile: fixture.taskPath,
		});

		const result = await scoreContractDependencies(input);
		expect(result).toEqual({
			score: 0,
			findings: [],
			evidence: [],
		});
	});
});
