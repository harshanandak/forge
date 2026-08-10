'use strict';

const { describe, test, expect, beforeEach, afterEach } = require('bun:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createLocalBroker } = require('../../lib/kernel/broker');
const { createBuiltinSQLiteDriver } = require('../../lib/kernel/sqlite-driver');

async function removeDirWithRetry(dir, attempts = 10) {
	for (let attempt = 0; attempt < attempts; attempt += 1) {
		try {
			fs.rmSync(dir, { recursive: true, force: true });
			return;
		} catch (error) {
			const locked = ['EBUSY', 'EPERM', 'ENOTEMPTY'].includes(error.code);
			if (!locked || attempt === attempts - 1) {
				if (locked) return;
				throw error;
			}
			await new Promise(resolve => setTimeout(resolve, 100));
		}
	}
}

describe('Kernel live claim authority projection', () => {
	let tmpDir;
	let driver;
	let broker;
	let config;
	const now = '2026-08-11T00:00:00.000Z';

	async function createIssue(id) {
		return broker.runIssueOperation(
			'create',
			['--id', id, '--title', id, '--type', 'task'],
			{ now, actor: 'tester' },
		);
	}

	async function claimIssue(id, actor = 'worker', args = []) {
		return broker.runIssueOperation('claim', ['--issue', id, ...args], { now, actor });
	}

	async function claimRows() {
		return driver.listActiveClaims({}, config);
	}

	beforeEach(async () => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'live-claim-projection-'));
		const databasePath = path.join(tmpDir, 'kernel.sqlite');
		config = { databasePath };
		driver = createBuiltinSQLiteDriver({});
		broker = createLocalBroker({
			projectRoot: tmpDir,
			execFileSync: () => path.join(tmpDir, '.git'),
			databasePath,
			driver,
		});
		await broker.initialize();
	});

	afterEach(async () => {
		if (driver) driver.close();
		if (tmpDir) await removeDirWithRetry(tmpDir);
	});

	test('claims, stats, claimed_by, owns, and readiness share one live authority definition', async () => {
		await createIssue('live-null-expiry');
		await claimIssue('live-null-expiry', 'live-worker');

		await createIssue('expired');
		await claimIssue('expired', 'expired-worker', ['--expires', '2026-08-11T00:01:00.000Z']);

		await createIssue('terminal-with-stale-row');
		await claimIssue('terminal-with-stale-row', 'terminal-worker');
		await driver.exec(
			"UPDATE kernel_issues SET status = 'done' WHERE id = 'terminal-with-stale-row';",
			config,
		);

		const readAt = '2026-08-11T00:02:00.000Z';
		const claims = await driver.issueOperation('claims', [], { now: readAt, actor: 'observer' }, config);
		expect(claims.data.claims.map(claim => claim.issue_id)).toEqual(['live-null-expiry']);

		const stats = await driver.issueOperation('stats', [], { now: readAt, actor: 'observer' }, config);
		expect(stats.data.active_claims).toBe(1);

		const live = await driver.issueOperation('show', ['live-null-expiry'], { now: readAt }, config);
		const expired = await driver.issueOperation('show', ['expired'], { now: readAt }, config);
		const terminal = await driver.issueOperation('show', ['terminal-with-stale-row'], { now: readAt }, config);
		expect(live.data.claimed_by).toBe('live-worker');
		expect(expired.data.claimed_by).toBeNull();
		expect(terminal.data.claimed_by).toBeNull();

		const expiredOwns = await driver.issueOperation(
			'owns', ['expired'], { now: readAt, actor: 'expired-worker' }, config,
		);
		const terminalOwns = await driver.issueOperation(
			'owns', ['terminal-with-stale-row'], { now: readAt, actor: 'terminal-worker' }, config,
		);
		expect(expiredOwns.data).toMatchObject({ owned: false, claimed_by: null, expired: true });
		expect(terminalOwns.data).toMatchObject({ owned: false, claimed_by: null, expired: false });

		const ready = await driver.issueOperation('ready', [], { now: readAt, actor: 'observer' }, config);
		expect(ready.data.issues.map(issue => issue.id)).toContain('expired');
		expect(ready.data.issues.map(issue => issue.id)).not.toContain('live-null-expiry');
	});

	test('a future terminal transition atomically releases the exact current claim', async () => {
		await createIssue('close-me');
		await claimIssue('close-me', 'worker-a');

		const closed = await broker.runIssueOperation(
			'close', ['close-me'], { now: '2026-08-11T00:01:00.000Z', actor: 'worker-a' },
		);
		expect(closed.ok).toBe(true);
		expect((await claimRows()).find(claim => claim.issue_id === 'close-me')).toBeUndefined();

		const projected = await driver.issueOperation(
			'claims', [], { now: '2026-08-11T00:01:00.000Z', actor: 'worker-a' }, config,
		);
		expect(projected.data.claims).toEqual([]);
	});
});
