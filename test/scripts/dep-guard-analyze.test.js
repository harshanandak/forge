const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { afterEach, describe, expect, test } = require('bun:test');

const SCRIPT = path.join(__dirname, '..', '..', 'scripts', 'dep-guard-analyze.js');

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

function createFixture(files) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dep-guard-analyze-'));
	for (const [relativePath, contents] of Object.entries(files)) {
		const absolutePath = path.join(root, relativePath);
		fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
		fs.writeFileSync(absolutePath, contents, 'utf8');
	}
	tempDirs.push(root);
	return root;
}

describe('scripts/dep-guard-analyze.js', () => {
	test('accepts array-shaped current issue payloads without jq pre-normalization', () => {
		const repositoryRoot = createFixture({
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
			'tasks.md': `# Task List: logic-level-dependency-detection

## Task 1: Update progress parsing

File(s): \`lib/progress.js\`

What to implement: Update \`parseProgress\` for the new plan status format.

Expected output: import detection finds downstream consumers.
`,
			'current.json': JSON.stringify([
				{
					id: 'forge-9zv',
					title: 'Logic-level dependency detection in /plan Phase 3',
					files: ['lib/progress.js'],
				},
			]),
			'open.json': JSON.stringify([
				{
					id: 'forge-puh',
					title: 'Multi-developer workflow',
					files: ['features/dashboard.js'],
				},
			]),
			'in-progress.json': '[]',
		});

		const result = spawnSync(
			process.execPath,
			[
				SCRIPT,
				path.join(repositoryRoot, 'current.json'),
				path.join(repositoryRoot, 'open.json'),
				path.join(repositoryRoot, 'in-progress.json'),
				path.join(repositoryRoot, 'tasks.md'),
				repositoryRoot,
			],
			{
				cwd: repositoryRoot,
				encoding: 'utf8',
			},
		);

		expect(result.status).toBe(0);
		const payload = JSON.parse(result.stdout);
		expect(payload.currentIssue.id).toBe('forge-9zv');
		expect(payload.issues).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					targetIssueId: 'forge-puh',
				}),
			]),
		);
	});

	test('accepts stdin payloads for direct structured ripple analysis', () => {
		const repositoryRoot = createFixture({
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
			'tasks.md': `# Task List: logic-level-dependency-detection

## Task 1: Update progress parsing

File(s): \`lib/progress.js\`

What to implement: Update \`parseProgress\` for the new plan status format.

Expected output: import detection finds downstream consumers.
`,
		});

		const payload = {
			currentIssue: {
				id: 'forge-9zv',
				title: 'Logic-level dependency detection in /plan Phase 3',
				files: ['lib/progress.js'],
			},
			openIssues: [
				{
					id: 'forge-puh',
					title: 'Multi-developer workflow',
					files: ['features/dashboard.js'],
				},
			],
			inProgressIssues: [],
			taskFile: path.join(repositoryRoot, 'tasks.md'),
			repositoryRoot,
		};

		const result = spawnSync(
			process.execPath,
			[SCRIPT, '--stdin'],
			{
				cwd: repositoryRoot,
				encoding: 'utf8',
				input: JSON.stringify(payload),
			},
		);

		expect(result.status).toBe(0);
		const analysis = JSON.parse(result.stdout);
		expect(analysis.currentIssue.id).toBe('forge-9zv');
		expect(analysis.issues).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					targetIssueId: 'forge-puh',
				}),
			]),
		);
	});
});
