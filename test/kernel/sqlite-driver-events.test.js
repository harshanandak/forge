'use strict';

const { describe, test, expect, beforeAll, afterAll } = require('bun:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createLocalBroker } = require('../../lib/kernel/broker');
const { createBuiltinSQLiteDriver } = require('../../lib/kernel/sqlite-driver');

// Wave 2 (K-DRV): event-store primitives on the SQLite driver. These are the
// low-level reads/writes the broker's guarded-event path composes — signatures
// MUST mirror the inline fake drivers in broker-*.test.js exactly:
//   insertKernelEvent(event, context, config)            -> { ...event, id }
//   loadKernelEntity(entityType, entityId, context, config) -> row | null
//   listKernelEvents(entityType, entityId, context, config) -> row[]  (created_at ASC)
//   loadKernelEventByIdempotencyKey(key, context, config)   -> row | null
describe('Kernel SQLite driver — event-store primitives (Wave 2)', () => {
	let tmpDir;
	let driver;
	let config;
	const now = '2026-06-19T00:00:00.000Z';

	beforeAll(async () => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kdrv-events-'));
		const dbPath = path.join(tmpDir, 'kernel.sqlite');
		config = { databasePath: dbPath };
		driver = createBuiltinSQLiteDriver({});
		const broker = createLocalBroker({
			projectRoot: tmpDir,
			execFileSync: () => path.join(tmpDir, '.git'),
			databasePath: dbPath,
			driver,
		});
		await broker.initialize();

		// Seed one issue so loadKernelEntity has an entity-revision row to read.
		await driver.exec(
			`INSERT INTO kernel_issues (id,title,type,status,priority_rank,created_at,updated_at,entity_revision) VALUES
				('forge-1','Alpha task','task','open',1,'${now}','${now}',5);`,
			config,
		);
	});

	afterAll(() => {
		if (driver) driver.close();
		if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	test('insertKernelEvent persists an event and returns it with a minted id', async () => {
		const inserted = await driver.insertKernelEvent({
			entity_type: 'issue',
			entity_id: 'forge-1',
			event_type: 'issue.create',
			idempotency_key: 'create:forge-1',
			expected_revision: 0,
			actor: 'tester',
			origin: 'cli',
			payload: { title: 'Alpha task' },
			created_at: '2026-06-19T00:00:01.000Z',
		}, {}, config);

		expect(typeof inserted.id).toBe('string');
		expect(inserted.id.length).toBeGreaterThan(0);
		expect(inserted.entity_id).toBe('forge-1');
		expect(inserted.event_type).toBe('issue.create');

		// Round-trip: it is retrievable by its idempotency key.
		const fetched = await driver.loadKernelEventByIdempotencyKey('create:forge-1', {}, config);
		expect(fetched).not.toBeNull();
		expect(fetched.id).toBe(inserted.id);
		expect(fetched.event_type).toBe('issue.create');
		expect(fetched.payload_json).toBe(JSON.stringify({ title: 'Alpha task' }));
	});

	test('insertKernelEvent honors an explicit event id and a pre-serialized payload_json', async () => {
		const inserted = await driver.insertKernelEvent({
			id: 'event-explicit',
			entity_type: 'issue',
			entity_id: 'forge-1',
			event_type: 'issue.update',
			idempotency_key: 'update:forge-1:rev-5',
			expected_revision: 5,
			actor: 'tester',
			origin: 'cli',
			payload_json: '{"title":"Renamed"}',
			created_at: '2026-06-19T00:00:02.000Z',
		}, {}, config);

		expect(inserted.id).toBe('event-explicit');
		const fetched = await driver.loadKernelEventByIdempotencyKey('update:forge-1:rev-5', {}, config);
		expect(fetched.id).toBe('event-explicit');
		expect(fetched.payload_json).toBe('{"title":"Renamed"}');
	});

	test('duplicate idempotency_key surfaces the raw UNIQUE constraint error (broker recovery relies on the message)', async () => {
		await expect(driver.insertKernelEvent({
			entity_type: 'issue',
			entity_id: 'forge-1',
			event_type: 'issue.update',
			idempotency_key: 'create:forge-1',
			expected_revision: 0,
			actor: 'tester',
			origin: 'cli',
			payload: {},
			created_at: '2026-06-19T00:00:03.000Z',
		}, {}, config)).rejects.toThrow(/UNIQUE constraint failed/i);
	});

	test('listKernelEvents returns an entity stream ordered by created_at ASC', async () => {
		const rows = await driver.listKernelEvents('issue', 'forge-1', {}, config);
		expect(rows.map(row => row.idempotency_key)).toEqual([
			'create:forge-1',
			'update:forge-1:rev-5',
		]);
	});

	test('listKernelEvents returns [] for an entity with no events', async () => {
		const rows = await driver.listKernelEvents('issue', 'forge-unknown', {}, config);
		expect(rows).toEqual([]);
	});

	test('loadKernelEventByIdempotencyKey returns null for a missing key and for a falsy key', async () => {
		expect(await driver.loadKernelEventByIdempotencyKey('does-not-exist', {}, config)).toBeNull();
		expect(await driver.loadKernelEventByIdempotencyKey(undefined, {}, config)).toBeNull();
	});

	test('loadKernelEntity reads the entity-revision row for an issue', async () => {
		const entity = await driver.loadKernelEntity('issue', 'forge-1', {}, config);
		expect(entity).not.toBeNull();
		expect(entity.id).toBe('forge-1');
		expect(Number(entity.entity_revision)).toBe(5);
	});

	test('loadKernelEntity returns null for a missing issue', async () => {
		expect(await driver.loadKernelEntity('issue', 'forge-unknown', {}, config)).toBeNull();
	});

	test('loadKernelEntity returns null for a non-issue entity type (no stored revision)', async () => {
		expect(await driver.loadKernelEntity('claim', 'claim-1', {}, config)).toBeNull();
	});
});
