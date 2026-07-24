'use strict';

const { describe, test, expect, beforeAll, afterAll } = require('bun:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createLocalBroker } = require('../../lib/kernel/broker');
const { createBuiltinSQLiteDriver } = require('../../lib/kernel/sqlite-driver');

// Slice C2: the additive bulk activity read that `forge insights` consumes.
//   driver.listRecentKernelEvents({ since, limit }, context, config) -> row[] (created_at DESC)
//   broker.listRecentEvents({ since, limit }) -> delegates to the driver
// It spans ALL entities (unlike listKernelEvents, which is one entity stream) and is
// read-only: it creates and migrates nothing.
describe('Kernel SQLite driver — listRecentKernelEvents (Slice C2)', () => {
	let tmpDir;
	let driver;
	let broker;
	let config;

	beforeAll(async () => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kdrv-recent-events-'));
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

		// Two entities, four events, deliberately inserted out of chronological order so a
		// passing DESC assertion proves the ORDER BY rather than the insertion order.
		const seed = [
			['e-mid', 'forge-1', 'beads.interaction.field_change', '2026-06-02T00:00:00.000Z', '{"kind":"field_change","field":"status","new_value":"closed"}'],
			['e-new', 'forge-2', 'beads.interaction.note', '2026-06-04T00:00:00.000Z', '{"kind":"note","body":"looked at it"}'],
			['e-old', 'forge-1', 'issue.create', '2026-06-01T00:00:00.000Z', '{"title":"Alpha"}'],
			['e-newest', 'forge-2', 'issue.update', '2026-06-05T00:00:00.000Z', '{"title":"Beta"}'],
		];
		for (const [id, entityId, eventType, createdAt, payload] of seed) {
			await driver.insertKernelEvent({
				id,
				entity_type: 'issue',
				entity_id: entityId,
				event_type: eventType,
				idempotency_key: `seed:${id}`,
				expected_revision: 0,
				actor: 'tester',
				origin: 'beads_import',
				payload_json: payload,
				created_at: createdAt,
			}, {}, config);
		}
	});

	afterAll(() => {
		if (driver) driver.close();
		if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	test('returns events across all entities, newest first', async () => {
		const rows = await driver.listRecentKernelEvents({}, {}, config);
		expect(rows.map(row => row.id)).toEqual(['e-newest', 'e-new', 'e-mid', 'e-old']);
	});

	test('since is an inclusive ISO cutoff on created_at', async () => {
		const rows = await driver.listRecentKernelEvents({ since: '2026-06-02T00:00:00.000Z' }, {}, config);
		expect(rows.map(row => row.id)).toEqual(['e-newest', 'e-new', 'e-mid']);
	});

	test('limit bounds the row count, keeping the newest', async () => {
		const rows = await driver.listRecentKernelEvents({ limit: 2 }, {}, config);
		expect(rows.map(row => row.id)).toEqual(['e-newest', 'e-new']);
	});

	test('a non-positive or unparseable limit falls back to the default cap instead of returning nothing', async () => {
		expect((await driver.listRecentKernelEvents({ limit: 0 }, {}, config)).length).toBe(4);
		expect((await driver.listRecentKernelEvents({ limit: 'many' }, {}, config)).length).toBe(4);
	});

	test('rows carry the payload_json and entity_id insights maps back to interactions', async () => {
		const rows = await driver.listRecentKernelEvents({ limit: 3 }, {}, config);
		const interaction = rows.find(row => row.event_type === 'beads.interaction.field_change');
		expect(interaction.entity_id).toBe('forge-1');
		expect(JSON.parse(interaction.payload_json)).toEqual({
			kind: 'field_change',
			field: 'status',
			new_value: 'closed',
		});
	});

	test('broker.listRecentEvents delegates to the driver with the same window', async () => {
		const rows = await broker.listRecentEvents({ since: '2026-06-04T00:00:00.000Z', limit: 10 });
		expect(rows.map(row => row.id)).toEqual(['e-newest', 'e-new']);
	});

	test('broker.listRecentEvents fails loudly when a driver does not implement the read', async () => {
		const stubBroker = createLocalBroker({
			projectRoot: tmpDir,
			execFileSync: () => path.join(tmpDir, '.git'),
			databasePath: path.join(tmpDir, 'kernel.sqlite'),
			driver: {},
		});
		await expect(stubBroker.listRecentEvents({})).rejects.toThrow(/listRecentKernelEvents/);
	});
});
