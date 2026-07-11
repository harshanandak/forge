'use strict';

const { describe, test, expect, beforeEach, afterEach } = require('bun:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createLocalBroker } = require('../../lib/kernel/broker');
const { createBuiltinSQLiteDriver } = require('../../lib/kernel/sqlite-driver');

// Issue 7dc229d4: expose the active lease/claims set as a read (`forge claims`).
// The kernel_claims lease row holds actor + session_id + worktree_id + expires_at
// + issue_id — everything a dashboard's live layer needs to show "who/what is on
// which issue". The `claims` read op returns the ACTIVE, non-expired leases with
// their full fields. Active = state='active' AND NOT isLeaseExpired(claim, now)
// (an expired-but-not-yet-reclaimed lease is NOT live).
describe('Kernel SQLite driver — claims read op (active leases)', () => {
	let tmpDir;
	let driver;
	let broker;
	let config;
	const now = '2026-06-20T00:00:00.000Z';

	async function createIssue(id, title = id) {
		return broker.runIssueOperation(
			'create',
			['--id', id, '--title', title, '--type', 'task'],
			{ now, actor: 'tester' },
		);
	}

	beforeEach(async () => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kdrv-claims-read-'));
		const dbPath = path.join(tmpDir, 'kernel.sqlite');
		config = { databasePath: dbPath };
		driver = createBuiltinSQLiteDriver({});
		broker = createLocalBroker({
			projectRoot: tmpDir,
			execFileSync: () => path.join(tmpDir, '.git'),
			databasePath: dbPath,
			driver,
		});
		await broker.initialize();
	});

	afterEach(() => {
		if (driver) driver.close();
		if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	test('returns an empty list (count 0) when no claims exist', async () => {
		const res = await driver.issueOperation('claims', [], { now }, config);
		expect(res.ok).toBe(true);
		expect(res.command).toBe('issue.claims');
		expect(res.data.claims).toEqual([]);
		expect(res.data.count).toBe(0);
	});

	test('returns active leases with their full lease fields', async () => {
		await createIssue('clm-a', 'Alpha');
		await broker.runIssueOperation(
			'claim',
			['--issue', 'clm-a'],
			{ now, actor: 'alice', sessionId: 'sess-a', worktreeId: 'wt-a' },
		);

		const res = await driver.issueOperation('claims', [], { now }, config);
		expect(res.ok).toBe(true);
		expect(res.data.count).toBe(1);
		expect(res.data.claims).toHaveLength(1);

		const claim = res.data.claims[0];
		// The dashboard-facing lease shape: every field the live layer needs.
		expect(claim.issue_id).toBe('clm-a');
		expect(claim.actor).toBe('alice');
		expect(claim.claimed_at).toBe(now);
		// session_id / worktree_id echo the claim's context exactly (not just present —
		// mapped to the RIGHT value). expires_at is null because no --expires was passed
		// (buildClaimRow / insertKernelClaimRow default it to null).
		expect(claim.session_id).toBe('sess-a');
		expect(claim.worktree_id).toBe('wt-a');
		expect(claim.expires_at).toBeNull();
		// `id` is the claim lease row id (a fresh randomUUID minted per claim in
		// buildClaimMutationEvent — never the issue id), so its exact value isn't
		// predictable here; assert its shape instead of just its presence.
		expect(typeof claim.id).toBe('string');
		expect(claim.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
	});

	test('excludes released leases (state != active)', async () => {
		await createIssue('clm-b', 'Beta');
		await broker.runIssueOperation('claim', ['--issue', 'clm-b'], { now, actor: 'alice' });
		await broker.runIssueOperation(
			'release',
			['--issue', 'clm-b'],
			{ now: '2026-06-20T00:01:00.000Z', actor: 'alice' },
		);

		const res = await driver.issueOperation('claims', [], { now: '2026-06-20T00:02:00.000Z' }, config);
		expect(res.ok).toBe(true);
		expect(res.data.count).toBe(0);
		expect(res.data.claims).toEqual([]);
	});

	test('excludes expired leases (state active but past expires_at at read `now`)', async () => {
		await createIssue('clm-c', 'Gamma');
		await broker.runIssueOperation(
			'claim',
			['--issue', 'clm-c', '--expires', '2026-06-20T00:00:30.000Z'],
			{ now, actor: 'alice' },
		);

		// Read BEFORE expiry → the lease is live.
		const live = await driver.issueOperation('claims', [], { now: '2026-06-20T00:00:10.000Z' }, config);
		expect(live.data.count).toBe(1);

		// Read AFTER expiry → the still-active-but-expired lease is NOT reported live.
		const expired = await driver.issueOperation('claims', [], { now: '2026-06-20T01:00:00.000Z' }, config);
		expect(expired.data.count).toBe(0);
		expect(expired.data.claims).toEqual([]);
	});

	test('a null-expiry lease never expires and is always reported active', async () => {
		await createIssue('clm-d', 'Delta');
		await broker.runIssueOperation('claim', ['--issue', 'clm-d'], { now, actor: 'alice' });

		const res = await driver.issueOperation('claims', [], { now: '3000-01-01T00:00:00.000Z' }, config);
		expect(res.data.count).toBe(1);
		expect(res.data.claims[0].expires_at).toBeNull();
	});
});
