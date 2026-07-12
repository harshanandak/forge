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

	// --- BUG 4: priority is persisted, normalized, filterable and sortable -----
	// Kernel `--priority` was decorative: the bare-int and P-label forms stored
	// DIFFERENT verbatim values ('1' vs 'P1'), priority_rank was never derived from
	// the label (always 0), `list --priority` ignored the filter, and list order did
	// not reflect priority. Canonical stored form is the P0..P4 label (contract
	// normalizePriority), with priority_rank = the numeric rank.

	test('create --priority=1 and --priority=P1 both persist the canonical P1 label + rank', async () => {
		await createIssue(['--id', 'prio-bare', '--title', 'bare', '--type', 'task', '--priority', '1']);
		await createIssue(['--id', 'prio-label', '--title', 'label', '--type', 'task', '--priority', 'P1']);

		const bare = await driver.issueOperation('show', ['prio-bare'], {}, config);
		const label = await driver.issueOperation('show', ['prio-label'], {}, config);
		expect(bare.data.priority).toBe('P1');
		expect(label.data.priority).toBe('P1');
		expect(bare.data.rank).toBe(1);
		expect(label.data.rank).toBe(1);
	});

	test('create surfaces the normalized priority on the mutation response', async () => {
		const bare = await createIssue(['--id', 'prio-resp-1', '--title', 'x', '--type', 'task', '--priority', '1']);
		const label = await createIssue(['--id', 'prio-resp-2', '--title', 'y', '--type', 'task', '--priority', 'P1']);
		expect(bare.data.priority).toBe('P1');
		expect(label.data.priority).toBe('P1');
	});

	test('update --priority=2 normalizes the stored label + rank to P2/2', async () => {
		await createIssue(['--id', 'prio-upd', '--title', 'x', '--type', 'task', '--priority', 'P0']);
		const updated = await broker.runIssueOperation(
			'update',
			['prio-upd', '--priority', '2'],
			{ now: '2026-06-29T01:00:00.000Z', actor: 'tester' },
		);
		expect(updated.ok).toBe(true);
		expect(updated.data.priority).toBe('P2');

		const shown = await driver.issueOperation('show', ['prio-upd'], {}, config);
		expect(shown.data.priority).toBe('P2');
		expect(shown.data.rank).toBe(2);
	});

	test('list --priority filter returns only matching issues, incl. legacy bare-int rows', async () => {
		// Legacy row stored in the pre-normalization bare-int form ('1', rank 0),
		// inserted directly to model data already on disk.
		await driver.exec(
			`INSERT INTO kernel_issues (id,title,type,status,priority,priority_rank,created_at,updated_at,entity_revision)
				VALUES ('legacy-p1','Legacy bare int','task','open','1',0,'${now}','${now}',0)`,
			config,
		);
		await createIssue(['--id', 'new-p1', '--title', 'new', '--type', 'task', '--priority', 'P1']);
		await createIssue(['--id', 'other-p2', '--title', 'other', '--type', 'task', '--priority', '2']);

		for (const arg of ['--priority=1', '--priority=P1']) {
			const res = await driver.issueOperation('list', [arg], {}, config);
			const ids = res.data.issues.map(issue => issue.id).sort();
			expect(ids).toEqual(['legacy-p1', 'new-p1']);
		}
	});

	test('a default-priority create derives rank from its P2 label (sorts after P1, not before)', async () => {
		// No --priority: the row defaults to the P2 LABEL, so its rank must derive to 2 —
		// not the seed 0, which would sort the common default-priority issue ABOVE an
		// explicit P1 in `list` (priority order inverted for the typical case).
		await createIssue(['--id', 'def-p2', '--title', 'default', '--type', 'task']);
		const shown = await driver.issueOperation('show', ['def-p2'], {}, config);
		expect(shown.data.priority).toBe('P2');
		expect(shown.data.rank).toBe(2);

		await createIssue(['--id', 'exp-p1', '--title', 'explicit', '--type', 'task', '--priority', 'P1']);
		const res = await driver.issueOperation('list', [], {}, config);
		const order = res.data.issues.map(issue => issue.id);
		expect(order.indexOf('exp-p1')).toBeLessThan(order.indexOf('def-p2'));
	});

	test('list orders issues by priority (P0 before P1 before P3)', async () => {
		// Ids are chosen so their alphabetical order (a < b < c) is the REVERSE of the
		// expected priority order — proving the sort keys on derived rank, not on id.
		await createIssue(['--id', 'ord-a', '--title', 'three', '--type', 'task', '--priority', '3']);
		await createIssue(['--id', 'ord-b', '--title', 'one', '--type', 'task', '--priority', 'P1']);
		await createIssue(['--id', 'ord-c', '--title', 'zero', '--type', 'task', '--priority', 'P0']);

		const res = await driver.issueOperation('list', [], {}, config);
		const order = res.data.issues.map(issue => issue.id);
		expect(order.indexOf('ord-c')).toBeLessThan(order.indexOf('ord-b'));
		expect(order.indexOf('ord-b')).toBeLessThan(order.indexOf('ord-a'));
	});

	// --- BUG: update mutation must enforce the status-transition graph -----------

	async function currentStatus(id) {
		const shown = await driver.issueOperation('show', [id], {}, config);
		return shown.data.status;
	}

	test('update rejects an illegal status transition (backlog -> in_progress) and does not persist it', async () => {
		await createIssue(['--id', 'tg-1', '--title', 'parked', '--type', 'task', '--status', 'backlog']);
		const result = await broker.runIssueOperation(
			'update',
			['tg-1', '--status', 'in_progress'],
			{ now: '2026-06-29T00:02:00.000Z', actor: 'tester' },
		);
		expect(result.ok).toBe(false);
		expect(result.error.exit_code).toBe(6);
		expect(result.error.code).toContain('VALIDATION');
		// The illegal move was rejected before the write — status is still backlog.
		expect(await currentStatus('tg-1')).toBe('backlog');
	});

	test('update rejects resurrecting a terminal issue (done -> open)', async () => {
		await createIssue(['--id', 'tg-2', '--title', 'to close', '--type', 'task']);
		// open -> in_progress -> review -> done are all legal moves.
		await broker.runIssueOperation('update', ['tg-2', '--status', 'in_progress'], { now, actor: 'tester' });
		await broker.runIssueOperation('update', ['tg-2', '--status', 'review'], { now, actor: 'tester' });
		await broker.runIssueOperation('update', ['tg-2', '--status', 'done'], { now, actor: 'tester' });
		expect(await currentStatus('tg-2')).toBe('done');

		const result = await broker.runIssueOperation('update', ['tg-2', '--status', 'open'], { now, actor: 'tester' });
		expect(result.ok).toBe(false);
		expect(result.error.exit_code).toBe(6);
		expect(await currentStatus('tg-2')).toBe('done');
	});

	test('update allows a legal status transition (open -> in_progress)', async () => {
		await createIssue(['--id', 'tg-3', '--title', 'legal move', '--type', 'task']);
		const result = await broker.runIssueOperation(
			'update',
			['tg-3', '--status', 'in_progress'],
			{ now, actor: 'tester' },
		);
		expect(result.ok).toBe(true);
		expect(await currentStatus('tg-3')).toBe('in_progress');
	});

	test('update with no status change (only other fields) is unaffected by the transition gate', async () => {
		await createIssue(['--id', 'tg-4', '--title', 'parked', '--type', 'task', '--status', 'backlog']);
		const result = await broker.runIssueOperation(
			'update',
			['tg-4', '--title', 'parked but renamed'],
			{ now, actor: 'tester' },
		);
		expect(result.ok).toBe(true);
		expect(await currentStatus('tg-4')).toBe('backlog');
	});

	// --- BUG: claim must not begin a parked (backlog) issue ----------------------

	test('claim rejects a parked (backlog) issue — no backlog -> in_progress jump', async () => {
		await createIssue(['--id', 'cl-1', '--title', 'parked idea', '--type', 'task', '--status', 'backlog']);
		const result = await broker.runIssueOperation('claim', ['cl-1'], { now, actor: 'alice' });
		expect(result.ok).toBe(false);
		expect(result.error.exit_code).toBe(6);
		expect(result.error.code).toContain('VALIDATION');
		// No claim lease was minted for the parked issue.
		const claims = await driver.queryAll('SELECT * FROM kernel_claims', config);
		expect(claims).toHaveLength(0);
	});

	test('claim still succeeds for a workable (open) issue', async () => {
		await createIssue(['--id', 'cl-2', '--title', 'ready work', '--type', 'task']);
		const result = await broker.runIssueOperation('claim', ['cl-2'], { now, actor: 'alice' });
		expect(result.ok).toBe(true);
	});
});
