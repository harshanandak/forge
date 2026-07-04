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

// Full-fidelity migration of the legacy Beads activity log: events.jsonl (issue lifecycle
// events) and interactions.jsonl (agent interaction/memory audit records) both LAND in the
// kernel_events table via the faithful-import write path, preserving kind/actor/payload and
// staying idempotent on re-migration. Distinct from the close-event sidecar, which is only
// consumed to denormalize closed_at/close_reason onto the issue row.
describe('Kernel SQLite driver — beads activity events + interactions import', () => {
	let tmpDir;
	let driver;
	let broker;
	let config;
	const now = '2026-06-30T00:00:00.000Z';
	const fixtureDir = path.join(__dirname, '..', 'fixtures', 'beads-migrate', 'legacy-backup');

	beforeEach(async () => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kdrv-events-'));
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

	// The activity-event + interaction sidecars are no longer reported as data-loss gaps; the
	// mapper folds both into a single kernel.activityEvents bundle destined for kernel_events.
	test('maps every event + interaction into activityEvents with no data-loss gap', () => {
		const snapshot = loadBeadsSnapshotFromDirectory(fixtureDir);
		expect(snapshot.events).toHaveLength(3);
		expect(snapshot.interactions).toHaveLength(2);

		const { kernel, report } = importBeadsSnapshot(snapshot, { importedAt: now });

		const gapFields = report.gaps.map(gap => gap.field);
		expect(gapFields).not.toContain('events.jsonl');
		expect(gapFields).not.toContain('interactions.jsonl');
		// 3 events + 2 interactions land as kernel activity events.
		expect(kernel.activityEvents).toHaveLength(5);
		expect(report.summary.events).toBe(3);
		expect(report.summary.interactions).toBe(2);
	});

	// Write path: all 5 activity records land in kernel_events, tagged origin=beads_import,
	// each preserving its beads kind, actor and payload (old/new value, comment, or extra).
	test('lands every activity event + interaction in kernel_events with fidelity', async () => {
		const snapshot = loadBeadsSnapshotFromDirectory(fixtureDir);
		const { kernel } = importBeadsSnapshot(snapshot, { importedAt: now });

		const summary = await broker.importIssues(kernel, { now });
		expect(summary.events.inserted).toBe(5);

		const rows = await driver.queryAll(
			"SELECT id, entity_id, event_type, actor, origin, payload_json, created_at FROM kernel_events WHERE origin = 'beads_import'",
			config,
		);
		expect(rows).toHaveLength(5);

		const created = rows.find(row => row.event_type === 'beads.event.created' && row.entity_id === 'forge-aa1');
		expect(created).toBeTruthy();
		expect(created.actor).toBe('Harsha Nanda');
		expect(created.created_at).toBe('2026-04-01T09:00:00Z');
		expect(JSON.parse(created.payload_json)).toMatchObject({ kind: 'created' });

		// A lifecycle event's old/new value survives verbatim in the payload.
		const depAdded = rows.find(row => row.event_type === 'beads.event.dependency_added');
		expect(depAdded.entity_id).toBe('forge-bb2');
		expect(JSON.parse(depAdded.payload_json)).toMatchObject({ kind: 'dependency_added', new_value: 'forge-aa1' });

		// An interaction record keeps its issue reference, actor and structured extra payload.
		const interaction = rows.find(row => row.event_type === 'beads.interaction.field_change');
		expect(interaction.entity_id).toBe('forge-aa1');
		expect(interaction.actor).toBe('Harsha Nanda');
		expect(JSON.parse(interaction.payload_json)).toMatchObject({
			kind: 'field_change',
			field: 'status',
			reason: 'Reviewed during planning',
		});
	});

	// Idempotency: a second migration of the same snapshot mints no duplicate events.
	test('re-importing does not duplicate activity events', async () => {
		const { kernel } = importBeadsSnapshot(loadBeadsSnapshotFromDirectory(fixtureDir), { importedAt: now });

		await broker.importIssues(kernel, { now });
		const second = await broker.importIssues(kernel, { now });

		expect(second.events.inserted).toBe(0);
		expect(second.events.skipped).toBe(5);

		const rows = await driver.queryAll("SELECT id FROM kernel_events WHERE origin = 'beads_import'", config);
		expect(rows).toHaveLength(5);
	});

	// Back-compat: a source with no events/interactions still migrates cleanly.
	test('a snapshot without events/interactions imports cleanly', async () => {
		const { kernel } = importBeadsSnapshot({
			issues: [{ id: 'no-ev', title: 'No activity', status: 'open', created_at: now, updated_at: now }],
		}, { importedAt: now });

		expect(kernel.activityEvents).toEqual([]);

		const summary = await broker.importIssues(kernel, { now });
		expect(summary.issues.inserted).toBe(1);
		expect(summary.events.inserted).toBe(0);

		const rows = await driver.queryAll("SELECT id FROM kernel_events WHERE origin = 'beads_import'", config);
		expect(rows).toHaveLength(0);
	});
});
