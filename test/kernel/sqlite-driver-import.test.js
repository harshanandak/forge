'use strict';

const { describe, test, expect, beforeEach, afterEach } = require('bun:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createLocalBroker } = require('../../lib/kernel/broker');
const { createBuiltinSQLiteDriver } = require('../../lib/kernel/sqlite-driver');
const {
	importBeadsSnapshot,
	loadBeadsSnapshotFromDirectory,
} = require('../../lib/adapters/beads-kernel-compat');

// Faithful-import WRITE PATH (the forge migrate enabler). broker.importIssues consumes
// the records importBeadsSnapshot(snapshot).kernel produces and writes them DIRECTLY to
// the authority tables, PRESERVING the original created_at/updated_at, terminal status,
// priority, labels, acceptance/fidelity columns, plus the issue's comments and
// dependencies. Distinct from the normal create/update path (which now-stamps + CAS).
describe('Kernel SQLite driver — faithful beads import write path', () => {
	let tmpDir;
	let driver;
	let broker;
	let config;
	const now = '2026-06-30T00:00:00.000Z';
	const fixtureDir = path.join(__dirname, '..', 'fixtures', 'beads-migrate', 'legacy-backup');

	beforeEach(async () => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kdrv-import-'));
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

	// GAP 1 + GAP 2 (done) + close-event merge: a beads `closed` issue imported through
	// importBeadsSnapshot keeps its ORIGINAL timestamps and lands at terminal status
	// `done` with closed_at/close_reason merged from the close-event sidecar — NOT
	// now-stamped like the normal create path.
	test('imports a done issue preserving original timestamps + terminal status + close metadata', async () => {
		const { kernel } = importBeadsSnapshot({
			issues: [{
				id: 'imp-done-1',
				title: 'Imported done',
				description: 'Body text from beads description',
				issue_type: 'task',
				status: 'closed',
				priority: 1,
				labels: ['alpha'],
				acceptance_criteria: 'Original acceptance criteria',
				created_at: '2025-01-01T00:00:00Z',
				updated_at: '2025-02-02T00:00:00Z',
				closed_at: '2025-02-02T00:00:00Z',
				close_reason: 'Shipped and verified',
			}],
		}, { importedAt: now });

		const summary = await broker.importIssues(kernel, { now });
		expect(summary.issues.inserted).toBe(1);

		const shown = await driver.issueOperation('show', ['imp-done-1'], {}, config);
		expect(shown.ok).toBe(true);
		expect(shown.data.status).toBe('done');
		// Original timestamps preserved — the auto-stamp would have written `now`.
		expect(shown.data.created_at).toBe('2025-01-01T00:00:00Z');
		expect(shown.data.updated_at).toBe('2025-02-02T00:00:00Z');
		expect(shown.data.created_at).not.toBe(now);
		// Close metadata merged from the kernel.events sidecar.
		expect(shown.data.closed_at).toBe('2025-02-02T00:00:00Z');
		expect(shown.data.close_reason).toBe('Shipped and verified');
		expect(shown.data.priority).toBe('P1');
		expect(shown.data.rank).toBe(1);
		expect(shown.data.labels).toEqual(['alpha']);
		expect(shown.data.acceptance_criteria).toBe('Original acceptance criteria');
		expect(shown.data.body).toBe('Body text from beads description');
		// Imported issues start at revision 0.
		expect(shown.data.revision).toBe(0);
	});

	// GAP 2 (cancelled) + column-completeness: a hand-built record carrying EVERY
	// fidelity column (created_by + metadata, which the mapper currently drops as gaps,
	// plus record-level closed_at/close_reason) persists verbatim at a terminal
	// `cancelled` status with preserved timestamps.
	test('persists a cancelled issue with all fidelity columns (created_by/metadata) verbatim', async () => {
		const summary = await broker.importIssues({
			issues: [{
				id: 'cc-1',
				title: 'Column complete',
				body: 'b',
				type: 'task',
				status: 'cancelled',
				priority: 'P2',
				priority_rank: 2,
				created_at: '2024-06-06T00:00:00.000Z',
				updated_at: '2024-06-06T00:00:00.000Z',
				entity_revision: 0,
				created_by: 'Harsha Nanda',
				metadata: '{"beads_id":"bd-1"}',
				design: 'Design notes',
				notes: 'Working notes',
				assignee: 'bob',
				closed_at: '2024-07-07T00:00:00.000Z',
				close_reason: 'Cancelled — superseded',
			}],
			comments: [],
			dependencies: [],
			events: [],
		}, { now });
		expect(summary.issues.inserted).toBe(1);

		const shown = await driver.issueOperation('show', ['cc-1'], {}, config);
		expect(shown.data.status).toBe('cancelled');
		expect(shown.data.created_at).toBe('2024-06-06T00:00:00.000Z');
		expect(shown.data.updated_at).toBe('2024-06-06T00:00:00.000Z');
		expect(shown.data.created_by).toBe('Harsha Nanda');
		expect(shown.data.metadata).toBe('{"beads_id":"bd-1"}');
		expect(shown.data.design).toBe('Design notes');
		expect(shown.data.notes).toBe('Working notes');
		expect(shown.data.assignee).toBe('bob');
		expect(shown.data.closed_at).toBe('2024-07-07T00:00:00.000Z');
		expect(shown.data.close_reason).toBe('Cancelled — superseded');
	});

	// GAP 1 + GAP 3 end-to-end: the legacy-backup fixtures flow through
	// loadBeadsSnapshotFromDirectory → importBeadsSnapshot → broker.importIssues, and
	// every issue keeps its original timestamps/status while its comments and the
	// dependency edge land in the authority tables.
	test('imports the legacy-backup fixtures end-to-end with comments + dependency', async () => {
		const snapshot = loadBeadsSnapshotFromDirectory(fixtureDir);
		const { kernel } = importBeadsSnapshot(snapshot, { importedAt: now });

		const summary = await broker.importIssues(kernel, { now });
		expect(summary.issues.inserted).toBe(2);
		expect(summary.comments.inserted).toBe(kernel.comments.length);
		expect(summary.dependencies.inserted).toBe(1);

		const aa1 = await driver.issueOperation('show', ['forge-aa1'], {}, config);
		expect(aa1.data.status).toBe('open');
		expect(aa1.data.created_at).toBe('2026-04-01T09:00:00Z');
		expect(aa1.data.updated_at).toBe('2026-04-01T09:00:00Z');
		// Legacy `feature` issue_type collapses to `task` with a `feature` alias label.
		expect(aa1.data.type).toBe('task');
		expect(aa1.data.labels).toContain('feature');
		// created_by is a known mapper GAP (no issue record field) — it does NOT survive
		// the current mapper, proving the write path persists only what it is given.
		expect(aa1.data.created_by).toBeNull();
		// Real comment + synthetic note comment (collectComments turns distinct notes into
		// a beads-note-* comment) → 2 comments on forge-aa1.
		expect(aa1.data.comments.length).toBe(2);
		expect(aa1.data.comments.map(comment => comment.body))
			.toContain('Stage: plan complete → ready for dev');

		const bb2 = await driver.issueOperation('show', ['forge-bb2'], {}, config);
		expect(bb2.data.status).toBe('in_progress');
		expect(bb2.data.created_at).toBe('2026-04-01T10:00:00Z');
		expect(bb2.data.updated_at).toBe('2026-04-01T10:30:00Z');
		// The dependency edge forge-bb2 → forge-aa1 is present.
		expect(bb2.data.dependencies).toContain('forge-aa1');
	});

	// GAP 4: a second import of the same snapshot mints NO duplicate rows — every record
	// is skipped on its id conflict and the authority-table counts stay stable.
	test('re-import is idempotent (no duplicate issues/comments/dependencies)', async () => {
		const snapshot = loadBeadsSnapshotFromDirectory(fixtureDir);
		const { kernel } = importBeadsSnapshot(snapshot, { importedAt: now });

		await broker.importIssues(kernel, { now });
		const second = await broker.importIssues(kernel, { now });

		expect(second.issues.inserted).toBe(0);
		expect(second.issues.skipped).toBe(2);
		expect(second.comments.inserted).toBe(0);
		expect(second.comments.skipped).toBe(kernel.comments.length);
		expect(second.dependencies.inserted).toBe(0);
		expect(second.dependencies.skipped).toBe(1);

		const issueRows = await driver.queryAll('SELECT id FROM kernel_issues', config);
		expect(issueRows).toHaveLength(2);
		const commentRows = await driver.queryAll('SELECT id FROM kernel_comments', config);
		expect(commentRows).toHaveLength(kernel.comments.length);
		const depRows = await driver.queryAll('SELECT id FROM kernel_dependencies', config);
		expect(depRows).toHaveLength(1);
	});

	// Robustness: a dangling dependency edge (endpoint missing from the import set and the
	// DB) is filtered out rather than aborting the whole batch on the live FK.
	test('filters a dangling dependency edge without aborting the issue insert', async () => {
		const summary = await broker.importIssues({
			issues: [{
				id: 'fk-1',
				title: 'Has a dangling dep',
				type: 'task',
				status: 'open',
				priority: 'P2',
				priority_rank: 2,
				created_at: '2024-01-01T00:00:00.000Z',
				updated_at: '2024-01-01T00:00:00.000Z',
			}],
			comments: [],
			dependencies: [{
				id: 'dep-dangling',
				issue_id: 'fk-1',
				blocks_issue_id: 'does-not-exist',
				dependency_type: 'blocks',
				created_at: '2024-01-01T00:00:00.000Z',
			}],
			events: [],
		}, { now });

		expect(summary.issues.inserted).toBe(1);
		expect(summary.dependencies.inserted).toBe(0);
		expect(summary.dependencies.skipped).toBe(1);

		const shown = await driver.issueOperation('show', ['fk-1'], {}, config);
		expect(shown.ok).toBe(true);
		expect(shown.data.dependencies).toEqual([]);
	});

	// Accepts the full importBeadsSnapshot result (unwraps `.kernel`) as a convenience.
	test('accepts the full importBeadsSnapshot result via its .kernel records', async () => {
		const result = importBeadsSnapshot({
			issues: [{
				id: 'wrap-1',
				title: 'Wrapped',
				issue_type: 'task',
				status: 'open',
				priority: 2,
				created_at: '2024-03-03T00:00:00Z',
				updated_at: '2024-03-03T00:00:00Z',
			}],
		}, { importedAt: now });

		const summary = await broker.importIssues(result, { now });
		expect(summary.issues.inserted).toBe(1);
		const shown = await driver.issueOperation('show', ['wrap-1'], {}, config);
		expect(shown.data.created_at).toBe('2024-03-03T00:00:00Z');
	});
});
