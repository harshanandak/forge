'use strict';

// E2E: the JSONL portability round-trip through the REAL `forge` bin.
//
//   create → export (kernel.sqlite → .forge/kernel/*.jsonl) → simulate a fresh clone
//   (delete .git/forge so the DB is gone but the committed JSONL remains) → import →
//   the issue is restored.
//
// This is the dogfood proof for the hydration gap: before #this-PR, `forge export
// --import` validated the snapshot and wrote NOTHING, so a fresh clone saw zero
// issues despite committed JSONL. The "list is empty before import, present after"
// assertion pins that.

const { describe, test, expect, beforeEach, afterEach } = require('bun:test');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const FORGE_BIN = path.join(__dirname, '..', '..', 'bin', 'forge.js');

// Spawn the real forge bin with a scrubbed backend selector (pure kernel default).
function runForge(cwd, args) {
	const env = { ...process.env };
	delete env.FORGE_ISSUE_BACKEND;
	try {
		const stdout = execFileSync('node', [FORGE_BIN, ...args], {
			cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env,
		});
		return { stdout, status: 0 };
	} catch (error) {
		return { stdout: `${error.stdout || ''}${error.stderr || ''}`, status: typeof error.status === 'number' ? error.status : 1 };
	}
}

function rmrfWithRetry(dir) {
	for (let attempt = 0; attempt < 5; attempt += 1) {
		try { fs.rmSync(dir, { recursive: true, force: true }); return; }
		catch (error) {
			if (attempt === 4 || (error.code !== 'EBUSY' && error.code !== 'EPERM')) return;
			const until = Date.now() + 100;
			while (Date.now() < until) { /* brief spin before retry */ }
		}
	}
}

describe('forge JSONL portability — export → fresh clone → import round-trip', () => {
	let repo;

	beforeEach(() => {
		repo = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-jsonl-rt-'));
		execFileSync('git', ['init', '-q'], { cwd: repo });
		fs.writeFileSync(path.join(repo, 'AGENTS.md'), '# test\n'); // bypass first-run setup gate
	});

	afterEach(() => rmrfWithRetry(repo));

	test('a fresh clone restores committed issues via `forge export --import`', () => {
		// 1) Author an issue on the kernel, then project it to git-tracked JSONL.
		const created = runForge(repo, ['create', '--title', 'Round trip issue', '--type', 'task']);
		expect(created.status).toBe(0);
		const id = (created.stdout.match(/"id":\s*"([^"]+)"/) || [])[1];
		expect(id).toBeTruthy();

		const exported = runForge(repo, ['export']);
		expect(exported.stdout.toLowerCase()).toMatch(/exported kernel projection/);
		expect(fs.existsSync(path.join(repo, '.forge', 'kernel', 'issues.jsonl'))).toBe(true);

		// The exported record carries the FULL kernel_issues column set (schema v3), so
		// no column is silently stripped on export → hydrate. (Non-null values surviving
		// the round-trip are proven exhaustively in export-import-hydration.test.js.)
		const exportedRecord = JSON.parse(
			fs.readFileSync(path.join(repo, '.forge', 'kernel', 'issues.jsonl'), 'utf8').trim().split('\n')[0],
		);
		for (const column of [
			'labels', 'assignee', 'closed_at', 'close_reason', 'parent_id', 'sprint_id',
			'release_id', 'stage_state', 'acceptance_criteria', 'estimate', 'design', 'notes', 'metadata',
		]) {
			expect(exportedRecord).toHaveProperty(column);
		}

		// 2) Simulate a fresh clone: the kernel DB lives under .git (never cloned);
		//    delete it while the committed .forge/kernel JSONL survives.
		rmrfWithRetry(path.join(repo, '.git', 'forge'));
		const emptyList = runForge(repo, ['list']);
		expect(emptyList.stdout).toContain('"issues": []'); // the bug: zero issues before hydration

		// 3) Hydrate the fresh clone from the committed JSONL.
		const imported = runForge(repo, ['export', '--import']);
		expect(imported.status).toBe(0);
		expect(imported.stdout.toLowerCase()).toMatch(/imported kernel projection.*1 issues/);

		// 4) The issue is restored.
		const restored = runForge(repo, ['list']);
		expect(restored.stdout).toContain(id);
		expect(restored.stdout).toContain('Round trip issue');

		// 5) Idempotent: a second import applies nothing and does not duplicate.
		const again = runForge(repo, ['export', '--import']);
		expect(again.status).toBe(0);
		expect(again.stdout.toLowerCase()).toMatch(/already hydrated|nothing new/);
		const afterSecond = runForge(repo, ['list']);
		expect((afterSecond.stdout.match(new RegExp(id, 'g')) || []).length).toBe(1); // still one, not duplicated
	}, 45000);
});
