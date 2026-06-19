const { afterAll, beforeAll, describe, expect, test } = require('bun:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createBuiltinSQLiteDriver } = require('../../lib/kernel/sqlite-driver');
const { buildKernelMigrationPlan } = require('../../lib/kernel/migrations');

// Real multi-process contention proof (tasks 9.5.1 / 9.5.3): spawn N independent
// OS processes that all race to claim the SAME issue against ONE on-disk WAL
// database, and assert the DB-enforced invariant holds — exactly one active
// claim row survives and every other process observes a conflict. This is the
// load-bearing guarantee for local multi-agent safety; the broker's recovery
// logic on top of it is proven separately with unit-level mocks.

const WORKER = path.join(__dirname, 'fixtures', 'claim-race-worker.js');
const ISSUE_ID = 'issue-race-1';
const WORKER_COUNT = 5;

let tmpDir;
let databasePath;

async function applySetup() {
	const driver = createBuiltinSQLiteDriver({ databasePath });
	try {
		await driver.exec('PRAGMA journal_mode=WAL;');
		await driver.exec('PRAGMA foreign_keys=ON;');
		for (const statement of buildKernelMigrationPlan().apply) {
			await driver.exec(statement);
		}
		// The claim FK requires the parent issue to exist.
		await driver.exec(
			"INSERT INTO kernel_issues (id, title, created_at, updated_at) VALUES ("
			+ `'${ISSUE_ID}', 'Race target', '2026-06-18T00:00:00.000Z', '2026-06-18T00:00:00.000Z'`
			+ ');',
		);
	} finally {
		// Close so the workers do not contend with the setup connection's lock.
		driver.close();
	}
}

async function countActiveClaims() {
	const driver = createBuiltinSQLiteDriver({ databasePath });
	try {
		const rows = await driver.queryAll(
			`SELECT COUNT(*) AS n FROM kernel_claims WHERE issue_id = '${ISSUE_ID}' AND state = 'active';`,
		);
		return Number(rows[0].n);
	} finally {
		driver.close();
	}
}

beforeAll(async () => {
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-claim-race-'));
	databasePath = path.join(tmpDir, 'kernel.sqlite');
	await applySetup();
});

afterAll(() => {
	if (tmpDir) {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	}
});

describe('local Kernel claim lease multi-process contention (9.5.1 / 9.5.3)', () => {
	test('exactly one of N racing processes acquires the lease; the rest see a conflict', async () => {
		const procs = Array.from({ length: WORKER_COUNT }, (_unused, i) => globalThis.Bun.spawn({
			cmd: ['bun', WORKER, databasePath, ISSUE_ID, String(i)],
			stdout: 'pipe',
			stderr: 'pipe',
		}));

		const results = await Promise.all(procs.map(async (proc) => {
			const stdout = (await new Response(proc.stdout).text()).trim();
			const stderr = (await new Response(proc.stderr).text()).trim();
			await proc.exited;
			return { stdout, stderr, code: proc.exitCode };
		}));

		// No worker hit an unexpected (non-conflict) error.
		for (const result of results) {
			expect(result.stderr).toBe('');
			expect(result.code).toBe(0);
		}

		const acquired = results.filter(r => r.stdout === 'acquired').length;
		const conflicts = results.filter(r => r.stdout === 'conflict').length;

		expect(acquired).toBe(1);
		expect(conflicts).toBe(WORKER_COUNT - 1);
		// The DB-level invariant: one issue can hold at most one active lease.
		expect(await countActiveClaims()).toBe(1);
	}, 30000);
});
