const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { afterEach, describe, expect, test } = require('bun:test');

const { parseTaskFile } = require('../../lib/dep-guard/task-parser.js');

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
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dep-guard-task-parser-'));
	const filePath = path.join(dir, 'tasks.md');
	fs.writeFileSync(filePath, contents, 'utf8');
	tempDirs.push(dir);
	return filePath;
}

describe('lib/dep-guard/task-parser.js', () => {
	test('parseTaskFile rejects a missing file path', () => {
		expect(() => parseTaskFile('C:\\missing\\dep-guard-task-file.md')).toThrow(/does not exist/i);
	});

	test('parseTaskFile normalizes task blocks from a plan task list', () => {
		const taskFile = createTaskFile(`# Task List: logic-level-dependency-detection

## Task 1: Scaffold the Phase 3 analyzer and structured result contract

File(s): \`lib/dep-guard/analyzer.js\`, \`lib/dep-guard/task-parser.js\`

What to implement: Implement analyzePhase3Dependencies(), normalizePhase3Input(), and parseTaskFile() so the analyzer returns a stable JSON contract.

TDD steps:
  1. Write test first.

Expected output: structured JSON.
`);

		expect(parseTaskFile(taskFile)).toEqual({
			path: taskFile,
			taskCount: 1,
			tasks: [
				{
					number: 1,
					title: 'Scaffold the Phase 3 analyzer and structured result contract',
					files: ['lib/dep-guard/analyzer.js', 'lib/dep-guard/task-parser.js'],
					whatToImplement: 'Implement analyzePhase3Dependencies(), normalizePhase3Input(), and parseTaskFile() so the analyzer returns a stable JSON contract.',
					expectedOutput: 'structured JSON.',
				},
			],
		});
	});

	test('parseTaskFile preserves multiple tasks and multiline fields', () => {
		const taskFile = createTaskFile(`# Task List: logic-level-dependency-detection

## Task 1: First task

File(s): \`lib/dep-guard/analyzer.js\`

What to implement: Implement analyzePhase3Dependencies()
and return structured detector output.

Expected output: analyzer JSON.

## Task 2: Second task

File(s): \`lib/dep-guard/task-parser.js\`

What to implement: Implement parseTaskFile()
and preserve multiline markdown sections.

Expected output: normalized tasks.
`);

		expect(parseTaskFile(taskFile)).toEqual({
			path: taskFile,
			taskCount: 2,
			tasks: [
				{
					number: 1,
					title: 'First task',
					files: ['lib/dep-guard/analyzer.js'],
					whatToImplement: 'Implement analyzePhase3Dependencies() and return structured detector output.',
					expectedOutput: 'analyzer JSON.',
				},
				{
					number: 2,
					title: 'Second task',
					files: ['lib/dep-guard/task-parser.js'],
					whatToImplement: 'Implement parseTaskFile() and preserve multiline markdown sections.',
					expectedOutput: 'normalized tasks.',
				},
			],
		});
	});
});
