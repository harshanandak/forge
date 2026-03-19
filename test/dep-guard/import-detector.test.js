const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { afterEach, describe, expect, test } = require('bun:test');

const { normalizePhase3Input } = require('../../lib/dep-guard/analyzer.js');
const { scoreImportDependencies } = require('../../lib/dep-guard/import-detector.js');

const tempDirs = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		try {
			fs.rmSync(dir, { recursive: true, force: true });
		} catch (_error) {
			// Ignore temp-dir cleanup errors in tests.
		}
	}

	fs.readFileSync = originalReadFileSync;
});

const originalReadFileSync = fs.readFileSync;

function createTempRepo(files) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dep-guard-import-detector-'));
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

describe('lib/dep-guard/import-detector.js', () => {
	test('scoreImportDependencies detects import and call-chain evidence for a shared symbol', async () => {
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

		const detectorResult = await scoreImportDependencies(normalizePhase3Input(input));
		expect(detectorResult.score).toBeGreaterThan(0);
		expect(detectorResult.findings).toEqual([
			expect.objectContaining({
				sourceIssueId: 'forge-9zv',
				targetIssueId: 'forge-puh',
				score: expect.any(Number),
				evidence: expect.arrayContaining([
					expect.objectContaining({
						consumerFile: 'features/dashboard.js',
						sourceFile: 'features/dashboard.js',
						scoreContribution: 1,
						symbol: 'parseProgress',
						type: 'import',
					}),
					expect.objectContaining({
						consumerFile: 'features/dashboard.js',
						sourceFile: 'features/dashboard.js',
						scoreContribution: 1,
						symbol: 'parseProgress',
						type: 'call',
					}),
				]),
			}),
		]);
	});

	test('scoreImportDependencies handles default require and default import direct calls', async () => {
		const repositoryRoot = createTempRepo({
			'lib/progress.js': `function parseProgress(raw) {
  return raw.trim().toUpperCase();
}

module.exports = parseProgress;
`,
			'features/commonjs-dashboard.js': `const parseProgress = require('../lib/progress');

function renderDashboard(raw) {
  return parseProgress(raw);
}

module.exports = {
  renderDashboard,
};
`,
			'features/esm-dashboard.mjs': `import parseProgress from '../lib/progress.js';

export function renderDashboard(raw) {
  return parseProgress(raw);
}
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
					files: ['features/commonjs-dashboard.js', 'features/esm-dashboard.mjs'],
				},
			],
			repositoryRoot,
			taskFile,
		};

		const detectorResult = await scoreImportDependencies(normalizePhase3Input(input));
		expect(detectorResult.evidence).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					type: 'call',
					consumerFile: 'features/commonjs-dashboard.js',
					sourceFile: 'features/commonjs-dashboard.js',
					targetFile: 'lib/progress.js',
					symbol: 'parseProgress',
				}),
				expect.objectContaining({
					type: 'call',
					consumerFile: 'features/esm-dashboard.mjs',
					sourceFile: 'features/esm-dashboard.mjs',
					targetFile: 'lib/progress.js',
					symbol: 'parseProgress',
				}),
			]),
		);
	});

	test('scoreImportDependencies detects aliased default imports when task text uses backticked symbols', async () => {
		const repositoryRoot = createTempRepo({
			'lib/progress.js': `function parseProgress(raw) {
  return raw.trim().toUpperCase();
}

module.exports = parseProgress;
`,
			'features/dashboard.js': `const progressParser = require('../lib/progress');

function renderDashboard(raw) {
  return progressParser(raw);
}

module.exports = {
  renderDashboard,
};
`,
			'features/esm-dashboard.mjs': `import progressParser from '../lib/progress.js';

export function renderDashboard(raw) {
  return progressParser(raw);
}
`,
		});
		const taskFile = createTaskFile(repositoryRoot, `# Task List: logic-level-dependency-detection

## Task 1: Update progress parsing

File(s): \`lib/progress.js\`

What to implement: Update \`parseProgress\` for the new plan status format.

Expected output: import detection finds downstream consumers.
`);
		const detectorResult = await scoreImportDependencies(normalizePhase3Input({
			currentIssue: {
				id: 'forge-9zv',
				title: 'Logic-level dependency detection in /plan Phase 3',
			},
			openIssues: [
				{
					id: 'forge-puh',
					title: 'Multi-developer workflow',
					files: ['features/dashboard.js', 'features/esm-dashboard.mjs'],
				},
			],
			repositoryRoot,
			taskFile,
		}));

		expect(detectorResult.evidence).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					type: 'call',
					consumerFile: 'features/dashboard.js',
					targetFile: 'lib/progress.js',
					symbol: 'parseProgress',
				}),
				expect.objectContaining({
					type: 'call',
					consumerFile: 'features/esm-dashboard.mjs',
					targetFile: 'lib/progress.js',
					symbol: 'parseProgress',
				}),
			]),
		);
	});

	test('scoreImportDependencies detects member calls through CommonJS module bindings', async () => {
		const repositoryRoot = createTempRepo({
			'lib/progress.js': `function parseProgress(raw) {
  return raw.trim().toUpperCase();
}

module.exports = {
  parseProgress,
};
`,
			'features/dashboard.js': `const progress = require('../lib/progress');

function renderDashboard(raw) {
  return progress.parseProgress(raw);
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

		const detectorResult = await scoreImportDependencies(normalizePhase3Input({
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
		}));

		expect(detectorResult.evidence).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					type: 'call',
					consumerFile: 'features/dashboard.js',
					targetFile: 'lib/progress.js',
					symbol: 'parseProgress',
				}),
			]),
		);
	});

	test('scoreImportDependencies skips default-excluded directories during repo scans', async () => {
		const repositoryRoot = createTempRepo({
			'lib/progress.js': `function parseProgress(raw) {
  return raw.trim().toUpperCase();
}

module.exports = {
  parseProgress,
};
`,
			'test/dashboard.test.js': `const { parseProgress } = require('../lib/progress');

function renderDashboard(raw) {
  return parseProgress(raw);
}
`,
			'docs/example.js': `const { parseProgress } = require('../lib/progress');

function renderExample(raw) {
  return parseProgress(raw);
}
`,
		});
		const taskFile = createTaskFile(repositoryRoot, `# Task List: logic-level-dependency-detection

## Task 1: Update progress parsing

File(s): \`lib/progress.js\`

What to implement: Update parseProgress() for the new plan status format.

Expected output: import detection finds downstream consumers.
`);

		const detectorResult = await scoreImportDependencies(normalizePhase3Input({
			currentIssue: {
				id: 'forge-9zv',
				title: 'Logic-level dependency detection in /plan Phase 3',
			},
			openIssues: [
				{
					id: 'forge-puh',
					title: 'Multi-developer workflow',
					files: ['test/dashboard.test.js', 'docs/example.js'],
				},
			],
			repositoryRoot,
			taskFile,
		}));

		expect(detectorResult.score).toBe(0);
		expect(detectorResult.findings).toEqual([]);
		expect(detectorResult.evidence).toEqual([]);
	});

	test('scoreImportDependencies skips unreadable files instead of aborting the analysis', async () => {
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
			'features/broken.js': `const { parseProgress } = require('../lib/progress');

function renderBroken(raw) {
  return parseProgress(raw);
}
`,
		});
		const taskFile = createTaskFile(repositoryRoot, `# Task List: logic-level-dependency-detection

## Task 1: Update progress parsing

File(s): \`lib/progress.js\`

What to implement: Update parseProgress() for the new plan status format.

Expected output: import detection finds downstream consumers.
`);
		const brokenFile = path.join(repositoryRoot, 'features', 'broken.js');
		fs.readFileSync = ((filePath, ...args) => {
			if (path.resolve(filePath) === brokenFile) {
				throw new Error('synthetic read failure');
			}

			return originalReadFileSync.call(fs, filePath, ...args);
		});

		const detectorResult = await scoreImportDependencies(normalizePhase3Input({
			currentIssue: {
				id: 'forge-9zv',
				title: 'Logic-level dependency detection in /plan Phase 3',
			},
			openIssues: [
				{
					id: 'forge-puh',
					title: 'Multi-developer workflow',
					files: ['features/dashboard.js', 'features/broken.js'],
				},
			],
			repositoryRoot,
			taskFile,
		}));

		expect(detectorResult.evidence).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					consumerFile: 'features/dashboard.js',
					symbol: 'parseProgress',
				}),
			]),
		);
		expect(detectorResult.evidence).not.toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					consumerFile: 'features/broken.js',
				}),
			]),
		);
	});
});
