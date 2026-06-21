'use strict';

const { describe, test, expect, beforeEach, afterEach } = require('bun:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createLocalBroker } = require('../../lib/kernel/broker');
const { createBuiltinSQLiteDriver } = require('../../lib/kernel/sqlite-driver');

// Wave 4 (K-DRV): dependencies + claims through the broker's guarded-event path.
// dep.add/dep.remove and claim/release are issue mutations that build a kernel
// event (entity_type 'dependency'/'claim') and run through runGuardedEvent. The
// real SQLite driver supplies the low-level claim primitives (loadActiveKernelClaim
// / insertKernelClaim / updateKernelClaimState) plus the dependency/claim authority
// writes (applyAcceptedIssueMutation). The single-active-claim-per-issue lease is a
// DB-enforced partial UNIQUE index, exercised end-to-end here.
describe('Kernel SQLite driver — dependencies + claims via guarded path (Wave 4)', () => {
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
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kdrv-deps-'));
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

	// --- Dependencies -----------------------------------------------------------

	test('dep.add inserts a dependency row and makes the dependent blocked (out of ready)', async () => {
		await createIssue('dep-a', 'Dependent');
		await createIssue('dep-b', 'Blocker');

		// dep-a is blocked BY dep-b: issue_id=dep-a, blocks_issue_id=dep-b.
		const added = await broker.runIssueOperation(
			'dep.add',
			['--issue', 'dep-a', '--blocks', 'dep-b'],
			{ now, actor: 'tester' },
		);

		expect(added.ok).toBe(true);
		expect(added.command).toBe('issue.dep.add');
		expect(typeof added.data.dependency_id).toBe('string');
		expect(added.data.dependency_id.length).toBeGreaterThan(0);

		const rows = await driver.queryAll('SELECT * FROM kernel_dependencies', config);
		expect(rows).toHaveLength(1);
		expect(rows[0].issue_id).toBe('dep-a');
		expect(rows[0].blocks_issue_id).toBe('dep-b');

		// dep-a is now blocked → absent from the ready queue; dep-b is ready.
		const ready = await driver.issueOperation('ready', [], { now }, config);
		const readyIds = ready.data.issues.map(issue => issue.id);
		expect(readyIds).toContain('dep-b');
		expect(readyIds).not.toContain('dep-a');

		const shown = await driver.issueOperation('show', ['dep-a'], { now }, config);
		expect(shown.data.blocked).toBe(true);
	});

	test('dep.add resolves endpoints from positional args (the documented CLI form)', async () => {
		await createIssue('pos-a', 'Dependent');
		await createIssue('pos-b', 'Blocker');

		// Positional form: `forge issue dep add <issue-id> <blocks-issue-id>` with no
		// --issue/--blocks flags. Previously this left issue_id undefined and the
		// dependency INSERT failed with "cannot be bound to SQLite parameter 2".
		const added = await broker.runIssueOperation(
			'dep.add',
			['pos-a', 'pos-b'],
			{ now, actor: 'tester' },
		);

		expect(added.ok).toBe(true);
		expect(added.command).toBe('issue.dep.add');

		const rows = await driver.queryAll('SELECT * FROM kernel_dependencies', config);
		expect(rows).toHaveLength(1);
		expect(rows[0].issue_id).toBe('pos-a');
		expect(rows[0].blocks_issue_id).toBe('pos-b');

		const ready = await driver.issueOperation('ready', [], { now }, config);
		expect(ready.data.issues.map(issue => issue.id)).not.toContain('pos-a');
	});

	test('dep.remove deletes the dependency row and restores the dependent to ready', async () => {
		await createIssue('rem-a', 'Dependent');
		await createIssue('rem-b', 'Blocker');
		await broker.runIssueOperation(
			'dep.add',
			['--issue', 'rem-a', '--blocks', 'rem-b'],
			{ now, actor: 'tester' },
		);

		const removed = await broker.runIssueOperation(
			'dep.remove',
			['--issue', 'rem-a', '--blocks', 'rem-b'],
			{ now: '2026-06-20T00:01:00.000Z', actor: 'tester' },
		);

		expect(removed.ok).toBe(true);
		expect(removed.command).toBe('issue.dep.remove');

		const rows = await driver.queryAll('SELECT * FROM kernel_dependencies', config);
		expect(rows).toHaveLength(0);

		const ready = await driver.issueOperation('ready', [], { now }, config);
		const readyIds = ready.data.issues.map(issue => issue.id);
		expect(readyIds).toContain('rem-a');
	});

	// KAP-8: closing a blocker surfaces the dependents that become ready.
	test('close surfaces newly_unblocked dependents whose only blocker is now done', async () => {
		// B depends on A (issue_id=B, blocks_issue_id=A) → B is blocked while A is open.
		await createIssue('unb-a', 'Blocker');
		await createIssue('unb-b', 'Dependent');
		await broker.runIssueOperation(
			'dep.add', ['--issue', 'unb-b', '--blocks', 'unb-a'], { now, actor: 'tester' },
		);

		// B is blocked before the close.
		const before = await driver.issueOperation('ready', [], { now }, config);
		expect(before.data.issues.map(i => i.id)).not.toContain('unb-b');

		const closed = await broker.runIssueOperation(
			'close', ['unb-a'], { now: '2026-06-20T00:02:00.000Z', actor: 'tester' },
		);

		expect(closed.ok).toBe(true);
		expect(closed.command).toBe('issue.close');
		// A is done → B's only blocker is terminal → B flips to ready.
		expect(closed.data.newly_unblocked).toEqual(['unb-b']);
	});

	test('close newly_unblocked omits dependents that still have another open blocker', async () => {
		// C depends on BOTH A and another open issue D — closing A alone must NOT unblock C.
		await createIssue('two-a', 'BlockerA');
		await createIssue('two-d', 'BlockerD');
		await createIssue('two-c', 'Dependent');
		await broker.runIssueOperation(
			'dep.add', ['--issue', 'two-c', '--blocks', 'two-a'], { now, actor: 'tester' },
		);
		await broker.runIssueOperation(
			'dep.add', ['--issue', 'two-c', '--blocks', 'two-d'], { now: '2026-06-20T00:01:00.000Z', actor: 'tester' },
		);

		const closed = await broker.runIssueOperation(
			'close', ['two-a'], { now: '2026-06-20T00:02:00.000Z', actor: 'tester' },
		);

		expect(closed.ok).toBe(true);
		// D is still open, so C stays blocked → not newly unblocked.
		expect(closed.data.newly_unblocked).toEqual([]);
	});

	test('dep.add closing a cycle quarantines as dependency_cycle and writes no edge', async () => {
		await createIssue('cyc-a');
		await createIssue('cyc-b');
		// a blocked by b.
		await broker.runIssueOperation(
			'dep.add',
			['--issue', 'cyc-a', '--blocks', 'cyc-b'],
			{ now, actor: 'tester' },
		);

		// b blocked by a → closes a cycle, must quarantine.
		const cycle = await broker.runIssueOperation(
			'dep.add',
			['--issue', 'cyc-b', '--blocks', 'cyc-a'],
			{ now: '2026-06-20T00:01:00.000Z', actor: 'tester' },
		);

		expect(cycle.ok).toBe(false);
		expect(cycle.command).toBe('issue.dep.add');
		expect(cycle.error.code).toContain('DEPENDENCY_CYCLE');
		expect(cycle.error.exit_code).toBe(4);

		// Only the first (valid) edge persists; the cycle edge was never written.
		const rows = await driver.queryAll('SELECT * FROM kernel_dependencies', config);
		expect(rows).toHaveLength(1);
		expect(rows[0].issue_id).toBe('cyc-a');

		const conflicts = await driver.queryAll('SELECT * FROM kernel_conflicts', config);
		expect(conflicts).toHaveLength(1);
	});

	// --- Claims -----------------------------------------------------------------

	test('claim creates an active lease row and returns a claim_id', async () => {
		await createIssue('clm-1', 'Claimable');

		const claimed = await broker.runIssueOperation(
			'claim',
			['--issue', 'clm-1'],
			{ now, actor: 'alice' },
		);

		expect(claimed.ok).toBe(true);
		expect(claimed.command).toBe('claim');
		expect(typeof claimed.data.claim_id).toBe('string');
		expect(claimed.data.claim_id.length).toBeGreaterThan(0);

		const rows = await driver.queryAll('SELECT * FROM kernel_claims', config);
		expect(rows).toHaveLength(1);
		expect(rows[0].issue_id).toBe('clm-1');
		expect(rows[0].actor).toBe('alice');
		expect(rows[0].state).toBe('active');
	});

	test('a second claim on the same issue by another actor is a non-retryable conflict (lease held)', async () => {
		await createIssue('clm-2', 'Contended');

		const first = await broker.runIssueOperation(
			'claim',
			['--issue', 'clm-2'],
			{ now, actor: 'alice' },
		);
		expect(first.ok).toBe(true);

		const second = await broker.runIssueOperation(
			'claim',
			['--issue', 'clm-2'],
			{ now: '2026-06-20T00:01:00.000Z', actor: 'bob' },
		);

		expect(second.ok).toBe(false);
		expect(second.command).toBe('claim');
		expect(second.error.code).toContain('CLAIM_CONFLICT');
		expect(second.error.exit_code).toBe(4);
		expect(second.error.retryable).toBe(false);

		// Exactly one active lease survives; it still belongs to alice.
		const active = await driver.queryAll(
			'SELECT * FROM kernel_claims WHERE issue_id = \'clm-2\' AND state = \'active\'',
			config,
		);
		expect(active).toHaveLength(1);
		expect(active[0].actor).toBe('alice');
	});

	test('release clears the active lease so the issue can be claimed again', async () => {
		await createIssue('clm-3', 'Releasable');
		await broker.runIssueOperation('claim', ['--issue', 'clm-3'], { now, actor: 'alice' });

		const released = await broker.runIssueOperation(
			'release',
			['--issue', 'clm-3'],
			{ now: '2026-06-20T00:01:00.000Z', actor: 'alice' },
		);
		expect(released.ok).toBe(true);
		expect(released.command).toBe('release');

		const active = await driver.queryAll(
			'SELECT * FROM kernel_claims WHERE issue_id = \'clm-3\' AND state = \'active\'',
			config,
		);
		expect(active).toHaveLength(0);

		// A fresh actor may now acquire the issue.
		const reclaimed = await broker.runIssueOperation(
			'claim',
			['--issue', 'clm-3'],
			{ now: '2026-06-20T00:02:00.000Z', actor: 'bob' },
		);
		expect(reclaimed.ok).toBe(true);

		const nowActive = await driver.queryAll(
			'SELECT * FROM kernel_claims WHERE issue_id = \'clm-3\' AND state = \'active\'',
			config,
		);
		expect(nowActive).toHaveLength(1);
		expect(nowActive[0].actor).toBe('bob');
	});

	test('loadActiveKernelClaim returns an expired-but-active row so the broker can reclaim it', async () => {
		await createIssue('clm-4', 'Expiring');
		await broker.runIssueOperation(
			'claim',
			['--issue', 'clm-4', '--expires', '2026-06-20T00:00:30.000Z'],
			{ now, actor: 'alice' },
		);

		// A new claim by bob AFTER the lease expired must succeed by superseding the
		// stale lease (planClaimAcquisition reclaim path needs the still-active row).
		const reclaimed = await broker.runIssueOperation(
			'claim',
			['--issue', 'clm-4'],
			{ now: '2026-06-20T01:00:00.000Z', actor: 'bob' },
		);
		expect(reclaimed.ok).toBe(true);

		const active = await driver.queryAll(
			'SELECT * FROM kernel_claims WHERE issue_id = \'clm-4\' AND state = \'active\'',
			config,
		);
		expect(active).toHaveLength(1);
		expect(active[0].actor).toBe('bob');
	});

	test('the DB partial-unique index rejects a second active lease for the same issue', async () => {
		// The user-facing claim conflict tests above all short-circuit on the broker's
		// in-memory pre-read (planClaimAcquisition sees the active row before any
		// transaction). This drives the DB-level invariant DIRECTLY — two raw active
		// inserts for one issue — proving (a) the partial UNIQUE index actually rejects
		// the second lease, and (b) the real bun:sqlite error message matches the exact
		// predicate broker.isClaimLeaseConflict relies on to recover a multi-process race.
		await createIssue('lease-x', 'Index guard');
		const base = { issue_id: 'lease-x', state: 'active', claimed_at: now, expires_at: null };
		await driver.insertKernelClaim({ ...base, id: 'claim-a', actor: 'alice' }, {}, config);

		let err;
		try {
			await driver.insertKernelClaim({ ...base, id: 'claim-b', actor: 'bob' }, {}, config);
		} catch (caught) {
			err = caught;
		}

		expect(err).toBeDefined();
		expect(String(err.message)).toMatch(/UNIQUE constraint failed/i);
		expect(String(err.message)).toMatch(/kernel_claims\.issue_id/i);

		const active = await driver.queryAll(
			'SELECT * FROM kernel_claims WHERE issue_id = \'lease-x\' AND state = \'active\'',
			config,
		);
		expect(active).toHaveLength(1);
	});

	test('a same-actor claim retry replays as a single lease (idempotent, no conflict)', async () => {
		await createIssue('clm-5', 'Retryable');
		const args = ['--issue', 'clm-5'];
		const ctx = { now, actor: 'alice', idempotencyKey: 'claim:clm-5:alice' };

		const first = await broker.runIssueOperation('claim', args, ctx);
		expect(first.ok).toBe(true);

		const retry = await broker.runIssueOperation('claim', args, { ...ctx, now: '2026-06-20T00:01:00.000Z' });
		expect(retry.ok).toBe(true);

		const rows = await driver.queryAll('SELECT * FROM kernel_claims WHERE issue_id = \'clm-5\'', config);
		expect(rows).toHaveLength(1);
	});
});
