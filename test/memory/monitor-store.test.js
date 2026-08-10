'use strict';

const { afterEach, describe, expect, mock, test } = require('bun:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const contracts = require('../../packages/memory-contracts');
mock.module('@forge/memory-contracts', () => contracts);
const { computeContentHash } = contracts;
const { createBuiltinSQLiteDriver } = require('../../lib/kernel/sqlite-driver');
const { buildMonitorDurabilityMigration } = require('../../lib/kernel/migrations');
const { createMonitorStore } = require('../../packages/memory');

const HASH = 'a'.repeat(64);
const createdPaths = [];
const createdDrivers = [];

function makeDatabasePath() {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-monitor-store-'));
	createdPaths.push(directory);
	return path.join(directory, 'kernel.sqlite');
}

function envelope(schemaId, objectId, payload) {
	const value = {
		schema_id: schemaId,
		schema_version: 1,
		object_id: objectId,
		created_at: '2026-08-10T00:00:00.000Z',
		producer: { product_id: 'forge', product_version: '0.1.0', instance_id: 'test' },
		capabilities_used: [],
		provenance: { source_kind: 'local', actor_class: 'test', actor_id: 'monitor-store-test' },
		content_hash: HASH,
		payload,
		extensions: {},
	};
	value.content_hash = computeContentHash(value);
	return value;
}

function monitorEvent(sequence = 0, overrides = {}) {
	return envelope('forge.memory.monitor-event.v1', '10000000-0000-4000-8000-000000000001', {
		monitor_id: 'monitor-1',
		event_id: 'event-1',
		sequence,
		subject_revision: 'subject-1',
		type: 'status',
		actionability: 'advisory',
		observed_at: '2026-08-10T00:00:00.000Z',
		artifact_digest: 'b'.repeat(64),
		...overrides,
	});
}

function deliveryReceipt(overrides = {}) {
	return envelope('forge.memory.delivery-receipt.v1', '10000000-0000-4000-8000-000000000002', {
		event_id: 'event-1',
		target: 'terminal',
		transport_tier: 'T1',
		attempt: 1,
		delivered_at: '2026-08-10T00:01:00.000Z',
		acknowledged: true,
		outcome: 'acknowledged',
		...overrides,
	});
}

function monitorReceipt(overrides = {}) {
	return envelope('forge.memory.monitor-receipt.v1', '10000000-0000-4000-8000-000000000003', {
		monitor_id: 'monitor-1',
		owner_run_id: 'run-1',
		terminal_state: 'PASS',
		terminal_reason: 'all checks passed',
		last_sequence: 1,
		evidence_digest: 'c'.repeat(64),
		cancellation_acknowledged: false,
		process_cleanup: { outcome: 'complete' },
		lease_cleanup: { outcome: 'complete' },
		...overrides,
	});
}

async function makeStore(databasePath = makeDatabasePath()) {
	const driver = createBuiltinSQLiteDriver({ databasePath });
	createdDrivers.push(driver);
	for (const statement of buildMonitorDurabilityMigration().apply) await driver.exec(statement);
	return { databasePath, driver, store: createMonitorStore(driver) };
}

afterEach(() => {
	while (createdDrivers.length > 0) createdDrivers.pop().close();
	while (createdPaths.length > 0) fs.rmSync(createdPaths.pop(), { recursive: true, force: true });
});

describe('monitor durability store', () => {
	test('persists one immutable event with its initial delivery outbox atomically and retries identical content', async () => {
		const { driver, store } = await makeStore();
		const event = monitorEvent();

		expect(await store.appendEvent(event, ['terminal'])).toMatchObject({ idempotent: false, event_id: 'event-1' });
		expect(await store.appendEvent(event, ['terminal'])).toMatchObject({ idempotent: true, event_id: 'event-1' });
		expect(await driver.queryAll('SELECT event_id, monitor_id, sequence FROM memory_monitor_events')).toEqual([
			{ event_id: 'event-1', monitor_id: 'monitor-1', sequence: 0 },
		]);
		expect(await driver.queryAll('SELECT event_id, target, status FROM memory_monitor_outbox')).toEqual([
			{ event_id: 'event-1', target: 'terminal', status: 'pending' },
		]);

		const divergent = monitorEvent(0, { type: 'different-status' });
		await expect(store.appendEvent(divergent, ['terminal'])).rejects.toThrow('monitor event conflict');
	});

	test('treats target order and duplicates as the same replay set but conflicts on a divergent set', async () => {
		const { driver, store } = await makeStore();
		const event = monitorEvent();
		expect(await store.appendEvent(event, ['terminal', 'archive'])).toMatchObject({ idempotent: false });
		expect(await store.appendEvent(event, ['archive', 'terminal', 'archive'])).toMatchObject({ idempotent: true });
		expect(await driver.queryAll('SELECT target FROM memory_monitor_outbox ORDER BY target')).toEqual([
			{ target: 'archive' }, { target: 'terminal' },
		]);
		await expect(store.appendEvent(event, ['terminal'])).rejects.toThrow('target set conflict');
		await expect(store.appendEvent(event, ['terminal', 'email'])).rejects.toThrow('target set conflict');
	});

	test('rolls back an event when its initial outbox enqueue cannot complete', async () => {
		const { driver, store } = await makeStore();
		await driver.exec("CREATE TRIGGER fail_monitor_outbox BEFORE INSERT ON memory_monitor_outbox WHEN NEW.target = 'broken' BEGIN SELECT RAISE(ABORT, 'forced outbox failure'); END;");
		await expect(store.appendEvent(monitorEvent(), ['terminal', 'broken'])).rejects.toThrow('forced outbox failure');
		expect(await driver.queryAll('SELECT * FROM memory_monitor_events')).toEqual([]);
		expect(await driver.queryAll('SELECT * FROM memory_monitor_outbox')).toEqual([]);
	});

	test('bounds SQLite lock waiting and succeeds on retry after genuine connection contention clears', async () => {
		const databasePath = makeDatabasePath();
		const first = await makeStore(databasePath);
		const second = await makeStore(databasePath);
		await first.driver.exec('BEGIN IMMEDIATE;');
		const startedAt = performance.now();
		await expect(second.store.appendEvent(monitorEvent(), ['terminal'], { monitorBusyTimeoutMs: 75 }))
			.rejects.toThrow('busy after');
		const elapsed = performance.now() - startedAt;
		expect(elapsed).toBeGreaterThanOrEqual(50);
		expect(elapsed).toBeLessThan(5000);
		await first.driver.exec('ROLLBACK;');
		expect(await second.store.appendEvent(monitorEvent(), ['terminal'], { monitorBusyTimeoutMs: 75 }))
			.toMatchObject({ idempotent: false });
	});

	test('rechecks writer enablement inside the acquired write transaction', async () => {
		const databasePath = makeDatabasePath();
		const owner = await makeStore(databasePath);
		await owner.driver.exec('PRAGMA journal_mode=WAL;');
		await owner.driver.exec('BEGIN IMMEDIATE;');
		await owner.driver.exec('UPDATE memory_monitor_writer_state SET enabled = 0 WHERE singleton = 1;');
		const modulePath = path.resolve(__dirname, '../../lib/kernel/sqlite-driver.js');
		const childCode = `
const { createBuiltinSQLiteDriver } = require(${JSON.stringify(modulePath)});
const driver = createBuiltinSQLiteDriver({ databasePath: process.env.MONITOR_RACE_DB });
await (async () => {
  const observed = await driver.queryAll('SELECT enabled FROM memory_monitor_writer_state WHERE singleton = 1;');
  process.stdout.write('observed:' + observed[0].enabled + '\\n');
  try {
    const result = await driver.appendMonitorEvent(JSON.parse(process.env.MONITOR_RACE_EVENT), ['terminal'], { monitorBusyTimeoutMs: 2000 });
    process.stdout.write('result:' + JSON.stringify(result) + '\\n');
  } catch (error) {
    process.stdout.write('error:' + error.message + '\\n');
  } finally {
    driver.close();
  }
})();`;
		const child = spawn(process.execPath, ['-e', childCode], {
			env: { ...process.env, MONITOR_RACE_DB: databasePath, MONITOR_RACE_EVENT: JSON.stringify(monitorEvent()) },
			stdio: ['ignore', 'pipe', 'pipe'],
		});
		let output = '';
		let stderr = '';
		child.stdout.on('data', chunk => { output += chunk.toString(); });
		child.stderr.on('data', chunk => { stderr += chunk.toString(); });
		const exited = new Promise((resolve, reject) => {
			child.once('error', reject);
			child.once('close', code => resolve(code));
		});
		while (!output.includes('observed:1')) {
			if (child.exitCode !== null) throw new Error(`monitor race child exited early: ${stderr}`);
			await new Promise(resolve => setTimeout(resolve, 10));
		}
		await new Promise(resolve => setTimeout(resolve, 100));
		await owner.driver.exec('COMMIT;');
		expect(await exited).toBe(0);
		expect(output).toContain('error:Monitor durability writers are disabled');
		expect(output).not.toContain('result:');
		expect(await owner.driver.queryAll('SELECT COUNT(*) AS n FROM memory_monitor_events')).toEqual([{ n: 0 }]);
	});

	test('rejects a stale acknowledgement before inserting its receipt or mutating delivery state', async () => {
		const { driver, store } = await makeStore();
		await store.appendEvent(monitorEvent(0), ['terminal']);
		await store.appendEvent(monitorEvent(1, { event_id: 'event-2' }), ['terminal']);
		const latest = deliveryReceipt({ event_id: 'event-2', attempt: 2 });
		await store.recordDeliveryReceipt(latest);
		expect(await store.recordDeliveryReceipt(latest)).toMatchObject({ idempotent: true });
		await expect(store.recordDeliveryReceipt(deliveryReceipt({ event_id: 'event-1', attempt: 1 })))
			.rejects.toThrow('stale monitor delivery cursor');

		expect(await driver.queryAll('SELECT monitor_id, target, sequence FROM memory_monitor_cursors')).toEqual([
			{ monitor_id: 'monitor-1', target: 'terminal', sequence: 1 },
		]);
		expect(await driver.queryAll('SELECT event_id, attempt FROM memory_monitor_delivery_receipts')).toEqual([
			{ event_id: 'event-2', attempt: 2 },
		]);
		expect(await driver.queryAll('SELECT event_id, status, attempts FROM memory_monitor_outbox ORDER BY event_id')).toEqual([
			{ event_id: 'event-1', status: 'pending', attempts: 0 },
			{ event_id: 'event-2', status: 'acknowledged', attempts: 1 },
		]);
		await expect(store.recordDeliveryReceipt(deliveryReceipt({ event_id: 'event-2', attempt: 2, outcome: 'failed' }))).rejects.toThrow('monitor delivery receipt conflict');
	});

	test('makes terminal receipts idempotent only for identical content', async () => {
		const { store } = await makeStore();
		const receipt = monitorReceipt({ last_sequence: 0 });
		expect(await store.recordTerminalReceipt(receipt)).toMatchObject({ idempotent: false, monitor_id: 'monitor-1' });
		expect(await store.recordTerminalReceipt(receipt)).toMatchObject({ idempotent: true, monitor_id: 'monitor-1' });
		await expect(store.recordTerminalReceipt(monitorReceipt({ last_sequence: 0, terminal_reason: 'different terminal evidence' }))).rejects.toThrow('monitor receipt conflict');
	});

	test('rejects terminal evidence that does not match the current durable event maximum', async () => {
		const { driver, store } = await makeStore();
		await store.appendEvent(monitorEvent(0), ['terminal']);

		await expect(store.recordTerminalReceipt(monitorReceipt({ last_sequence: 1 })))
			.rejects.toThrow('stale monitor terminal sequence');
		expect(await driver.queryAll('SELECT * FROM memory_monitor_receipts')).toEqual([]);
		expect(await store.recordTerminalReceipt(monitorReceipt({ last_sequence: 0 })))
			.toMatchObject({ idempotent: false, monitor_id: 'monitor-1' });
	});

	test('keeps the final persisted event idempotent after its terminal receipt', async () => {
		const { driver, store } = await makeStore();
		const event = monitorEvent(0);
		await store.appendEvent(event, ['terminal', 'archive']);
		await store.recordTerminalReceipt(monitorReceipt({ last_sequence: 0 }));

		expect(await store.appendEvent(event, ['archive', 'terminal', 'archive'])).toMatchObject({
			idempotent: true,
			event_id: 'event-1',
		});
		expect(await driver.queryAll('SELECT event_id FROM memory_monitor_events')).toEqual([
			{ event_id: 'event-1' },
		]);
		expect(await driver.queryAll('SELECT event_id, target FROM memory_monitor_outbox ORDER BY target')).toEqual([
			{ event_id: 'event-1', target: 'archive' },
			{ event_id: 'event-1', target: 'terminal' },
		]);
	});

	test('serializes event and terminal writers so either ordering rejects the stale second write', async () => {
		const appendFirstPath = makeDatabasePath();
		const appendFirstOwner = await makeStore(appendFirstPath);
		const appendFirstPeer = await makeStore(appendFirstPath);
		await appendFirstOwner.store.appendEvent(monitorEvent(0), ['terminal']);
		await appendFirstOwner.store.appendEvent(monitorEvent(1, { event_id: 'event-2' }), ['terminal']);
		await expect(appendFirstPeer.store.recordTerminalReceipt(monitorReceipt({ last_sequence: 0 })))
			.rejects.toThrow('stale monitor terminal sequence');
		expect(await appendFirstOwner.driver.queryAll('SELECT COUNT(*) AS n FROM memory_monitor_receipts')).toEqual([{ n: 0 }]);
		expect(await appendFirstOwner.driver.queryAll('SELECT COUNT(*) AS n FROM memory_monitor_events')).toEqual([{ n: 2 }]);
		expect(await appendFirstOwner.driver.queryAll('SELECT COUNT(*) AS n FROM memory_monitor_outbox')).toEqual([{ n: 2 }]);

		const terminalFirstPath = makeDatabasePath();
		const terminalFirstOwner = await makeStore(terminalFirstPath);
		const terminalFirstPeer = await makeStore(terminalFirstPath);
		await terminalFirstOwner.store.appendEvent(monitorEvent(0), ['terminal']);
		await terminalFirstOwner.store.recordTerminalReceipt(monitorReceipt({ last_sequence: 0 }));
		await expect(terminalFirstPeer.store.appendEvent(monitorEvent(1, { event_id: 'event-2' }), ['terminal']))
			.rejects.toThrow('monitor already has a terminal receipt');
		expect(await terminalFirstOwner.driver.queryAll('SELECT event_id FROM memory_monitor_events')).toEqual([
			{ event_id: 'event-1' },
		]);
		expect(await terminalFirstOwner.driver.queryAll('SELECT event_id, target FROM memory_monitor_outbox')).toEqual([
			{ event_id: 'event-1', target: 'terminal' },
		]);
		expect(await terminalFirstOwner.driver.queryAll('SELECT monitor_id, last_sequence FROM memory_monitor_receipts')).toEqual([
			{ monitor_id: 'monitor-1', last_sequence: 0 },
		]);
	});

	test('rejects unbounded or private monitor payloads before they reach SQLite', async () => {
		const { driver, store } = await makeStore();
		const privateEvent = monitorEvent(0, { bounded_payload: { path: 'C:\\Users\\secret-user\\tokens.txt' } });
		await expect(store.appendEvent(privateEvent, ['terminal'])).rejects.toThrow('Contract validation failed');
		expect(await driver.queryAll('SELECT COUNT(*) AS n FROM memory_monitor_events')).toEqual([{ n: 0 }]);
	});

	test('preserves event evidence through SQLite backup and restore, while rollback disables writers without deleting evidence', async () => {
		const { databasePath, driver, store } = await makeStore();
		await store.appendEvent(monitorEvent(), ['terminal']);
		await store.recordDeliveryReceipt(deliveryReceipt());
		await store.recordTerminalReceipt(monitorReceipt({ last_sequence: 0, undelivered_cursor: 0 }));
		const backupPath = path.join(path.dirname(databasePath), 'monitor.backup.sqlite');
		await driver.backup(backupPath);
		driver.close();

		const restoredDriver = createBuiltinSQLiteDriver({ databasePath: backupPath });
		createdDrivers.push(restoredDriver);
		const restored = createMonitorStore(restoredDriver);
		expect(await restored.listEvents('monitor-1')).toHaveLength(1);
		expect(await restoredDriver.queryAll('SELECT COUNT(*) AS n FROM memory_monitor_outbox')).toEqual([{ n: 1 }]);
		expect(await restoredDriver.queryAll('SELECT COUNT(*) AS n FROM memory_monitor_delivery_receipts')).toEqual([{ n: 1 }]);
		expect(await restoredDriver.queryAll('SELECT monitor_id, target, sequence FROM memory_monitor_cursors')).toEqual([
			{ monitor_id: 'monitor-1', target: 'terminal', sequence: 0 },
		]);
		expect(await restoredDriver.queryAll('SELECT monitor_id, last_sequence, undelivered_cursor FROM memory_monitor_receipts')).toEqual([
			{ monitor_id: 'monitor-1', last_sequence: 0, undelivered_cursor: 0 },
		]);
		await expect(restored.appendEvent(monitorEvent(1, { event_id: 'event-2' }), ['terminal'], { monitorDurabilityEnabled: false })).rejects.toThrow('disabled');
		expect(await restored.listEvents('monitor-1')).toHaveLength(1);
	});

	test('rejects backup destinations that alias the live database or SQLite sidecars', async () => {
		for (const suffix of ['', '-wal', '-shm', '-journal']) {
			const databasePath = makeDatabasePath();
			const { driver, store } = await makeStore(databasePath);
			await store.appendEvent(monitorEvent(), ['terminal']);
			await expect(driver.backup(`${databasePath}${suffix}`)).rejects.toThrow('live SQLite');
			driver.close();
		}
	});

	test('preserves an existing backup when snapshot writing or verification fails', async () => {
		const databasePath = makeDatabasePath();
		const existingBackup = path.join(path.dirname(databasePath), 'known-good.sqlite');
		const source = await makeStore(databasePath);
		await source.store.appendEvent(monitorEvent(), ['terminal']);
		await source.driver.backup(existingBackup);
		const original = fs.readFileSync(existingBackup);

		for (const driverOptions of [
			{ backupWriter: async () => { throw new Error('injected backup write failure'); } },
			{ backupVerifier: () => { throw new Error('injected backup verify failure'); } },
		]) {
			const driver = createBuiltinSQLiteDriver({ databasePath, ...driverOptions });
			createdDrivers.push(driver);
			await expect(driver.backup(existingBackup)).rejects.toThrow('injected backup');
			expect(fs.readFileSync(existingBackup)).toEqual(original);
		}
		expect(fs.readdirSync(path.dirname(databasePath)).some(name => name.endsWith('.tmp'))).toBe(false);

		await source.store.appendEvent(monitorEvent(1, { event_id: 'event-2' }), ['terminal']);
		await source.driver.backup(existingBackup);
		const replacement = createBuiltinSQLiteDriver({ databasePath: existingBackup });
		createdDrivers.push(replacement);
		expect(await replacement.queryAll('SELECT COUNT(*) AS n FROM memory_monitor_events')).toEqual([{ n: 2 }]);
	});

	test('deduplicates bounded targets and rejects oversized, private, or malformed targets for events and receipts', async () => {
		const { driver, store } = await makeStore();
		await store.appendEvent(monitorEvent(), ['terminal', 'terminal']);
		expect(await driver.queryAll('SELECT target FROM memory_monitor_outbox')).toEqual([{ target: 'terminal' }]);
		await expect(store.appendEvent(monitorEvent(1, { event_id: 'event-2' }), Array.from({ length: 33 }, (_, index) => `target-${index}`))).rejects.toThrow('targets');
		await expect(store.appendEvent(monitorEvent(1, { event_id: 'event-2' }), ['C:\\Users\\secret-user\\channel'])).rejects.toThrow('target');
		await expect(store.appendEvent(monitorEvent(1, { event_id: 'event-2' }), ['C:/Users/secret-user'])).rejects.toThrow('target');
		await expect(store.appendEvent(monitorEvent(1, { event_id: 'event-2' }), ['x'.repeat(129)])).rejects.toThrow('target');
		await expect(store.recordDeliveryReceipt(deliveryReceipt({ target: 'C:\\Users\\secret-user\\channel' }))).rejects.toThrow('target');
		await expect(store.recordDeliveryReceipt(deliveryReceipt({ target: 'C:/Users/secret-user' }))).rejects.toThrow('target');
	});

	test('defensively rejects malformed or private envelopes through the raw driver surface', async () => {
		const { driver } = await makeStore();
		await expect(driver.appendMonitorEvent({
			schema_id: 'wrong.schema', content_hash: 'not-a-hash', created_at: 'now',
			payload: { monitor_id: 'monitor-1', event_id: 'bad-event', sequence: 'zero' },
		}, ['terminal'])).rejects.toThrow('invalid monitor event envelope');
		await expect(driver.appendMonitorEvent(monitorEvent(0, {
			bounded_payload: { token: 'api_key=super-secret-value' },
		}), ['terminal'])).rejects.toThrow('private');
		await expect(driver.appendMonitorEvent(monitorEvent(0, {
			bounded_payload: { path: 'C:\\Users\\alice\\secret.txt' },
		}), ['terminal'])).rejects.toThrow('private');
		await expect(driver.appendMonitorEvent(monitorEvent(), ['C:/Users/secret-user'])).rejects.toThrow('target');
		await expect(driver.recordMonitorDeliveryReceipt(deliveryReceipt({ target: 'C:/Users/secret-user' }))).rejects.toThrow(/private|target/);
		expect(await driver.queryAll('SELECT COUNT(*) AS n FROM memory_monitor_events')).toEqual([{ n: 0 }]);
	});

	test('rejects raw serialization hooks without invoking them or persisting their private output', async () => {
		const { driver } = await makeStore();
		const raw = monitorEvent();
		let invoked = 0;
		Object.defineProperty(raw, 'toJSON', {
			enumerable: true,
			value() {
				invoked += 1;
				return { bounded_payload: { path: 'C:\\Users\\alice\\secret.txt' } };
			},
		});

		await expect(driver.appendMonitorEvent(raw, ['terminal'])).rejects.toThrow('plain JSON data');
		expect(invoked).toBe(0);
		expect(await driver.queryAll('SELECT COUNT(*) AS n FROM memory_monitor_events')).toEqual([{ n: 0 }]);
	});

	test('rejects secret-shaped payload keys through public and raw write seams', async () => {
		const { driver, store } = await makeStore();
		const privateKey = 'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ123456';
		const event = monitorEvent(0, { bounded_payload: { [privateKey]: 'redacted' } });

		await expect(store.appendEvent(event, ['terminal'])).rejects.toThrow('private');
		await expect(driver.appendMonitorEvent(event, ['terminal'])).rejects.toThrow('private');
		expect(await driver.queryAll('SELECT COUNT(*) AS n FROM memory_monitor_events')).toEqual([{ n: 0 }]);
	});

	test('keeps secret detector boundaries stable for short and long token-shaped values', async () => {
		const { driver, store } = await makeStore();
		const shortToken = monitorEvent(0, { bounded_payload: { message: 'token=1234567' } });
		expect(await store.appendEvent(shortToken, ['terminal'])).toMatchObject({ idempotent: false });

		const longToken = monitorEvent(1, {
			event_id: 'event-2',
			bounded_payload: { message: 'token=12345678' },
		});
		await expect(driver.appendMonitorEvent(longToken, ['terminal'])).rejects.toThrow('private');
		expect(await driver.queryAll('SELECT COUNT(*) AS n FROM memory_monitor_events')).toEqual([{ n: 1 }]);
	});

	test('rejects GitHub PATs, root paths, and UNC user paths through public and raw seams', async () => {
		const { driver, store } = await makeStore();
		const privateValues = [
			`github_pat_${'x'.repeat(30)}`,
			'/root/forge/private.txt',
			'\\\\server\\Users\\alice\\private.txt',
			'C:\\Users\\John Doe\\secret.txt',
		];

		for (const [index, value] of privateValues.entries()) {
			const event = monitorEvent(index, {
				event_id: `private-event-${index}`,
				bounded_payload: { value },
			});
			await expect(store.appendEvent(event, ['terminal'])).rejects.toThrow(/private|Contract validation failed/);
			await expect(driver.appendMonitorEvent(event, ['terminal'])).rejects.toThrow('private');
		}
		expect(await driver.queryAll('SELECT COUNT(*) AS n FROM memory_monitor_events')).toEqual([{ n: 0 }]);
	});
});
