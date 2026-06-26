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

	// KAP-4: --label is a single comma-separated flag (last-value-wins under
	// parseFlagPairs), parsed into a string[] and persisted as JSON-array TEXT.
	test('create --label persists a comma-separated label set as labels[]', async () => {
		await broker.runIssueOperation(
			'create',
			['--id', 'lbl-1', '--title', 'Labeled', '--type', 'task', '--label', 'backend, api ,'],
			{ now, actor: 'tester' },
		);

		const shown = await driver.issueOperation('show', ['lbl-1'], {}, config);
		// Whitespace trimmed, empty segments dropped, order preserved.
		expect(shown.data.labels).toEqual(['backend', 'api']);

		// Persisted as JSON-array TEXT in the column (the canonical KAP-4 form).
		const rows = await driver.queryAll('SELECT labels FROM kernel_issues WHERE id = \'lbl-1\'', config);
		expect(rows[0].labels).toBe('["backend","api"]');
	});

	test('update --label replaces the full label set', async () => {
		await broker.runIssueOperation(
			'create',
			['--id', 'lbl-2', '--title', 'Relabel', '--type', 'task', '--label', 'a,b'],
			{ now, actor: 'tester' },
		);
		expect((await driver.issueOperation('show', ['lbl-2'], {}, config)).data.labels).toEqual(['a', 'b']);

		await broker.runIssueOperation(
			'update',
			['lbl-2', '--label', 'c'],
			{ now: '2026-06-19T00:08:00.000Z', actor: 'tester' },
		);

		const shown = await driver.issueOperation('show', ['lbl-2'], {}, config);
		expect(shown.data.labels).toEqual(['c']);
	});

	// KAP-5: --parent reparents an existing issue on update (create already maps it).
	test('update --parent reparents the issue (parent_id persisted)', async () => {
		// parent_id carries an FK to kernel_issues(id), so the parent must exist.
		await broker.runIssueOperation(
			'create', ['--id', 'epic-x', '--title', 'Epic', '--type', 'epic'], { now, actor: 'tester' },
		);
		await broker.runIssueOperation(
			'create', ['--id', 'par-1', '--title', 'Child', '--type', 'task'], { now, actor: 'tester' },
		);

		await broker.runIssueOperation(
			'update', ['par-1', '--parent', 'epic-x'],
			{ now: '2026-06-19T00:09:00.000Z', actor: 'tester' },
		);

		const shown = await driver.issueOperation('show', ['par-1'], {}, config);
		expect(shown.data.parent_id).toBe('epic-x');
	});

	// KAP-10 (acceptance/design/notes) + KAP-11 (assignee): the four content fields
	// persist on create via the issue-upsert write allow-list, and surface on show.
	test('create persists acceptance_criteria/design/notes/assignee', async () => {
		await broker.runIssueOperation(
			'create',
			[
				'--id', 'cf-1', '--title', 'Content fields', '--type', 'task',
				'--acceptance', 'AC text', '--design', 'Design text',
				'--notes', 'Notes text', '--assignee', 'alice',
			],
			{ now, actor: 'tester' },
		);

		const shown = await driver.issueOperation('show', ['cf-1'], {}, config);
		expect(shown.data.acceptance_criteria).toBe('AC text');
		expect(shown.data.design).toBe('Design text');
		expect(shown.data.notes).toBe('Notes text');
		expect(shown.data.assignee).toBe('alice');

		// Persisted directly to their columns (not just the event payload).
		const rows = await driver.queryAll(
			'SELECT acceptance_criteria, design, notes, assignee FROM kernel_issues WHERE id = \'cf-1\'',
			config,
		);
		expect(rows[0]).toEqual({
			acceptance_criteria: 'AC text',
			design: 'Design text',
			notes: 'Notes text',
			assignee: 'alice',
		});
	});

	// KAP-11: assignee is a persistent reassignment on update (distinct from the
	// transient claim lease). The other three content fields update the same way.
	test('update reassigns assignee and overwrites design/notes/acceptance', async () => {
		await broker.runIssueOperation(
			'create',
			[
				'--id', 'cf-2', '--title', 'Reassign', '--type', 'task',
				'--acceptance', 'old AC', '--design', 'old D',
				'--notes', 'old N', '--assignee', 'alice',
			],
			{ now, actor: 'tester' },
		);

		await broker.runIssueOperation(
			'update',
			[
				'cf-2', '--acceptance', 'new AC', '--design', 'new D',
				'--notes', 'new N', '--assignee', 'bob',
			],
			{ now: '2026-06-19T00:10:00.000Z', actor: 'tester' },
		);

		const shown = await driver.issueOperation('show', ['cf-2'], {}, config);
		expect(shown.data.acceptance_criteria).toBe('new AC');
		expect(shown.data.design).toBe('new D');
		expect(shown.data.notes).toBe('new N');
		expect(shown.data.assignee).toBe('bob');
	});

	// KAP-5: close --reason is captured in the close EVENT payload (no column/migration).
	test('close --reason succeeds and records the reason in the close event payload', async () => {
		await broker.runIssueOperation(
			'create', ['--id', 'rsn-1', '--title', 'Closeme', '--type', 'task'], { now, actor: 'tester' },
		);

		const closed = await broker.runIssueOperation(
			'close', ['rsn-1', '--reason', 'done deal'],
			{ now: '2026-06-19T00:10:00.000Z', actor: 'tester' },
		);
		expect(closed.ok).toBe(true);
		expect(closed.command).toBe('issue.close');

		// The reason lives in the persisted close event payload (kernel_events), NOT a
		// new kernel_issues column.
		const events = await driver.queryAll(
			'SELECT payload_json FROM kernel_events WHERE entity_id = \'rsn-1\' AND event_type = \'issue.close\'',
			config,
		);
		expect(events).toHaveLength(1);
		expect(JSON.parse(events[0].payload_json).reason).toBe('done deal');
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

	test('row-level CAS rejects a concurrent lost update: two accepted writes both at expected_revision=0', async () => {
		// THE RACE PROOF. The evaluator pre-reads the entity OUTSIDE the transaction
		// (broker Promise.all), so under TRUE concurrency two writers can both pre-read
		// rev=N, both pass the evaluator, and the second would silently apply on top of
		// N+1 — a lost update returned as decision:accept. A sequential test can't
		// reproduce that (writer 2's pre-read would see N+1 and the evaluator would
		// quarantine first), so we drive the driver's applyAcceptedIssueMutation hook
		// DIRECTLY with two accepted events that BOTH carry expected_revision=0,
		// simulating the post-evaluator commit of two writers that both saw rev 0.
		await broker.runIssueOperation(
			'create', ['--id', 'race-1', '--title', 'Race', '--type', 'task'], { now, actor: 'tester' },
		);

		const updateEvent = key => ({
			entity_type: 'issue',
			entity_id: 'race-1',
			event_type: 'issue.update',
			idempotency_key: key,
			expected_revision: 0, // both writers observed rev 0 before either committed
			actor: 'tester',
			origin: 'cli',
			payload: { status: 'in_progress' },
			created_at: '2026-06-19T00:10:00.000Z',
		});

		// First accepted write applies cleanly: rev 0 → 1.
		const firstApply = await driver.applyAcceptedIssueMutation(updateEvent('race:a'), {}, config);
		expect(firstApply.revision).toBe(1);

		// Second accepted write ALSO carries expected_revision=0 but the row is now at
		// rev 1. Old code computed nextRevision = 1 + 1 and silently bumped to 2 (lost
		// update). The CAS gates the UPDATE on entity_revision=0, matches 0 rows, and
		// throws the tagged conflict the broker maps to stale_revision.
		let caught;
		try {
			await driver.applyAcceptedIssueMutation(updateEvent('race:b'), {}, config);
		} catch (error) {
			caught = error;
		}
		expect(caught).toBeDefined();
		expect(caught.kernelRevisionConflict).toBe(true);
		expect(caught.entityId).toBe('race-1');

		// The lost update was prevented: the row is still at rev 1, NOT 2.
		const shown = await driver.issueOperation('show', ['race-1'], {}, config);
		expect(shown.data.revision).toBe(1);
		expect(shown.data.status).toBe('in_progress');
	});

	test('broker maps a driver revision-conflict into a stale_revision quarantine (recovery path)', async () => {
		// The driver CAS throws INSIDE commitGuardedAccept; recoverGuardedFailure must
		// catch the tagged error, ROLLBACK, and quarantine as stale_revision (not
		// rethrow). Wrap the real driver so applyAcceptedIssueMutation throws the tag,
		// proving the broker recovery branch end-to-end against the real event store.
		await broker.runIssueOperation(
			'create', ['--id', 'race-2', '--title', 'Race2', '--type', 'task'], { now, actor: 'tester' },
		);

		const guarded = {
			...driver,
			async applyAcceptedIssueMutation() {
				const error = new Error('kernel issue revision conflict');
				error.kernelRevisionConflict = true;
				error.entityId = 'race-2';
				error.expectedRevision = 0;
				error.actualRevision = 3;
				throw error;
			},
		};
		const guardedBroker = createLocalBroker({
			projectRoot: tmpDir,
			execFileSync: () => path.join(tmpDir, '.git'),
			databasePath: path.join(tmpDir, 'kernel.sqlite'),
			driver: guarded,
		});

		const result = await guardedBroker.runGuardedEvent({
			entity_type: 'issue',
			entity_id: 'race-2',
			event_type: 'issue.update',
			idempotency_key: 'issue-update:race-2:cas',
			expected_revision: 0,
			actor: 'tester',
			origin: 'cli',
			payload: { status: 'review' },
		}, { now: '2026-06-19T00:11:00.000Z' });

		expect(result.decision).toBe('quarantine');
		expect(result.reason).toBe('stale_revision');
		expect(result.projection).toBe(false);

		// A stale_revision conflict row was persisted (byte-identical evaluator shape).
		const conflicts = await driver.queryAll('SELECT * FROM kernel_conflicts WHERE entity_id = \'race-2\'', config);
		expect(conflicts).toHaveLength(1);

		// The event was rolled back — no event/outbox row leaked from the failed accept.
		const events = await driver.queryAll('SELECT * FROM kernel_events WHERE idempotency_key = \'issue-update:race-2:cas\'', config);
		expect(events).toHaveLength(0);
	});

	test('runIssueOperation surfaces a driver revision-conflict as a retryable conflict error', async () => {
		// The user-facing mapping: a driver-detected CAS conflict (not just the
		// evaluator's pre-read quarantine) must reach mapMutationResult as a RETRYABLE
		// stale_revision error so the adapter can re-read and retry.
		await broker.runIssueOperation(
			'create', ['--id', 'race-3', '--title', 'Race3', '--type', 'task'], { now, actor: 'tester' },
		);

		const guarded = {
			...driver,
			async applyAcceptedIssueMutation() {
				const error = new Error('kernel issue revision conflict');
				error.kernelRevisionConflict = true;
				error.entityId = 'race-3';
				error.actualRevision = 2;
				throw error;
			},
		};
		const guardedBroker = createLocalBroker({
			projectRoot: tmpDir,
			execFileSync: () => path.join(tmpDir, '.git'),
			databasePath: path.join(tmpDir, 'kernel.sqlite'),
			driver: guarded,
		});

		const res = await guardedBroker.runIssueOperation('update', ['race-3', '--status', 'review'], { now: '2026-06-19T00:12:00.000Z', actor: 'tester' });

		expect(res.ok).toBe(false);
		expect(res.command).toBe('issue.update');
		expect(res.error.retryable).toBe(true);
		expect(res.error.code).toContain('STALE_REVISION');
	});

	test('claimed_by is derived from the active lease and cleared on release', async () => {
		// rowToIssueSummary has no claimed_by column to read; the active kernel_claims
		// lease is the authority. Claiming an issue must surface claimed_by=<actor> in
		// show AND list; releasing must clear it back to null.
		await broker.runIssueOperation(
			'create', ['--id', 'claimable-1', '--title', 'Claim me', '--type', 'task'], { now, actor: 'tester' },
		);

		// Before any claim, claimed_by is null.
		const beforeShow = await driver.issueOperation('show', ['claimable-1'], {}, config);
		expect(beforeShow.data.claimed_by).toBeNull();

		await broker.runIssueOperation(
			'claim', ['--issue', 'claimable-1'], { now: '2026-06-19T00:20:00.000Z', actor: 'alice' },
		);

		const claimedShow = await driver.issueOperation('show', ['claimable-1'], {}, config);
		expect(claimedShow.data.claimed_by).toBe('alice');

		const listed = await driver.issueOperation('list', [], {}, config);
		const listedIssue = listed.data.issues.find(issue => issue.id === 'claimable-1');
		expect(listedIssue.claimed_by).toBe('alice');

		await broker.runIssueOperation(
			'release', ['--issue', 'claimable-1'], { now: '2026-06-19T00:21:00.000Z', actor: 'alice' },
		);

		const releasedShow = await driver.issueOperation('show', ['claimable-1'], {}, config);
		expect(releasedShow.data.claimed_by).toBeNull();
	});

	test('claim accepts the issue id as a POSITIONAL arg (the CLI form)', async () => {
		// The CLI invokes `forge claim <id>` with the issue id as a positional, not as
		// --issue. buildClaimMutationEvent previously read only flags.issue, so the
		// positional form left issue_id undefined → buildClaimScope returned null →
		// the broker quarantined every CLI claim as invalid_claim_scope.
		await broker.runIssueOperation(
			'create', ['--id', 'pos-claim-1', '--title', 'Claim by positional', '--type', 'task'], { now, actor: 'tester' },
		);

		const claimed = await broker.runIssueOperation(
			'claim', ['pos-claim-1'], { now: '2026-06-19T00:30:00.000Z', actor: 'bob' },
		);

		expect(claimed.ok).toBe(true);
		expect(claimed.command).toBe('claim');

		const claimedShow = await driver.issueOperation('show', ['pos-claim-1'], {}, config);
		expect(claimedShow.data.claimed_by).toBe('bob');
	});

	test('release accepts the issue id as a POSITIONAL arg (the CLI form)', async () => {
		// `forge release <id>` likewise passes the issue id positionally. With issue_id
		// undefined the release UPDATE bound undefined to a SQLite parameter and threw
		// "Provided value cannot be bound to SQLite parameter 1".
		await broker.runIssueOperation(
			'create', ['--id', 'pos-rel-1', '--title', 'Release by positional', '--type', 'task'], { now, actor: 'tester' },
		);
		await broker.runIssueOperation(
			'claim', ['pos-rel-1'], { now: '2026-06-19T00:31:00.000Z', actor: 'carol' },
		);

		const released = await broker.runIssueOperation(
			'release', ['pos-rel-1'], { now: '2026-06-19T00:32:00.000Z', actor: 'carol' },
		);

		expect(released.ok).toBe(true);
		expect(released.command).toBe('release');

		const releasedShow = await driver.issueOperation('show', ['pos-rel-1'], {}, config);
		expect(releasedShow.data.claimed_by).toBeNull();
	});
});
