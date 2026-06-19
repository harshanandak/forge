'use strict';

const { describe, test, expect, beforeEach, afterEach } = require('bun:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createLocalBroker } = require('../../lib/kernel/broker');
const { createBuiltinSQLiteDriver } = require('../../lib/kernel/sqlite-driver');

// Wave 3 (K-DRV): issue MUTATIONS through the broker's guarded-event path. The
// broker's runIssueOperation detects mutation ops, builds a kernel event from the
// CLI args, and routes through runGuardedEvent (CAS/idempotency/quarantine intact).
// The real SQLite driver supplies the commit writes commitGuardedAccept needs
// (issue upsert, entity_revision bump, comment insert) via applyAcceptedIssueMutation.
describe('Kernel SQLite driver — issue mutations via guarded path (Wave 3)', () => {
	let tmpDir;
	let driver;
	let broker;
	let config;
	const now = '2026-06-19T00:00:00.000Z';

	beforeEach(async () => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kdrv-mut-'));
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

	test('create then show round-trips a contract-shaped issue at revision 0', async () => {
		const created = await broker.runIssueOperation(
			'create',
			['--id', 'forge-1', '--title', 'Alpha task', '--type', 'task'],
			{ now, actor: 'tester' },
		);

		expect(created.ok).toBe(true);
		expect(created.schema_version).toBe('forge.issue.v1');
		expect(created.command).toBe('issue.create');
		expect(created.data.id).toBe('forge-1');
		expect(created.data.revision).toBe(0);

		const shown = await driver.issueOperation('show', ['forge-1'], {}, config);
		expect(shown.ok).toBe(true);
		expect(shown.data).toMatchObject({
			id: 'forge-1',
			title: 'Alpha task',
			type: 'task',
			status: 'open',
			revision: 0,
		});
	});

	test('update --status bumps the entity_revision', async () => {
		await broker.runIssueOperation(
			'create',
			['--id', 'forge-2', '--title', 'Beta', '--type', 'task'],
			{ now, actor: 'tester' },
		);

		const updated = await broker.runIssueOperation(
			'update',
			['forge-2', '--status', 'in_progress'],
			{ now: '2026-06-19T00:01:00.000Z', actor: 'tester' },
		);

		expect(updated.ok).toBe(true);
		expect(updated.command).toBe('issue.update');
		expect(updated.data.id).toBe('forge-2');
		expect(updated.data.revision).toBe(1);

		const shown = await driver.issueOperation('show', ['forge-2'], {}, config);
		expect(shown.data.status).toBe('in_progress');
		expect(shown.data.revision).toBe(1);
	});

	test('close drives the issue to a terminal status and bumps the revision', async () => {
		await broker.runIssueOperation(
			'create',
			['--id', 'forge-3', '--title', 'Gamma', '--type', 'task'],
			{ now, actor: 'tester' },
		);

		const closed = await broker.runIssueOperation(
			'close',
			['forge-3'],
			{ now: '2026-06-19T00:02:00.000Z', actor: 'tester' },
		);

		expect(closed.ok).toBe(true);
		expect(closed.command).toBe('issue.close');
		expect(closed.data.revision).toBe(1);

		const shown = await driver.issueOperation('show', ['forge-3'], {}, config);
		expect(shown.data.status).toBe('done');
	});

	test('comment appends a row to kernel_comments and returns a comment_id', async () => {
		await broker.runIssueOperation(
			'create',
			['--id', 'forge-4', '--title', 'Delta', '--type', 'task'],
			{ now, actor: 'tester' },
		);

		const commented = await broker.runIssueOperation(
			'comment',
			['forge-4', 'A handoff note'],
			{ now: '2026-06-19T00:03:00.000Z', actor: 'tester' },
		);

		expect(commented.ok).toBe(true);
		expect(commented.command).toBe('issue.comment');
		expect(typeof commented.data.comment_id).toBe('string');
		expect(commented.data.comment_id.length).toBeGreaterThan(0);

		const rows = await driver.queryAll('SELECT * FROM kernel_comments WHERE issue_id = \'forge-4\'', config);
		expect(rows).toHaveLength(1);
		expect(rows[0].body).toBe('A handoff note');
		expect(rows[0].actor).toBe('tester');
	});

	test('a second comment on the same issue appends a distinct row (no idempotency collision)', async () => {
		await broker.runIssueOperation(
			'create',
			['--id', 'forge-4b', '--title', 'Delta', '--type', 'task'],
			{ now, actor: 'tester' },
		);

		const first = await broker.runIssueOperation(
			'comment', ['forge-4b', 'First note'], { now: '2026-06-19T00:03:00.000Z', actor: 'tester' },
		);
		const second = await broker.runIssueOperation(
			'comment', ['forge-4b', 'Second note'], { now: '2026-06-19T00:03:30.000Z', actor: 'tester' },
		);

		expect(first.data.comment_id).not.toBe(second.data.comment_id);
		const rows = await driver.queryAll('SELECT * FROM kernel_comments WHERE issue_id = \'forge-4b\' ORDER BY created_at ASC', config);
		expect(rows).toHaveLength(2);
		expect(rows.map(row => row.body)).toEqual(['First note', 'Second note']);
	});

	test('create twice through runIssueOperation replays as a single row (duplicate mapping)', async () => {
		const createArgs = ['--id', 'forge-dup', '--title', 'Dup', '--type', 'task'];

		const first = await broker.runIssueOperation('create', createArgs, { now, actor: 'tester' });
		expect(first.ok).toBe(true);
		expect(first.data.revision).toBe(0);

		// Same --id → same synthesized idempotency key → duplicate replay, NOT a
		// second row. The mapped response stays ok and reports the single row.
		const second = await broker.runIssueOperation('create', createArgs, { now: '2026-06-19T00:07:00.000Z', actor: 'tester' });
		expect(second.ok).toBe(true);
		expect(second.command).toBe('issue.create');
		expect(second.data.id).toBe('forge-dup');
		expect(second.data.revision).toBe(0);

		const rows = await driver.queryAll('SELECT * FROM kernel_issues WHERE id = \'forge-dup\'', config);
		expect(rows).toHaveLength(1);
	});

	test('a stale expected_revision quarantines against the real driver and leaves the issue untouched', async () => {
		await broker.runIssueOperation(
			'create',
			['--id', 'forge-5', '--title', 'Epsilon', '--type', 'task'],
			{ now, actor: 'tester' },
		);
		// Drive the CAS forward once so the live revision is 1.
		await broker.runIssueOperation(
			'update',
			['forge-5', '--status', 'in_progress'],
			{ now: '2026-06-19T00:04:00.000Z', actor: 'tester' },
		);

		// A guarded event with a behind expected_revision (0 against live 1) must
		// quarantine — this is the CAS proof against the REAL driver.
		const stale = await broker.runGuardedEvent({
			entity_type: 'issue',
			entity_id: 'forge-5',
			event_type: 'issue.update',
			idempotency_key: 'issue-update:forge-5:stale',
			expected_revision: 0,
			actor: 'tester',
			origin: 'cli',
			payload: { status: 'review' },
		}, { now: '2026-06-19T00:05:00.000Z' });

		expect(stale.decision).toBe('quarantine');
		expect(stale.reason).toBe('stale_revision');

		const conflicts = await driver.queryAll('SELECT * FROM kernel_conflicts', config);
		expect(conflicts).toHaveLength(1);
		expect(conflicts[0].entity_id).toBe('forge-5');

		// The issue row is untouched by the quarantined write.
		const shown = await driver.issueOperation('show', ['forge-5'], {}, config);
		expect(shown.data.revision).toBe(1);
		expect(shown.data.status).toBe('in_progress');
	});

	test('a duplicate idempotency key replays as a single row (no double-write)', async () => {
		const event = () => ({
			entity_type: 'issue',
			entity_id: 'forge-6',
			event_type: 'issue.create',
			idempotency_key: 'issue-create:forge-6',
			expected_revision: 0,
			actor: 'tester',
			origin: 'cli',
			payload: { id: 'forge-6', title: 'Zeta', type: 'task', status: 'open' },
		});

		const first = await broker.runGuardedEvent(event(), { now });
		expect(first.decision).toBe('accept');

		const replay = await broker.runGuardedEvent(event(), { now: '2026-06-19T00:06:00.000Z' });
		expect(replay.decision).toBe('duplicate');

		const rows = await driver.queryAll('SELECT * FROM kernel_issues WHERE id = \'forge-6\'', config);
		expect(rows).toHaveLength(1);
		const events = await driver.queryAll('SELECT * FROM kernel_events WHERE idempotency_key = \'issue-create:forge-6\'', config);
		expect(events).toHaveLength(1);
	});

	test('runIssueOperation maps a quarantine decision to a retryable conflict error', async () => {
		// Drive the user-facing path (runIssueOperation → mapMutationResult) into the
		// quarantine branch with a fake whose stored revision is ahead of what
		// buildIssueMutationEvent reads — proving the error shape the adapter returns.
		const fake = {
			async exec() {},
			async issueOperation() { throw new Error('reads only'); },
			loadKernelEntityCalls: 0,
			async loadKernelEntity() {
				// First read (event build) sees revision 0; the guarded re-read sees 5,
				// so the evaluator quarantines as stale_revision.
				this.loadKernelEntityCalls += 1;
				return this.loadKernelEntityCalls === 1 ? { entity_revision: 0 } : { entity_revision: 5 };
			},
			async listKernelEvents() { return []; },
			async loadKernelEventByIdempotencyKey() { return null; },
			async insertKernelConflict(conflict) { return { ...conflict, id: 'conflict-1' }; },
			async insertKernelEvent(event) { return { ...event, id: 'event-1' }; },
			async enqueueKernelProjection(entry) { return { ...entry, id: 'outbox-1' }; },
			async applyAcceptedIssueMutation() { return { id: 'x', revision: 0 }; },
		};
		const fakeBroker = createLocalBroker({
			projectRoot: tmpDir,
			execFileSync: () => path.join(tmpDir, '.git'),
			databasePath: path.join(tmpDir, 'kernel-fake.sqlite'),
			driver: fake,
		});

		const res = await fakeBroker.runIssueOperation('update', ['forge-x', '--status', 'review'], { now });

		expect(res.ok).toBe(false);
		expect(res.command).toBe('issue.update');
		expect(res.error.exit_code).toBe(4);
		expect(res.error.retryable).toBe(true);
		expect(res.error.code).toContain('STALE_REVISION');
	});

	test('mutation ops do not reach driver.issueOperation (which still throws for writes)', async () => {
		// Sanity: the broker intercepts mutations; the driver-level mutation branch
		// remains unimplemented (Wave 1 contract preserved).
		await expect(driver.issueOperation('create', ['x'], {}, config)).rejects.toThrow(/not implemented yet/);
	});
});
