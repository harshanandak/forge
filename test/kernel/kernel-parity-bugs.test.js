'use strict';

const { describe, test, expect, beforeEach, afterEach } = require('bun:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createLocalBroker } = require('../../lib/kernel/broker');
const { createBuiltinSQLiteDriver } = require('../../lib/kernel/sqlite-driver');

// Kernel-parity regression suite. Three confirmed divergences from the Beads
// behavior the Kernel replaced:
//   BUG 1 — `create --description` was silently dropped (data loss).
//   BUG 2 — no input validation: empty title accepted, invalid status/priority/type
//           persisted verbatim.
//   BUG 3 — claim/release/dep returned the lease/dep row id as data.id instead of
//           the issue id consumers key on.
// Each test drives the real SQLite driver through broker.runIssueOperation, matching
// the CLI path (bin/forge.js -> _issue.js -> adapter -> broker).
describe('Kernel parity bugs', () => {
	let tmpDir;
	let driver;
	let broker;
	let config;
	const now = '2026-06-29T00:00:00.000Z';

	async function createIssue(args, context = {}) {
		return broker.runIssueOperation('create', args, { now, actor: 'tester', ...context });
	}

	beforeEach(async () => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kparity-'));
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

	// --- BUG 1: --description persists ----------------------------------------

	test('create --description persists to body and show surfaces it', async () => {
		const created = await createIssue(
			['--id', 'desc-1', '--title', 'Has description', '--type', 'task', '--description', 'HELLO'],
		);
		expect(created.ok).toBe(true);

		const shown = await driver.issueOperation('show', ['desc-1'], {}, config);
		expect(shown.ok).toBe(true);
		expect(shown.data.body).toBe('HELLO');
	});

	test('explicit --body wins over --description when both are given', async () => {
		await createIssue(
			['--id', 'desc-2', '--title', 'Both', '--type', 'task', '--body', 'BODYWINS', '--description', 'ignored'],
		);
		const shown = await driver.issueOperation('show', ['desc-2'], {}, config);
		expect(shown.data.body).toBe('BODYWINS');
	});

	test('update --description rewrites the body', async () => {
		await createIssue(['--id', 'desc-3', '--title', 'Initial', '--type', 'task']);
		const updated = await broker.runIssueOperation(
			'update',
			['desc-3', '--description', 'UPDATED'],
			{ now: '2026-06-29T00:01:00.000Z', actor: 'tester' },
		);
		expect(updated.ok).toBe(true);

		const shown = await driver.issueOperation('show', ['desc-3'], {}, config);
		expect(shown.data.body).toBe('UPDATED');
	});

	// --- BUG 2: input validation ----------------------------------------------

	test('create rejects an empty title', async () => {
		const result = await createIssue(['--id', 'empty-1', '--title', '', '--type', 'task']);
		expect(result.ok).toBe(false);
		expect(result.error.exit_code).toBe(6);
		expect(result.error.code).toContain('VALIDATION');
		// Nothing was written.
		const rows = await driver.queryAll('SELECT * FROM kernel_issues', config);
		expect(rows).toHaveLength(0);
	});

	test('create rejects a whitespace-only title', async () => {
		const result = await createIssue(['--id', 'empty-2', '--title', '   ', '--type', 'task']);
		expect(result.ok).toBe(false);
		expect(result.error.exit_code).toBe(6);
	});

	test('create rejects a missing title', async () => {
		const result = await createIssue(['--id', 'empty-3', '--type', 'task']);
		expect(result.ok).toBe(false);
		expect(result.error.exit_code).toBe(6);
	});

	test('create rejects an invalid status', async () => {
		const result = await createIssue(
			['--id', 'bad-status-1', '--title', 'x', '--type', 'task', '--status', 'BOGUSSTATUS'],
		);
		expect(result.ok).toBe(false);
		expect(result.error.exit_code).toBe(6);
	});

	test('create accepts a non-canonical type verbatim (type is NOT validated)', async () => {
		// `feature` is a label, not a canonical D18 type, but forge-internal callers
		// (lib/commands/plan.js) and the documented CLI create with --type=feature.
		// The kernel stores it verbatim; rejecting it would be an out-of-scope regression.
		const result = await createIssue(['--id', 'feat-type-1', '--title', 'x', '--type', 'feature']);
		expect(result.ok).toBe(true);
		const shown = await driver.issueOperation('show', ['feat-type-1'], {}, config);
		expect(shown.data.type).toBe('feature');
	});

	test('create rejects an invalid priority', async () => {
		const result = await createIssue(
			['--id', 'bad-prio-1', '--title', 'x', '--type', 'task', '--priority', 'P9'],
		);
		expect(result.ok).toBe(false);
		expect(result.error.exit_code).toBe(6);
	});

	test('create accepts a canonical priority (P1) and a bare-int priority (1)', async () => {
		const labelled = await createIssue(
			['--id', 'ok-prio-1', '--title', 'x', '--type', 'task', '--priority', 'P1'],
		);
		expect(labelled.ok).toBe(true);
		const numeric = await createIssue(
			['--id', 'ok-prio-2', '--title', 'y', '--type', 'task', '--priority', '1'],
		);
		expect(numeric.ok).toBe(true);
	});

	test('update rejects an invalid status and does not persist it', async () => {
		await createIssue(['--id', 'upd-1', '--title', 'Updatable', '--type', 'task']);
		const result = await broker.runIssueOperation(
			'update',
			['upd-1', '--status', 'BOGUSSTATUS'],
			{ now: '2026-06-29T00:02:00.000Z', actor: 'tester' },
		);
		expect(result.ok).toBe(false);
		expect(result.error.exit_code).toBe(6);

		const shown = await driver.issueOperation('show', ['upd-1'], {}, config);
		expect(shown.data.status).toBe('open');
	});

	test('update rejects an invalid priority', async () => {
		await createIssue(['--id', 'upd-2', '--title', 'Updatable', '--type', 'task']);
		const result = await broker.runIssueOperation(
			'update',
			['upd-2', '--priority', 'BOGUS'],
			{ now: '2026-06-29T00:03:00.000Z', actor: 'tester' },
		);
		expect(result.ok).toBe(false);
		expect(result.error.exit_code).toBe(6);
	});

	test('update rejects an empty title', async () => {
		await createIssue(['--id', 'upd-3', '--title', 'Updatable', '--type', 'task']);
		const result = await broker.runIssueOperation(
			'update',
			['upd-3', '--title', ''],
			{ now: '2026-06-29T00:04:00.000Z', actor: 'tester' },
		);
		expect(result.ok).toBe(false);
		expect(result.error.exit_code).toBe(6);
	});

	// --- BUG 3: data.id is the issue id for claim/release/dep -----------------

	test('claim returns the issue id as data.id (claim_id carries the lease id)', async () => {
		await createIssue(['--id', 'claim-1', '--title', 'Claimable', '--type', 'task']);
		const claimed = await broker.runIssueOperation('claim', ['claim-1'], { now, actor: 'alice' });

		expect(claimed.ok).toBe(true);
		expect(claimed.data.id).toBe('claim-1');
		expect(typeof claimed.data.claim_id).toBe('string');
		expect(claimed.data.claim_id).not.toBe('claim-1');
	});

	test('release returns the issue id as data.id', async () => {
		await createIssue(['--id', 'rel-1', '--title', 'Releasable', '--type', 'task']);
		await broker.runIssueOperation('claim', ['rel-1'], { now, actor: 'alice' });
		const released = await broker.runIssueOperation(
			'release',
			['rel-1'],
			{ now: '2026-06-29T00:05:00.000Z', actor: 'alice' },
		);

		expect(released.ok).toBe(true);
		expect(released.data.id).toBe('rel-1');
	});

	test('dep.add returns the dependent issue id as data.id (dependency_id carries the row id)', async () => {
		await createIssue(['--id', 'pd-a', '--title', 'Dependent', '--type', 'task']);
		await createIssue(['--id', 'pd-b', '--title', 'Blocker', '--type', 'task']);
		const added = await broker.runIssueOperation(
			'dep.add',
			['pd-a', 'pd-b'],
			{ now, actor: 'tester' },
		);

		expect(added.ok).toBe(true);
		expect(added.data.id).toBe('pd-a');
		expect(typeof added.data.dependency_id).toBe('string');
		expect(added.data.dependency_id).not.toBe('pd-a');
	});
});
