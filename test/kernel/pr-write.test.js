'use strict';

const { describe, test, expect, beforeEach, afterEach } = require('bun:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createLocalBroker } = require('../../lib/kernel/broker');
const { createBuiltinSQLiteDriver } = require('../../lib/kernel/sqlite-driver');

// W-S4 design §5a: the kernel_pr WRITE path — the reconciler's register/refresh
// (upsertPr), the ONE verdict authority with freshest-head precedence
// (updatePrVerdict), and retire (retirePr). pr rows are DERIVED reconcile state
// (reconstructable from GitHub), so they take a direct idempotent upsert, NOT the
// event-sourced guarded path. All target the physical `kernel_pr` table.
describe('kernel_pr write path (§5a)', () => {
	let tmpDir;
	let driver;
	let config;

	function makeBroker() {
		return createLocalBroker({
			projectRoot: tmpDir,
			execFileSync: () => path.join(tmpDir, '.git'),
			databasePath: config.databasePath,
			driver,
		});
	}

	async function readRow(gitCommonDir, repo, number) {
		const rows = await driver.queryAll(
			`SELECT * FROM kernel_pr WHERE git_common_dir = '${gitCommonDir}' AND repo = '${repo}' AND number = ${number};`,
			config,
		);
		return rows[0];
	}

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kpr-write-'));
		config = { databasePath: path.join(tmpDir, 'kernel.sqlite') };
		driver = createBuiltinSQLiteDriver({});
	});

	afterEach(() => {
		if (driver) driver.close();
		if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	test('upsertPr twice with the same natural key → exactly one row (idempotent)', async () => {
		const broker = makeBroker();
		await broker.initialize();

		const key = { git_common_dir: '/repo-a/.git', repo: 'owner/a', number: 5 };
		await broker.upsertPr({ ...key, branch: 'feat/5', head_sha: 'shaA', journal_ptr: 'j1' });
		await broker.upsertPr({ ...key, branch: 'feat/5', head_sha: 'shaB', journal_ptr: 'j2' });

		const all = await driver.queryAll(
			"SELECT * FROM kernel_pr WHERE git_common_dir = '/repo-a/.git' AND repo = 'owner/a' AND number = 5;",
			config,
		);
		expect(all.length).toBe(1);
		// DO UPDATE refreshed the mutable columns…
		expect(all[0].head_sha).toBe('shaB');
		expect(all[0].journal_ptr).toBe('j2');
		expect(all[0].state).toBe('open');
		// …registered_at is set on INSERT only (not overwritten on the second upsert).
		expect(all[0].registered_at).toBeTruthy();
	});

	test('upsertPr coalesces soft links: a later null issue_id does not clobber an existing one', async () => {
		const broker = makeBroker();
		await broker.initialize();
		const key = { git_common_dir: '/repo-a/.git', repo: 'owner/a', number: 7 };

		await broker.upsertPr({ ...key, head_sha: 'sha1', issue_id: 'ISSUE-1', worktree_id: 'WT-1' });
		await broker.upsertPr({ ...key, head_sha: 'sha2', issue_id: null, worktree_id: null });

		const row = await readRow('/repo-a/.git', 'owner/a', 7);
		expect(row.issue_id).toBe('ISSUE-1');
		expect(row.worktree_id).toBe('WT-1');
		expect(row.head_sha).toBe('sha2');
	});

	test('updatePrVerdict with a STALE head_sha does NOT overwrite a fresher-head verdict', async () => {
		const broker = makeBroker();
		await broker.initialize();
		const key = { git_common_dir: '/repo-a/.git', repo: 'owner/a', number: 9 };

		// Row is registered at the CURRENT head 'shaFresh'…
		await broker.upsertPr({ ...key, branch: 'feat/9', head_sha: 'shaFresh' });
		// …and a local verdict is computed against that same fresh head.
		await broker.updatePrVerdict(key, { verdict: 'approve', verdict_source: 'local', verdict_at: '2026-07-20T01:00:00.000Z', head_sha: 'shaFresh' });

		// A late Actions-backstop verdict arrives computed against a SUPERSEDED head.
		await broker.updatePrVerdict(key, { verdict: 'reject', verdict_source: 'github', verdict_at: '2026-07-20T02:00:00.000Z', head_sha: 'shaStale' });

		const row = await readRow('/repo-a/.git', 'owner/a', 9);
		// Discarded at the WRITE: the fresh local verdict stands, head unchanged.
		expect(row.verdict).toBe('approve');
		expect(row.verdict_source).toBe('local');
		expect(row.head_sha).toBe('shaFresh');
	});

	test('updatePrVerdict against the current head DOES write (matching head precedence)', async () => {
		const broker = makeBroker();
		await broker.initialize();
		const key = { git_common_dir: '/repo-a/.git', repo: 'owner/a', number: 11 };

		await broker.upsertPr({ ...key, head_sha: 'shaX' });
		await broker.updatePrVerdict(key, { verdict: 'approve', verdict_source: 'github', verdict_at: '2026-07-20T03:00:00.000Z', head_sha: 'shaX' });

		const row = await readRow('/repo-a/.git', 'owner/a', 11);
		expect(row.verdict).toBe('approve');
	});

	test('upsertPr INVALIDATES the prior verdict when the head advances to a new commit', async () => {
		// A new commit must not carry the old head's verdict forward as if fresh (Codex
		// P1 #426) — else a stale approval reads as current and the freshest-head guard
		// loses its evidence.
		const broker = makeBroker();
		await broker.initialize();
		const key = { git_common_dir: '/repo-a/.git', repo: 'owner/a', number: 19 };

		await broker.upsertPr({ ...key, head_sha: 'shaA' });
		await broker.updatePrVerdict(key, { verdict: 'approve', verdict_source: 'local', verdict_at: '2026-07-20T08:00:00.000Z', head_sha: 'shaA' });
		expect((await readRow('/repo-a/.git', 'owner/a', 19)).verdict).toBe('approve');

		// New commit → upsert refreshes head AND clears the now-stale verdict fields.
		await broker.upsertPr({ ...key, head_sha: 'shaB' });
		const row = await readRow('/repo-a/.git', 'owner/a', 19);
		expect(row.head_sha).toBe('shaB');
		expect(row.verdict).toBeFalsy();
		expect(row.verdict_source).toBeFalsy();
		expect(row.verdict_at).toBeFalsy();

		// A SAME-head refresh must NOT clear a verdict (only a head change invalidates).
		await broker.updatePrVerdict(key, { verdict: 'approve', verdict_source: 'local', verdict_at: '2026-07-20T09:00:00.000Z', head_sha: 'shaB' });
		await broker.upsertPr({ ...key, head_sha: 'shaB', branch: 'feat/19b' });
		const row2 = await readRow('/repo-a/.git', 'owner/a', 19);
		expect(row2.verdict).toBe('approve');
		expect(row2.branch).toBe('feat/19b');
	});

	test('a LOCAL verdict overrides a superseded head (source=local bypass); a github one would be discarded', async () => {
		// Guards the design's core "local is always authoritative" branch
		// (`OR ? = 'local'`). Without it this write would be discarded and the branch
		// is otherwise untested — deleting it leaves every other test green.
		const broker = makeBroker();
		await broker.initialize();
		const key = { git_common_dir: '/repo-a/.git', repo: 'owner/a', number: 15 };

		// Row registered at an OLD head. A github verdict against a NEW, mismatched head
		// is discarded (not the current head, not local).
		await broker.upsertPr({ ...key, head_sha: 'shaOld' });
		await broker.updatePrVerdict(key, { verdict: 'reject', verdict_source: 'github', verdict_at: '2026-07-20T05:00:00.000Z', head_sha: 'shaNew' });
		let row = await readRow('/repo-a/.git', 'owner/a', 15);
		expect(row.verdict).toBeFalsy(); // github mismatched-head write discarded

		// A LOCAL verdict against that same mismatched head DOES land — local is
		// authoritative (it holds the lease and polls fastest). This is the bypass branch.
		await broker.updatePrVerdict(key, { verdict: 'approve', verdict_source: 'local', verdict_at: '2026-07-20T06:00:00.000Z', head_sha: 'shaNew' });
		row = await readRow('/repo-a/.git', 'owner/a', 15);
		expect(row.verdict).toBe('approve');
		expect(row.verdict_source).toBe('local');
		expect(row.head_sha).toBe('shaNew');
	});

	test('updatePrVerdict lands on a row with no head_sha yet (head_sha IS NULL disjunct)', async () => {
		// Guards the first precedence disjunct: a freshly-registered row with no head
		// accepts its first verdict regardless of source. Deleting `head_sha IS NULL OR`
		// would leave this write with no matching disjunct.
		const broker = makeBroker();
		await broker.initialize();
		const key = { git_common_dir: '/repo-a/.git', repo: 'owner/a', number: 17 };

		await broker.upsertPr({ ...key, branch: 'feat/17' }); // no head_sha → stored null
		await broker.updatePrVerdict(key, { verdict: 'approve', verdict_source: 'github', verdict_at: '2026-07-20T07:00:00.000Z', head_sha: 'shaFirst' });

		const row = await readRow('/repo-a/.git', 'owner/a', 17);
		expect(row.verdict).toBe('approve');
		expect(row.head_sha).toBe('shaFirst');
	});

	test('retirePr sets state + retired_at', async () => {
		const broker = makeBroker();
		await broker.initialize();
		const key = { git_common_dir: '/repo-a/.git', repo: 'owner/a', number: 13 };

		await broker.upsertPr({ ...key, head_sha: 'shaZ' });
		await broker.retirePr(key, { state: 'merged', retired_at: '2026-07-20T04:00:00.000Z' });

		const row = await readRow('/repo-a/.git', 'owner/a', 13);
		expect(row.state).toBe('merged');
		expect(row.retired_at).toBe('2026-07-20T04:00:00.000Z');
		// A retired row drops out of the open-PR read.
		const open = await makeBroker().listOpenPrs('/repo-a/.git');
		expect(open.some(r => r.number === 13)).toBe(false);
	});
});
