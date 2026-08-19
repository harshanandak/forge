'use strict';

const { describe, test, expect, beforeEach, afterEach } = require('bun:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createBuiltinSQLiteDriver } = require('../../lib/kernel/sqlite-driver');
const owner = require('../../lib/pr-monitor/watch-owner');

const NOW = '2026-08-19T08:00:00.000Z';
const LATER = '2026-08-19T08:00:01.000Z';
const NEXT = '2026-08-19T08:00:02.000Z';
const INVALID_TIMESTAMP = '2026-13-40T25:61:61.999Z';
const HASH = 'a'.repeat(64);
const OTHER_HASH = 'b'.repeat(64);

describe('watch owner SQLite authority', () => {
	let root;
	let databasePath;
	let driver;

	test('exports only the six exact migration-gate domain API names', () => {
		expect(Object.keys(owner).filter(name => name.includes('Migration')).sort()).toEqual([
			'bindMigrationSnapshot',
			'completeMigrationGate',
			'publishMigrationConflict',
			'publishMigrationQuarantine',
			'readMigrationGate',
			'retryMigrationConflict',
		]);
		expect(owner.completeMigration).toBeUndefined();
	});

	test('captures changing repository identity once and fails closed when accessors throw', async () => {
		let capturedIdentity;
		const readDriver = {
			watchOwnerRead(input) {
				capturedIdentity = input;
				return { ok: true, changed: false, reason: 'not_found', row: null };
			},
		};
		let changingReads = 0;
		const changing = {
			get repo() {
				changingReads += 1;
				return changingReads === 1 ? 'acme/forge' : null;
			},
			pr: 41,
		};
		expect(await owner.readOwner(changing, { driver: readDriver })).toEqual({
			ok: true, changed: false, reason: 'not_found', record: null,
		});
		expect(changingReads).toBe(1);
		expect(capturedIdentity).toEqual({ repo: 'acme/forge', pr: 41 });

		const throwing = new Proxy({ pr: 42 }, {
			get(target, property) {
				if (property === 'repo') throw new Error('repository accessor failed');
				return Reflect.get(target, property);
			},
		});
		expect(await owner.readOwner(throwing, { driver: readDriver })).toEqual({
			ok: false, changed: false, reason: 'invalid_input', record: null,
		});
	});

	test('rejects malformed rows returned by an injected read driver', async () => {
		const malformedRow = {
			repo: 'acme/forge', pr: '81', version: '1', generation: 'generation-81', phase: 'starting',
			controller_pid: 281, watcher_pid: null, started_at: NOW, updated_at: NOW,
			heartbeat_at: null, terminal_receipt_id: null, block_reason: null, legacy_evidence_hash: null,
		};
		expect(await owner.readOwner({ repo: 'acme/forge', pr: 81 }, {
			driver: {
				watchOwnerRead: () => ({ ok: true, changed: false, reason: 'read', row: malformedRow }),
			},
		})).toEqual({ ok: false, changed: false, reason: 'corrupt', record: null });
	});

	test('freezes a copied authority snapshot across awaited receipt verification', async () => {
		const retainedRow = {
			repo: 'acme/forge', pr: 68, version: 1, generation: 'generation-68', phase: 'running',
			controller_pid: null, watcher_pid: 268, started_at: NOW, updated_at: NOW,
			heartbeat_at: NOW, terminal_receipt_id: null, block_reason: null, legacy_evidence_hash: null,
		};
		let submitted;
		const injectedDriver = {
			watchOwnerRead() {
				return { ok: true, changed: false, reason: 'read', row: retainedRow };
			},
			watchOwnerRecordTerminal(input) {
				submitted = input;
				const authorized = input.expectedSnapshot?.phase === 'running';
				return { ok: authorized, changed: authorized, reason: authorized ? 'recorded' : 'snapshot_mismatch' };
			},
		};

		const result = await owner.recordTerminal({ repo: 'acme/forge', pr: 68 }, {
			generation: 'generation-68', pid: 268, terminalReceiptId: 'receipt-68', updatedAt: NEXT,
		}, {
			driver: injectedDriver,
			verifyTerminalReceipt: async () => {
				await Promise.resolve();
				retainedRow.phase = 'blocked';
				return true;
			},
		});

		expect(result).toMatchObject({ ok: true, changed: true, reason: 'recorded' });
		expect(submitted.expectedSnapshot).toMatchObject({ phase: 'running', watcher_pid: 268 });
		expect(Object.isFrozen(submitted.expectedSnapshot)).toBe(true);
		expect(retainedRow.phase).toBe('blocked');
	});

	test.each([
		['recordTerminal', {
			input: { generation: 'generation-77', pid: 101, terminalReceiptId: 'receipt-77', updatedAt: NOW },
			awaitKind: 'receipt',
		}],
		['reserveReopened', {
			input: {
				generation: 'generation-77', controllerPid: 202, expectedReceiptId: 'receipt-77',
				providerEvidence: { state: 'OPEN' }, updatedAt: NOW,
			},
			awaitKind: 'provider',
		}],
		['completeTerminal', {
			input: { generation: 'generation-77', pid: 101, terminalReceiptId: 'receipt-77', updatedAt: NOW },
			awaitKind: 'pid', pidResult: false,
		}],
		['abortStarting', {
			input: { generation: 'generation-77', controllerPid: 101, updatedAt: NOW },
			awaitKind: 'pid', pidResult: true,
		}],
		['recoverDeadStarting', {
			input: { generation: 'generation-77', controllerPid: 101, recoveryControllerPid: 202, updatedAt: NOW },
			awaitKind: 'pid', pidResult: false,
		}],
		['recoverDeadWatcher', {
			input: {
				generation: 'generation-77', pid: 101, recoveryControllerPid: 202,
				providerEvidence: { state: 'OPEN' }, updatedAt: NOW,
			},
			awaitKind: 'pid-and-provider', pidResult: false,
		}],
		['markLegacyBlocked', {
			input: {
				blockReason: 'legacy_live_pid', snapshotHash: HASH, legacyEvidenceHash: OTHER_HASH,
				pid: 101, terminalReceiptId: 'legacy-receipt', startedAt: NOW,
			},
			awaitKind: 'pid', pidResult: true,
		}],
		['recheckLegacyBlocked', {
			input: {
				generation: 'generation-77', action: 'complete', legacyEvidenceHash: OTHER_HASH,
				pid: 101, terminalReceiptId: 'receipt-77', updatedAt: NOW,
			},
			awaitKind: 'pid-and-receipt', pidResult: false,
			blocked: true,
		}],
		['importLegacyComplete', {
			input: {
				snapshotHash: HASH, legacyEvidenceHash: OTHER_HASH, legacyPid: 101,
				terminalReceiptId: 'receipt-77', startedAt: NOW,
			},
			awaitKind: 'pid-and-receipt', pidResult: false,
		}],
		['importLegacyStarting', {
			input: {
				snapshotHash: HASH, legacyEvidenceHash: OTHER_HASH, legacyPid: 101,
				controllerPid: 202, providerEvidence: { state: 'OPEN' }, startedAt: NOW,
			},
			awaitKind: 'pid-and-provider', pidResult: false,
		}],
	])('pins the authority target across async %s evidence verification', async (method, scenario) => {
		const makeDriver = (label, blocked = false) => {
			const calls = [];
			const row = {
				repo: 'acme/forge', pr: 77, version: 1, generation: 'generation-77',
				phase: blocked ? 'blocked' : 'running', controller_pid: null,
				watcher_pid: blocked ? null : 101, started_at: NOW, updated_at: NOW,
				heartbeat_at: blocked ? null : NOW, terminal_receipt_id: blocked ? null : null,
				block_reason: blocked ? 'legacy_lossy' : null, legacy_evidence_hash: blocked ? OTHER_HASH : null,
			};
			const driver = {
				calls,
				watchOwnerRead(input, config) {
					calls.push({ method: 'watchOwnerRead', input, config });
					return { ok: true, changed: false, reason: 'read', row };
				},
				watchGateRead(input, config) {
					calls.push({ method: 'watchGateRead', input, config });
					return {
						ok: true, changed: false, reason: 'read',
						gate: { state: 'quarantined', snapshot_hash: HASH, conflict_code: null },
					};
				},
			};
			for (const operation of [
				'watchOwnerReserveReopened', 'watchOwnerRecordTerminal', 'watchOwnerCompleteTerminal', 'watchOwnerAbortStarting',
				'watchOwnerRecoverDeadStarting', 'watchOwnerRecoverDeadWatcher',
				'watchOwnerMarkLegacyBlocked', 'watchOwnerRecheckLegacyBlocked',
				'watchOwnerImportLegacyComplete', 'watchOwnerImportLegacyStarting',
			]) {
				driver[operation] = (input, config) => {
					calls.push({ method: operation, input, config });
					return { ok: true, changed: true, reason: `mutated-${label}`, row: null };
				};
			}
			return driver;
		};

		const driverA = makeDriver('A', scenario.blocked);
		const driverB = makeDriver('B', scenario.blocked);
		const opts = {
			driver: driverA,
			databaseConfig: { databasePath: 'authority-A.sqlite' },
			now: NOW,
		};
		const mutateAuthority = operation => {
			opts.driver = driverB;
			opts.databaseConfig = { databasePath: 'authority-B.sqlite' };
			driverA[operation] = driverB[operation];
		};
		if (scenario.awaitKind.includes('pid')) {
			opts.isPidAlive = async () => {
				mutateAuthority(scenario.method || method);
				return scenario.pidResult;
			};
		}
		if (scenario.awaitKind.includes('receipt')) {
			opts.verifyTerminalReceipt = async () => {
				mutateAuthority(scenario.method || method);
				return true;
			};
		}
		if (scenario.awaitKind.includes('provider')) {
			opts.verifyProviderEvidence = async () => {
				mutateAuthority(scenario.method || method);
				return true;
			};
		}

		const result = await owner[method]({ repo: 'acme/forge', pr: 77 }, scenario.input, opts);
		expect(result).toMatchObject({ ok: true, changed: true, reason: `mutated-A` });
		expect(driverB.calls).toEqual([]);
		expect(driverA.calls.length).toBeGreaterThanOrEqual(2);
		expect(driverA.calls.every(call => call.config.databasePath === 'authority-A.sqlite')).toBe(true);
	});

	test('does not trust a spoofed bound-options marker across receipt verification', async () => {
		const row = {
			repo: 'acme/forge', pr: 79, version: 1, generation: 'generation-79', phase: 'running',
			controller_pid: null, watcher_pid: 279, started_at: NOW, updated_at: NOW,
			heartbeat_at: NOW, terminal_receipt_id: null, block_reason: null, legacy_evidence_hash: null,
		};
		const makeDriver = label => ({
			watchOwnerRead: () => ({ ok: true, changed: false, reason: 'read', row }),
			watchOwnerRecordTerminal: () => ({ ok: true, changed: true, reason: `mutated-${label}`, row: null }),
		});
		const driverA = makeDriver('A');
		const driverB = makeDriver('B');
		let activeDriver = driverA;
		const opts = new Proxy({
			verifyTerminalReceipt: async () => {
				activeDriver = driverB;
				return true;
			},
		}, {
			get(_target, property) {
				if (typeof property === 'symbol') return true;
				if (property === 'driver') return activeDriver;
				if (property === 'databaseConfig') return {};
				if (property === 'authorityMethods') return {
					watchOwnerRead: activeDriver.watchOwnerRead,
					watchOwnerRecordTerminal: activeDriver.watchOwnerRecordTerminal,
				};
				return Reflect.get(_target, property);
			},
		});

		expect(await owner.recordTerminal({ repo: 'acme/forge', pr: 79 }, {
			generation: 'generation-79', pid: 279, terminalReceiptId: 'receipt-79', updatedAt: NEXT,
		}, opts)).toMatchObject({ ok: true, changed: true, reason: 'mutated-A' });
	});

	test('returns a tagged invalid-input envelope when mutation accessors throw', async () => {
		const throwingGeneration = new Proxy({ controllerPid: 301, startedAt: NOW }, {
			get(target, property) {
				if (property === 'generation') throw new Error('generation accessor failed');
				return Reflect.get(target, property);
			},
		});
		expect(await owner.reserveStarting({ repo: 'acme/forge', pr: 301 }, throwingGeneration, { driver }))
			.toEqual({ ok: false, changed: false, reason: 'invalid_input', record: null });

		const throwingTimestamp = new Proxy({ generation: 'generation-302', controllerPid: 302, startedAt: NOW }, {
			get(target, property) {
				if (property === 'updatedAt') throw new Error('timestamp accessor failed');
				return Reflect.get(target, property);
			},
		});
		expect(await owner.reserveStarting({ repo: 'acme/forge', pr: 302 }, throwingTimestamp, { driver }))
			.toEqual({ ok: false, changed: false, reason: 'invalid_input', record: null });
		expect(await driver.queryAll('SELECT * FROM kernel_pr_watch_owners WHERE pr IN (301, 302)')).toEqual([]);
	});

	test('binds only the exact authority methods needed by an evidence-bound call', async () => {
		const calls = [];
		const target = {
			watchOwnerRead() {
				calls.push('read');
				return { ok: true, changed: false, reason: 'read', row: null };
			},
			watchOwnerRecordTerminal() {
				calls.push('record');
				return { ok: true, changed: true, reason: 'recorded', row: null };
			},
		};
		const driverProxy = new Proxy(target, {
			get(source, property, receiver) {
				if (property === 'watchOwnerRead' || property === 'watchOwnerRecordTerminal') {
					return Reflect.get(source, property, receiver);
				}
				if (typeof property === 'string' && property.startsWith('watch')) {
					throw new Error(`unexpected authority method lookup: ${property}`);
				}
				return Reflect.get(source, property, receiver);
			},
		});

		expect(await owner.recordTerminal({ repo: 'acme/forge', pr: 303 }, {
			generation: 'generation-303', pid: 303, terminalReceiptId: 'receipt-303', updatedAt: NOW,
		}, {
			driver: driverProxy,
			verifyTerminalReceipt: async () => true,
		})).toMatchObject({ ok: true, changed: true, reason: 'recorded' });
		expect(calls).toEqual(['read', 'record']);
	});

	beforeEach(async () => {
		root = fs.mkdtempSync(path.join(os.tmpdir(), 'watch-owner-sqlite-'));
		databasePath = path.join(root, 'forge', 'kernel.sqlite');
		driver = createBuiltinSQLiteDriver({ databasePath });
		await driver.exec(`
			CREATE TABLE kernel_pr_watch_owners (
				repo TEXT NOT NULL,
				pr INTEGER NOT NULL,
				version INTEGER NOT NULL,
				generation TEXT NOT NULL,
				phase TEXT NOT NULL,
				controller_pid INTEGER,
				watcher_pid INTEGER,
				started_at TEXT NOT NULL,
				updated_at TEXT NOT NULL,
				heartbeat_at TEXT,
				terminal_receipt_id TEXT,
				block_reason TEXT,
				legacy_evidence_hash TEXT,
				PRIMARY KEY (repo, pr)
			);
			CREATE TABLE kernel_pr_watch_migration_gate (
				singleton INTEGER NOT NULL PRIMARY KEY,
				state TEXT NOT NULL,
				snapshot_hash TEXT,
				conflict_code TEXT,
				updated_at TEXT NOT NULL
			);
		`);
	});

	afterEach(() => {
		driver?.close();
		fs.rmSync(root, { recursive: true, force: true });
	});

	test('reserveStarting mints exactly one generation in the authoritative row', async () => {
		const ctx = { repo: 'Acme/Forge', pr: 42 };
		const first = await owner.reserveStarting(ctx, {
			controllerPid: 123, startedAt: NOW, legacyEvidenceHash: HASH,
		}, { driver });
		const second = await owner.reserveStarting(ctx, { controllerPid: 456, startedAt: NOW }, { driver });

		expect(first).toMatchObject({ ok: true, changed: true, reason: 'acquired' });
		expect(first.record).toMatchObject({
			repo: 'acme/forge', pr: 42, version: 1, phase: 'starting', controllerPid: 123,
			watcherPid: null, startedAt: NOW, updatedAt: NOW,
		});
		expect(first.record.generation).toMatch(/^[0-9a-f-]{36}$/);
		expect(first.record.legacyEvidenceHash).toBeNull();
		expect(second).toEqual({ ok: false, changed: false, reason: 'busy', record: first.record });
		const rows = await driver.queryAll('SELECT repo, pr, generation FROM kernel_pr_watch_owners');
		expect(rows).toEqual([{ repo: 'acme/forge', pr: 42, generation: first.record.generation }]);
	});

	test('drives the normal lifecycle with exact generation, PID, receipt, and evidence CAS', async () => {
		const ctx = { repo: 'acme/forge', pr: 43 };
		const base = { driver, now: LATER };
		const start = await owner.reserveStarting(ctx, { controllerPid: 100, startedAt: NOW }, base);
		const stale = await owner.bindRunning(ctx, {
			generation: 'stale-generation', controllerPid: 100, pid: 200, updatedAt: LATER,
		}, base);
		expect(stale).toMatchObject({ ok: false, changed: false, reason: 'generation_mismatch' });

		const running = await owner.bindRunning(ctx, {
			generation: start.record.generation, controllerPid: 100, pid: 200, updatedAt: LATER,
		}, base);
		expect(running).toMatchObject({ ok: true, changed: true, reason: 'bound', record: { phase: 'running' } });
		const beat = await owner.heartbeat(ctx, {
			generation: start.record.generation, pid: 200, updatedAt: LATER,
		}, base);
		expect(beat).toMatchObject({ ok: true, record: { heartbeatAt: LATER } });
		const stopping = await owner.requestStop(ctx, {
			generation: start.record.generation, pid: 200, updatedAt: LATER,
		}, base);
		expect(stopping).toMatchObject({ ok: true, record: { phase: 'stop_requested' } });

		let receiptChecks = 0;
		const terminal = await owner.recordTerminal(ctx, {
			generation: start.record.generation, pid: 200, terminalReceiptId: 'receipt-43', updatedAt: LATER,
		}, { ...base, verifyTerminalReceipt: async () => { receiptChecks += 1; return true; } });
		expect(receiptChecks).toBe(1);
		expect(terminal).toMatchObject({ ok: true, record: { phase: 'terminal_pending', terminalReceiptId: 'receipt-43' } });

		let pidChecks = 0;
		const complete = await owner.completeTerminal(ctx, {
			generation: start.record.generation, pid: 200, terminalReceiptId: 'receipt-43', updatedAt: LATER,
		}, { ...base, isPidAlive: () => { pidChecks += 1; return false; } });
		expect(pidChecks).toBe(1);
		expect(complete).toMatchObject({ ok: true, record: { phase: 'complete', watcherPid: null } });
		let replayPidChecks = 0;
		const replay = await owner.completeTerminal(ctx, {
			generation: start.record.generation, pid: 200, terminalReceiptId: 'receipt-43', updatedAt: NEXT,
		}, { ...base, isPidAlive: () => { replayPidChecks += 1; return true; } });
		expect(replayPidChecks).toBe(0);
		expect(replay).toMatchObject({ ok: true, changed: false, reason: 'idempotent', record: { phase: 'complete' } });

		let providerChecks = 0;
		const reopened = await owner.reserveReopened(ctx, {
			generation: start.record.generation, controllerPid: 300, expectedReceiptId: 'receipt-43',
			providerEvidence: { state: 'OPEN' }, startedAt: LATER,
		}, { ...base, verifyProviderEvidence: async () => { providerChecks += 1; return true; } });
		expect(providerChecks).toBe(1);
		expect(reopened).toMatchObject({ ok: true, changed: true, reason: 'reopened', record: { phase: 'starting', controllerPid: 300 } });
		expect(reopened.record.generation).not.toBe(start.record.generation);
	});

	test('supports exact abort, release, and dead-process recovery without a generic clear', async () => {
		const base = { driver, now: LATER };
		const abortCtx = { repo: 'acme/forge', pr: 44 };
		const abortStart = await owner.reserveStarting(abortCtx, { controllerPid: 101, startedAt: NOW }, base);
		const aborted = await owner.abortStarting(abortCtx, {
			generation: abortStart.record.generation, controllerPid: 101,
		}, { ...base, isPidAlive: () => true });
		expect(aborted).toEqual({ ok: true, changed: true, reason: 'aborted', record: null });

		const releaseStart = await owner.reserveStarting(abortCtx, { controllerPid: 102, startedAt: NOW }, base);
		await owner.bindRunning(abortCtx, {
			generation: releaseStart.record.generation, controllerPid: 102, pid: 202, updatedAt: LATER,
		}, base);
		await owner.requestStop(abortCtx, {
			generation: releaseStart.record.generation, pid: 202, updatedAt: LATER,
		}, base);
		const released = await owner.releaseNonterminal(abortCtx, {
			generation: releaseStart.record.generation, pid: 202,
		}, base);
		expect(released).toEqual({ ok: true, changed: true, reason: 'released', record: null });

		const recoveryCtx = { repo: 'acme/forge', pr: 45 };
		const deadStart = await owner.reserveStarting(recoveryCtx, { controllerPid: 103, startedAt: NOW }, base);
		const recoveredStart = await owner.recoverDeadStarting(recoveryCtx, {
			generation: deadStart.record.generation, controllerPid: 103, recoveryControllerPid: 104,
			updatedAt: LATER,
		}, { ...base, isPidAlive: () => false });
		expect(recoveredStart).toMatchObject({ ok: true, record: { phase: 'starting', controllerPid: 104 } });
		expect(recoveredStart.record.generation).not.toBe(deadStart.record.generation);
		await owner.bindRunning(recoveryCtx, {
			generation: recoveredStart.record.generation, controllerPid: 104, pid: 204, updatedAt: LATER,
		}, base);
		const recoveredWatcher = await owner.recoverDeadWatcher(recoveryCtx, {
			generation: recoveredStart.record.generation, pid: 204, recoveryControllerPid: 105,
			providerEvidence: { state: 'OPEN' }, updatedAt: LATER,
		}, { ...base, isPidAlive: () => false, verifyProviderEvidence: async () => true });
		expect(recoveredWatcher).toMatchObject({ ok: true, record: { phase: 'starting', controllerPid: 105 } });
		expect(owner.clear).toBeUndefined();
		expect(owner.transition).toBeUndefined();
		expect(owner.importLegacy).toBeUndefined();
	});

	test('rejects dead-watcher recovery when a heartbeat changes the evidence snapshot', async () => {
		const ctx = { repo: 'acme/forge', pr: 56 };
		const base = { driver, now: LATER };
		const start = await owner.reserveStarting(ctx, { controllerPid: 106, startedAt: NOW }, base);
		await owner.bindRunning(ctx, {
			generation: start.record.generation, controllerPid: 106, pid: 206, updatedAt: LATER,
		}, base);
		const recovered = await owner.recoverDeadWatcher(ctx, {
			generation: start.record.generation, pid: 206, recoveryControllerPid: 107,
			providerEvidence: { state: 'OPEN' }, updatedAt: NEXT,
		}, {
			...base,
			isPidAlive: () => false,
			verifyProviderEvidence: async () => {
				await owner.heartbeat(ctx, {
					generation: start.record.generation, pid: 206, updatedAt: NEXT,
				}, base);
				return true;
			},
		});
		expect(recovered).toMatchObject({ ok: false, changed: false, reason: 'stale_evidence' });
		const current = await owner.readOwner(ctx, { driver });
		expect(current).toMatchObject({ ok: true, record: { phase: 'running', heartbeatAt: NEXT, watcherPid: 206 } });
	});

	test('rejects stale controller, phase, receipt, and legacy evidence without mutation', async () => {
		const base = { driver, now: LATER };
		const controllerCtx = { repo: 'acme/forge', pr: 57 };
		const controllerStart = await owner.reserveStarting(controllerCtx, { controllerPid: 107, startedAt: NOW }, base);
		const phaseCtx = { repo: 'acme/forge', pr: 58 };
		const phaseStart = await owner.reserveStarting(phaseCtx, { controllerPid: 108, startedAt: NOW }, base);
		const receiptCtx = { repo: 'acme/forge', pr: 59 };
		const receiptStart = await owner.reserveStarting(receiptCtx, { controllerPid: 109, startedAt: NOW }, base);
		await owner.bindRunning(receiptCtx, {
			generation: receiptStart.record.generation, controllerPid: 109, pid: 209, updatedAt: LATER,
		}, base);
		await owner.recordTerminal(receiptCtx, {
			generation: receiptStart.record.generation, pid: 209, terminalReceiptId: 'receipt-59', updatedAt: LATER,
		}, { ...base, verifyTerminalReceipt: async () => true });
		await owner.completeTerminal(receiptCtx, {
			generation: receiptStart.record.generation, pid: 209, terminalReceiptId: 'receipt-59', updatedAt: LATER,
		}, { ...base, isPidAlive: () => false });
		await owner.publishMigrationQuarantine({ updatedAt: NOW }, base);
		await owner.bindMigrationSnapshot({ snapshotHash: HASH, updatedAt: NOW }, base);
		const evidenceCtx = { repo: 'acme/forge', pr: 60 };
		const blocked = await owner.markLegacyBlocked(evidenceCtx, {
			blockReason: 'legacy_lossy', snapshotHash: HASH, legacyEvidenceHash: HASH, startedAt: NOW,
		}, base);

		const cases = [
			{
				name: 'controller PID', ctx: controllerCtx, reason: 'controller_pid_mismatch',
				attempt: () => owner.bindRunning(controllerCtx, {
					generation: controllerStart.record.generation, controllerPid: 999, pid: 207, updatedAt: LATER,
				}, base),
			},
			{
				name: 'phase', ctx: phaseCtx, reason: 'phase_mismatch',
				attempt: () => owner.heartbeat(phaseCtx, {
					generation: phaseStart.record.generation, pid: 208, updatedAt: LATER,
				}, base),
			},
			{
				name: 'receipt', ctx: receiptCtx, reason: 'receipt_mismatch',
				attempt: () => owner.reserveReopened(receiptCtx, {
					generation: receiptStart.record.generation, controllerPid: 309,
					expectedReceiptId: 'stale-receipt', providerEvidence: { state: 'OPEN' }, startedAt: NEXT,
				}, { ...base, verifyProviderEvidence: async () => true }),
			},
			{
				name: 'legacy evidence', ctx: evidenceCtx, reason: 'evidence_mismatch',
				attempt: () => owner.recheckLegacyBlocked(evidenceCtx, {
					generation: blocked.record.generation, action: 'release',
					legacyEvidenceHash: OTHER_HASH, updatedAt: LATER,
				}, base),
			},
		];
		for (const scenario of cases) {
			const query = `SELECT * FROM kernel_pr_watch_owners WHERE repo = 'acme/forge' AND pr = ${scenario.ctx.pr}`;
			const before = await driver.queryAll(query);
			expect(await scenario.attempt(), scenario.name)
				.toMatchObject({ ok: false, changed: false, reason: scenario.reason });
			expect(await driver.queryAll(query), scenario.name).toEqual(before);
		}
	});

	test('rejects terminal receipt evidence when its authoritative snapshot changes', async () => {
		const ctx = { repo: 'acme/forge', pr: 61 };
		const base = { driver, now: LATER };
		const start = await owner.reserveStarting(ctx, { controllerPid: 111, startedAt: NOW }, base);
		await owner.bindRunning(ctx, {
			generation: start.record.generation, controllerPid: 111, pid: 211, updatedAt: LATER,
		}, base);
		let concurrent;
		const terminal = await owner.recordTerminal(ctx, {
			generation: start.record.generation, pid: 211, terminalReceiptId: 'receipt-61', updatedAt: NEXT,
		}, {
			...base,
			verifyTerminalReceipt: async () => {
				await owner.heartbeat(ctx, { generation: start.record.generation, pid: 211, updatedAt: NEXT }, base);
				concurrent = await owner.readOwner(ctx, { driver });
				return true;
			},
		});
		expect(terminal).toMatchObject({ ok: false, changed: false, reason: 'stale_evidence' });
		expect(await owner.readOwner(ctx, { driver })).toEqual(concurrent);
	});

	test('uses the receipt value verified before an await for normal and legacy terminal writes', async () => {
		const normalCtx = { repo: 'acme/forge', pr: 62 };
		const normalStart = await owner.reserveStarting(normalCtx, {
			controllerPid: 112, startedAt: NOW,
		}, { driver, now: LATER });
		await owner.bindRunning(normalCtx, {
			generation: normalStart.record.generation, controllerPid: 112, pid: 212, updatedAt: LATER,
		}, { driver });
		const normalInput = {
			generation: normalStart.record.generation, pid: 212,
			terminalReceiptId: 'receipt-normal-original', updatedAt: NEXT,
		};
		let normalVerificationIdentity;
		const normal = await owner.recordTerminal(normalCtx, normalInput, {
			driver,
			verifyTerminalReceipt: async (_receipt, identity) => {
				normalVerificationIdentity = identity;
				normalInput.terminalReceiptId = 'receipt-normal-mutated';
				try { identity.now = '2099-01-01T00:00:00.000Z'; } catch {}
				return true;
			},
		});

		await owner.publishMigrationQuarantine({ updatedAt: NOW }, { driver });
		await owner.bindMigrationSnapshot({ snapshotHash: HASH, updatedAt: NOW }, { driver });
		const legacyInput = {
			snapshotHash: HASH, legacyEvidenceHash: OTHER_HASH,
			terminalReceiptId: 'receipt-legacy-original', startedAt: NOW,
		};
		const legacy = await owner.importLegacyComplete({ repo: 'acme/forge', pr: 63 }, legacyInput, {
			driver,
			verifyTerminalReceipt: async () => {
				legacyInput.terminalReceiptId = 'receipt-legacy-mutated';
				return true;
			},
		});

		expect(Object.isFrozen(normalVerificationIdentity)).toBe(true);
		expect(normal).toMatchObject({ ok: true, record: {
			terminalReceiptId: 'receipt-normal-original', updatedAt: NEXT,
		} });
		expect(legacy).toMatchObject({ ok: true, record: {
			terminalReceiptId: 'receipt-legacy-original', updatedAt: NOW,
		} });
	});

	test('keeps the legacy terminal identity immutable across receipt verification', async () => {
		await owner.publishMigrationQuarantine({ updatedAt: NOW }, { driver });
		await owner.bindMigrationSnapshot({ snapshotHash: HASH, updatedAt: NOW }, { driver });
		let verificationIdentity;
		const result = await owner.importLegacyComplete({ repo: 'acme/forge', pr: 65 }, {
			snapshotHash: HASH, legacyEvidenceHash: OTHER_HASH,
			terminalReceiptId: 'receipt-legacy-65', startedAt: NOW,
		}, {
			driver,
			verifyTerminalReceipt: async (_receipt, identity) => {
				verificationIdentity = identity;
				try {
					identity.repo = 'evil/repo';
					identity.pr = 2;
				} catch {}
				return true;
			},
		});

		expect(Object.isFrozen(verificationIdentity)).toBe(true);
		expect(result).toMatchObject({ ok: true, record: { repo: 'acme/forge', pr: 65, phase: 'complete' } });
		expect(await owner.readOwner({ repo: 'evil/repo', pr: 2 }, { driver }))
			.toMatchObject({ ok: true, record: null });
	});

	test('uses provider-bound legacy inputs captured before awaiting verification', async () => {
		await owner.publishMigrationQuarantine({ updatedAt: NOW }, { driver });
		await owner.bindMigrationSnapshot({ snapshotHash: HASH, updatedAt: NOW }, { driver });
		const input = {
			snapshotHash: HASH, legacyEvidenceHash: OTHER_HASH, legacyPid: 313,
			controllerPid: 413, providerEvidence: { state: 'OPEN' }, startedAt: NOW,
		};
		const result = await owner.importLegacyStarting({ repo: 'acme/forge', pr: 64 }, input, {
			driver,
			isPidAlive: () => false,
			verifyProviderEvidence: async () => {
				input.controllerPid = 414;
				input.snapshotHash = OTHER_HASH;
				return true;
			},
		});

		expect(result).toMatchObject({
			ok: true,
			record: { phase: 'starting', controllerPid: 413, legacyEvidenceHash: OTHER_HASH },
		});
	});

	test('fails closed without mutation for an invalid persisted row in every phase', async () => {
		const invalidRows = [
			{ pr: 70, phase: 'starting', controller: 'NULL', watcher: 'NULL', heartbeat: 'NULL', receipt: 'NULL', reason: 'NULL', evidence: 'NULL' },
			{ pr: 71, phase: 'running', controller: 'NULL', watcher: '271', heartbeat: 'NULL', receipt: 'NULL', reason: 'NULL', evidence: 'NULL' },
			{ pr: 72, phase: 'stop_requested', controller: 'NULL', watcher: '272', heartbeat: `'${NOW}'`, receipt: "'unexpected'", reason: 'NULL', evidence: 'NULL' },
			{ pr: 73, phase: 'terminal_pending', controller: 'NULL', watcher: '273', heartbeat: `'${NOW}'`, receipt: 'NULL', reason: 'NULL', evidence: 'NULL' },
			{ pr: 74, phase: 'complete', controller: 'NULL', watcher: '274', heartbeat: 'NULL', receipt: "'receipt-74'", reason: 'NULL', evidence: 'NULL' },
			{ pr: 75, phase: 'blocked', controller: 'NULL', watcher: 'NULL', heartbeat: 'NULL', receipt: 'NULL', reason: "'legacy_lossy'", evidence: 'NULL' },
			{ pr: 78, phase: 'blocked', controller: 'NULL', watcher: 'NULL', heartbeat: `'${NOW}'`, receipt: 'NULL', reason: "'legacy_lossy'", evidence: `'${HASH}'` },
		];
		for (const row of invalidRows) {
			await driver.exec(`INSERT INTO kernel_pr_watch_owners
				(repo, pr, version, generation, phase, controller_pid, watcher_pid, started_at, updated_at,
				 heartbeat_at, terminal_receipt_id, block_reason, legacy_evidence_hash)
				VALUES ('acme/forge', ${row.pr}, 1, 'g-${row.phase}', '${row.phase}', ${row.controller},
				 ${row.watcher}, '${NOW}', '${NOW}', ${row.heartbeat}, ${row.receipt}, ${row.reason}, ${row.evidence});`);
			const query = `SELECT * FROM kernel_pr_watch_owners WHERE repo = 'acme/forge' AND pr = ${row.pr}`;
			const before = await driver.queryAll(query);
			expect(await owner.readOwner({ repo: 'acme/forge', pr: row.pr }, { driver }), row.phase)
				.toMatchObject({ ok: false, changed: false, reason: 'corrupt' });
			expect(await driver.queryAll(query), row.phase).toEqual(before);
		}
	});

	test('tags malformed canonical-looking timestamps as invalid or corrupt without throwing', async () => {
		const direct = {
			repo: 'acme/forge', pr: 76, version: 1, generation: 'g-76', phase: 'starting',
			controllerPid: 276, watcherPid: null, startedAt: INVALID_TIMESTAMP, updatedAt: INVALID_TIMESTAMP,
			heartbeatAt: null, terminalReceiptId: null, blockReason: null, legacyEvidenceHash: null,
		};
		expect(owner.validateRecord(direct)).toBe('invalid_timestamp');
		await driver.exec(`INSERT INTO kernel_pr_watch_owners
			(repo, pr, version, generation, phase, controller_pid, watcher_pid, started_at, updated_at)
			VALUES ('acme/forge', 76, 1, 'g-76', 'starting', 276, NULL, '${INVALID_TIMESTAMP}', '${INVALID_TIMESTAMP}')`);
		const before = await driver.queryAll('SELECT * FROM kernel_pr_watch_owners WHERE pr = 76');
		expect(await owner.readOwner({ repo: 'acme/forge', pr: 76 }, { driver }))
			.toMatchObject({ ok: false, changed: false, reason: 'corrupt' });
		expect(await driver.queryAll('SELECT * FROM kernel_pr_watch_owners WHERE pr = 76')).toEqual(before);
	});

	test('contains accessor failures in the exported record validator', () => {
		const throwing = new Proxy({
			repo: 'acme/forge', pr: 80, version: 1, phase: 'starting', controllerPid: 280,
			watcherPid: null, startedAt: NOW, updatedAt: NOW, heartbeatAt: null,
			terminalReceiptId: null, blockReason: null, legacyEvidenceHash: null,
		}, {
			get(target, property) {
				if (property === 'generation') throw new Error('generation getter must not escape');
				return Reflect.get(target, property);
			},
		});
		let result;
		expect(() => { result = owner.validateRecord(throwing); }).not.toThrow();
		expect(result).toBe('invalid_record');
	});

	test.each(['running', 'stop_requested', 'terminal_pending'])('rejects a %s heartbeat outside the started/updated interval', phase => {
		const base = {
			repo: 'acme/forge', pr: 77, version: 1, generation: 'g-77', phase,
			controllerPid: null, watcherPid: 277, startedAt: NOW, updatedAt: NEXT,
			heartbeatAt: LATER, terminalReceiptId: phase === 'terminal_pending' ? 'receipt-77' : null,
			blockReason: null, legacyEvidenceHash: null,
		};
		expect(owner.validateRecord({ ...base, heartbeatAt: '2026-08-19T07:59:59.000Z' })).toBe('invalid_heartbeat');
		expect(owner.validateRecord({ ...base, heartbeatAt: '2026-08-19T08:00:03.000Z' })).toBe('invalid_heartbeat');
	});

	test('rejects a heartbeat on a blocked owner record', () => {
		expect(owner.validateRecord({
			repo: 'acme/forge', pr: 78, version: 1, generation: 'g-78', phase: 'blocked',
			controllerPid: null, watcherPid: null, startedAt: NOW, updatedAt: NEXT,
			heartbeatAt: NOW, terminalReceiptId: null, blockReason: 'legacy_lossy', legacyEvidenceHash: HASH,
		})).toBe('invalid_blocked');
	});

	test('rejects explicit falsy timestamps instead of replacing them with the clock', async () => {
		for (const [index, startedAt] of [undefined, '', 0, false, null].entries()) {
			expect(await owner.reserveStarting({ repo: 'acme/forge', pr: 120 + index }, {
				controllerPid: 320 + index, startedAt,
			}, { driver, now: () => NOW })).toMatchObject({ ok: false, changed: false, reason: 'invalid_reservation' });
		}
		for (const [index, updatedAt] of [undefined, '', 0, false, null].entries()) {
			expect(await owner.reserveStarting({ repo: 'acme/forge', pr: 130 + index }, {
				controllerPid: 330 + index, startedAt: NOW, updatedAt,
			}, { driver, now: () => LATER })).toMatchObject({ ok: false, changed: false, reason: 'invalid_reservation' });
		}
		expect(await driver.queryAll('SELECT * FROM kernel_pr_watch_owners WHERE pr >= 120')).toEqual([]);
	});

	test.each([
		['undefined', undefined],
		['empty string', ''],
		['zero', 0],
		['false', false],
		['null', null],
	])('rejects an explicit %s migration-gate timestamp instead of using the clock', async (_label, updatedAt) => {
		const results = await Promise.all([
			owner.publishMigrationQuarantine({ updatedAt }, { driver, now: () => NOW }),
			owner.bindMigrationSnapshot({ snapshotHash: HASH, updatedAt }, { driver, now: () => NOW }),
			owner.publishMigrationConflict({
				snapshotHash: HASH, conflictCode: 'legacy_owner_conflict', updatedAt,
			}, { driver, now: () => NOW }),
			owner.retryMigrationConflict({
				expectedSnapshotHash: HASH, expectedConflictCode: 'legacy_owner_conflict',
				replacementSnapshotHash: OTHER_HASH, updatedAt,
			}, { driver, now: () => NOW }),
			owner.completeMigrationGate({ snapshotHash: HASH, updatedAt }, { driver, now: () => NOW }),
		]);

		expect(results.every(result => result.ok === false && result.changed === false && result.gate === null)).toBeTrue();
		expect(await driver.queryAll('SELECT * FROM kernel_pr_watch_migration_gate')).toEqual([]);
		expect(await owner.publishMigrationQuarantine({}, { driver, now: () => NOW }))
			.toMatchObject({ ok: true, changed: true, reason: 'quarantined', gate: { updated_at: NOW } });
	});

	test('rejects a heartbeat older than the authoritative update timestamp', async () => {
		const ctx = { repo: 'acme/forge', pr: 124 };
		const started = await owner.reserveStarting(ctx, { controllerPid: 324, startedAt: NOW }, { driver });
		await owner.bindRunning(ctx, {
			generation: started.record.generation, controllerPid: 324, pid: 424, updatedAt: LATER,
		}, { driver });
		const before = await owner.readOwner(ctx, { driver });
		expect(await owner.heartbeat(ctx, {
			generation: started.record.generation, pid: 424, updatedAt: NOW,
		}, { driver })).toMatchObject({ ok: false, changed: false, reason: 'stale_evidence' });
		expect(await owner.readOwner(ctx, { driver })).toEqual(before);
	});

	test('uses the singleton migration gate as an exact immutable import precondition', async () => {
		const base = { driver, now: NOW };
		expect(await owner.publishMigrationQuarantine({ updatedAt: NOW }, base))
			.toMatchObject({ ok: true, changed: true, reason: 'quarantined' });
		expect(await owner.bindMigrationSnapshot({ snapshotHash: HASH, updatedAt: NOW }, base))
			.toMatchObject({ ok: true, changed: true, reason: 'bound' });

		const ctx = { repo: 'acme/forge', pr: 46 };
		const changed = await owner.importLegacyComplete(ctx, {
			snapshotHash: OTHER_HASH, legacyEvidenceHash: HASH, terminalReceiptId: 'legacy-receipt', startedAt: NOW,
		}, { ...base, verifyTerminalReceipt: async () => true });
		expect(changed).toMatchObject({ ok: false, changed: false, reason: 'gate_mismatch' });
		const imported = await owner.importLegacyComplete(ctx, {
			snapshotHash: HASH, legacyEvidenceHash: HASH, terminalReceiptId: 'legacy-receipt', startedAt: NOW,
		}, { ...base, verifyTerminalReceipt: async () => true });
		expect(imported).toMatchObject({ ok: true, changed: true, reason: 'imported', record: { phase: 'complete' } });
		const replay = await owner.importLegacyComplete(ctx, {
			snapshotHash: HASH, legacyEvidenceHash: HASH, terminalReceiptId: 'legacy-receipt', startedAt: NOW,
		}, { ...base, verifyTerminalReceipt: async () => true });
		expect(replay).toMatchObject({ ok: true, changed: false, reason: 'idempotent' });
		expect(await owner.completeMigrationGate({ snapshotHash: HASH, updatedAt: LATER }, base))
			.toMatchObject({ ok: true, changed: true, reason: 'complete' });
	});

	test('imports one dead-open legacy starting row idempotently and preserves provenance', async () => {
		const ctx = { repo: 'acme/forge', pr: 63 };
		const base = { driver, now: NOW };
		await owner.publishMigrationQuarantine({ updatedAt: NOW }, base);
		await owner.bindMigrationSnapshot({ snapshotHash: HASH, updatedAt: NOW }, base);
		let callbackReads = 0;
		const outsideRead = async () => {
			const gate = await owner.readMigrationGate({}, { driver });
			expect(gate).toMatchObject({ ok: true, gate: { state: 'quarantined', snapshot_hash: HASH } });
			callbackReads += 1;
		};
		const input = {
			snapshotHash: HASH, legacyEvidenceHash: OTHER_HASH, legacyPid: 263,
			controllerPid: 163, providerEvidence: { state: 'OPEN' }, startedAt: NOW,
		};
		const options = {
			...base,
			isPidAlive: async () => { await outsideRead(); return false; },
			verifyProviderEvidence: async () => { await outsideRead(); return true; },
		};
		const imported = await owner.importLegacyStarting(ctx, input, options);
		expect(imported).toMatchObject({ ok: true, changed: true, reason: 'imported', record: {
			phase: 'starting', controllerPid: 163, legacyEvidenceHash: OTHER_HASH,
		} });
		expect(imported.record.generation).toMatch(/^[0-9a-f-]{36}$/);
		const replay = await owner.importLegacyStarting(ctx, input, options);
		expect(replay).toEqual({ ok: true, changed: false, reason: 'idempotent', record: imported.record });
		expect(callbackReads).toBe(4);

		const recoveredStart = await owner.recoverDeadStarting(ctx, {
			generation: imported.record.generation, controllerPid: 163,
			recoveryControllerPid: 164, updatedAt: LATER,
		}, { ...base, isPidAlive: () => false });
		expect(recoveredStart).toMatchObject({ ok: true, record: { legacyEvidenceHash: OTHER_HASH } });
		const running = await owner.bindRunning(ctx, {
			generation: recoveredStart.record.generation, controllerPid: 164, pid: 264, updatedAt: LATER,
		}, base);
		expect(running).toMatchObject({ ok: true, record: { phase: 'running', legacyEvidenceHash: OTHER_HASH } });
		const recoveredWatcher = await owner.recoverDeadWatcher(ctx, {
			generation: running.record.generation, pid: 264, recoveryControllerPid: 165,
			providerEvidence: { state: 'OPEN' }, updatedAt: NEXT,
		}, { ...base, isPidAlive: () => false, verifyProviderEvidence: async () => true });
		expect(recoveredWatcher).toMatchObject({ ok: true, record: { phase: 'starting', legacyEvidenceHash: OTHER_HASH } });
		const rebound = await owner.bindRunning(ctx, {
			generation: recoveredWatcher.record.generation, controllerPid: 165, pid: 265, updatedAt: NEXT,
		}, base);
		const stopping = await owner.requestStop(ctx, {
			generation: rebound.record.generation, pid: 265, updatedAt: NEXT,
		}, base);
		expect(stopping).toMatchObject({ ok: true, record: { legacyEvidenceHash: OTHER_HASH } });
		const terminal = await owner.recordTerminal(ctx, {
			generation: rebound.record.generation, pid: 265, terminalReceiptId: 'receipt-63', updatedAt: NEXT,
		}, { ...base, verifyTerminalReceipt: async () => true });
		const completed = await owner.completeTerminal(ctx, {
			generation: rebound.record.generation, pid: 265, terminalReceiptId: 'receipt-63', updatedAt: NEXT,
		}, { ...base, isPidAlive: () => false });
		expect(terminal).toMatchObject({ ok: true, record: { legacyEvidenceHash: OTHER_HASH } });
		expect(completed).toMatchObject({ ok: true, record: { legacyEvidenceHash: OTHER_HASH } });
		const reopened = await owner.reserveReopened(ctx, {
			generation: completed.record.generation, controllerPid: 166, expectedReceiptId: 'receipt-63',
			providerEvidence: { state: 'OPEN' }, startedAt: NEXT,
		}, { ...base, verifyProviderEvidence: async () => true });
		expect(reopened).toMatchObject({ ok: true, record: { phase: 'starting', legacyEvidenceHash: OTHER_HASH } });
	});

	test('fails legacy starting import closed on gate, hash, PID, provider, conflict, and evidence races', async () => {
		const baseInput = {
			snapshotHash: HASH, legacyEvidenceHash: OTHER_HASH, legacyPid: 266,
			controllerPid: 166, providerEvidence: { state: 'OPEN' }, startedAt: NOW,
		};
		let checks = 0;
		const evidence = {
			driver,
			isPidAlive: () => { checks += 1; return false; },
			verifyProviderEvidence: async () => { checks += 1; return true; },
		};
		expect(await owner.importLegacyStarting({ repo: 'acme/forge', pr: 64 }, baseInput, evidence))
			.toMatchObject({ ok: false, changed: false, reason: 'gate_mismatch' });
		expect(checks).toBe(0);
		await owner.publishMigrationQuarantine({ updatedAt: NOW }, { driver });
		await owner.bindMigrationSnapshot({ snapshotHash: HASH, updatedAt: NOW }, { driver });
		expect(await owner.importLegacyStarting({ repo: 'acme/forge', pr: 64 }, {
			...baseInput, snapshotHash: 'bad',
		}, evidence)).toMatchObject({ ok: false, changed: false, reason: 'invalid_legacy_evidence' });
		expect(await owner.importLegacyStarting({ repo: 'acme/forge', pr: 64 }, {
			...baseInput, legacyPid: '266',
		}, evidence)).toMatchObject({ ok: false, changed: false, reason: 'invalid_legacy_evidence' });
		expect(await owner.importLegacyStarting({ repo: 'acme/forge', pr: 64 }, baseInput, {
			...evidence, isPidAlive: () => true,
		})).toMatchObject({ ok: false, changed: false, reason: 'pid_live' });
		expect(await owner.importLegacyStarting({ repo: 'acme/forge', pr: 64 }, baseInput, {
			...evidence, verifyProviderEvidence: async () => false,
		})).toMatchObject({ ok: false, changed: false, reason: 'provider_evidence_invalid' });

		const conflictCtx = { repo: 'acme/forge', pr: 65 };
		await owner.reserveStarting(conflictCtx, { controllerPid: 999, startedAt: NOW }, { driver });
		expect(await owner.importLegacyStarting(conflictCtx, baseInput, evidence))
			.toMatchObject({ ok: false, changed: false, reason: 'owner_conflict' });
		const ownerRaceCtx = { repo: 'acme/forge', pr: 66 };
		expect(await owner.importLegacyStarting(ownerRaceCtx, baseInput, {
			...evidence,
			verifyProviderEvidence: async () => {
				await owner.reserveStarting(ownerRaceCtx, { controllerPid: 998, startedAt: NOW }, { driver });
				return true;
			},
		})).toMatchObject({ ok: false, changed: false, reason: 'stale_evidence' });
		expect(await owner.readOwner(ownerRaceCtx, { driver }))
			.toMatchObject({ ok: true, record: { controllerPid: 998, legacyEvidenceHash: null } });
		const gateRaceCtx = { repo: 'acme/forge', pr: 67 };
		expect(await owner.importLegacyStarting(gateRaceCtx, baseInput, {
			...evidence,
			verifyProviderEvidence: async () => {
				await owner.completeMigrationGate({ snapshotHash: HASH, updatedAt: LATER }, { driver });
				return true;
			},
		})).toMatchObject({ ok: false, changed: false, reason: 'gate_mismatch' });
		expect(await owner.readOwner(gateRaceCtx, { driver })).toMatchObject({ ok: true, reason: 'absent' });
		await driver.exec(`UPDATE kernel_pr_watch_migration_gate
			SET state = 'conflict', conflict_code = 'legacy_owner_conflict'`);
		expect(await owner.importLegacyStarting({ repo: 'acme/forge', pr: 68 }, baseInput, evidence))
			.toMatchObject({ ok: false, changed: false, reason: 'gate_mismatch' });
		expect(await driver.queryAll('SELECT pr FROM kernel_pr_watch_owners ORDER BY pr'))
			.toEqual([{ pr: 65 }, { pr: 66 }]);
	});

	test('reads every migration gate state without creating or mutating authority', async () => {
		const unchangedRead = async expected => {
			const before = await driver.queryAll('SELECT * FROM kernel_pr_watch_migration_gate');
			const result = await owner.readMigrationGate({}, { driver });
			expect(result).toMatchObject(expected);
			expect(await driver.queryAll('SELECT * FROM kernel_pr_watch_migration_gate')).toEqual(before);
		};
		await unchangedRead({ ok: false, changed: false, reason: 'absent', gate: null });
		await driver.exec(`INSERT INTO kernel_pr_watch_migration_gate
			(singleton, state, snapshot_hash, conflict_code, updated_at)
			VALUES (1, 'unknown', NULL, NULL, '${NOW}')`);
		await unchangedRead({ ok: false, changed: false, reason: 'corrupt' });
		await driver.exec('DELETE FROM kernel_pr_watch_migration_gate');
		await owner.publishMigrationQuarantine({ updatedAt: NOW }, { driver });
		await unchangedRead({ ok: true, changed: false, reason: 'read', gate: {
			state: 'quarantined', snapshot_hash: null, conflict_code: null,
		} });
		await owner.bindMigrationSnapshot({ snapshotHash: HASH, updatedAt: NOW }, { driver });
		await unchangedRead({ ok: true, changed: false, reason: 'read', gate: {
			state: 'quarantined', snapshot_hash: HASH, conflict_code: null,
		} });
		await driver.exec(`UPDATE kernel_pr_watch_migration_gate
			SET state = 'conflict', conflict_code = 'legacy_owner_conflict'`);
		await unchangedRead({ ok: true, changed: false, reason: 'read', gate: {
			state: 'conflict', snapshot_hash: HASH, conflict_code: 'legacy_owner_conflict',
		} });
		await driver.exec("UPDATE kernel_pr_watch_migration_gate SET state = 'complete', conflict_code = NULL");
		await unchangedRead({ ok: true, changed: false, reason: 'read', gate: {
			state: 'complete', snapshot_hash: HASH, conflict_code: null,
		} });
		expect(await owner.readMigrationGate({}, {}))
			.toEqual({ ok: false, changed: false, reason: 'authority_unavailable', gate: null });
	});

	test('returns gate-shaped envelopes for every gate input validation failure', async () => {
		expect(await owner.publishMigrationQuarantine({ updatedAt: INVALID_TIMESTAMP }, { driver }))
			.toEqual({ ok: false, changed: false, reason: 'invalid_input', gate: null });
		expect(await owner.bindMigrationSnapshot({ snapshotHash: 'bad', updatedAt: NOW }, { driver }))
			.toEqual({ ok: false, changed: false, reason: 'invalid_snapshot', gate: null });
		expect(await owner.publishMigrationConflict({
			snapshotHash: HASH, conflictCode: 'bad', updatedAt: NOW,
		}, { driver })).toEqual({ ok: false, changed: false, reason: 'invalid_conflict', gate: null });
		expect(await owner.retryMigrationConflict({
			expectedSnapshotHash: HASH, expectedConflictCode: 'legacy_owner_conflict',
			replacementSnapshotHash: HASH, updatedAt: NOW,
		}, { driver })).toEqual({ ok: false, changed: false, reason: 'invalid_retry', gate: null });
		expect(await owner.completeMigrationGate({ snapshotHash: 'bad', updatedAt: NOW }, { driver }))
			.toEqual({ ok: false, changed: false, reason: 'invalid_snapshot', gate: null });
		expect(await driver.queryAll('SELECT * FROM kernel_pr_watch_migration_gate')).toEqual([]);
	});

	test('retries a resolved migration conflict through an exact evidence fence', async () => {
		await owner.publishMigrationQuarantine({ updatedAt: NOW }, { driver });
		await owner.publishMigrationConflict({
			snapshotHash: HASH, conflictCode: 'legacy_owner_conflict', updatedAt: NOW,
		}, { driver });
		const before = await driver.queryAll('SELECT * FROM kernel_pr_watch_migration_gate');
		expect(await owner.retryMigrationConflict({
			expectedSnapshotHash: OTHER_HASH, expectedConflictCode: 'legacy_owner_conflict',
			replacementSnapshotHash: 'c'.repeat(64), updatedAt: LATER,
		}, { driver })).toMatchObject({ ok: false, changed: false, reason: 'conflict_mismatch' });
		expect(await driver.queryAll('SELECT * FROM kernel_pr_watch_migration_gate')).toEqual(before);

		expect(await owner.retryMigrationConflict({
			expectedSnapshotHash: HASH, expectedConflictCode: 'legacy_owner_conflict',
			replacementSnapshotHash: OTHER_HASH, updatedAt: LATER,
		}, { driver })).toMatchObject({ ok: true, changed: true, reason: 'retry_bound', gate: {
			state: 'quarantined', snapshot_hash: OTHER_HASH, conflict_code: null,
		} });
		expect(await owner.completeMigrationGate({ snapshotHash: OTHER_HASH, updatedAt: NEXT }, { driver }))
			.toMatchObject({ ok: true, changed: true, reason: 'complete', gate: { state: 'complete' } });
		expect(await owner.retryMigrationConflict({
			expectedSnapshotHash: HASH, expectedConflictCode: 'legacy_owner_conflict',
			replacementSnapshotHash: OTHER_HASH, updatedAt: NEXT,
		}, { driver })).toMatchObject({ ok: false, changed: false, reason: 'phase_mismatch' });
	});

	test.each([
		['array', value => [value]],
		['boxed string', value => new String(value)],
		['buffer', value => Buffer.from(value)],
	])('rejects %s hashes before calling public API drivers or accepting records', async (_label, wrap) => {
		let driverCalls = 0;
		const rejectingDriver = new Proxy({}, {
			get(_target, property) {
				if (typeof property !== 'string' || !property.startsWith('watch')) return undefined;
				return () => {
					driverCalls += 1;
					return { ok: false, changed: false, reason: 'unexpected_driver_call', row: null, gate: null };
				};
			},
		});
		const opts = { driver: rejectingDriver, now: NOW };
		const snapshotHash = wrap(HASH);
		const legacyEvidenceHash = wrap(OTHER_HASH);
		const ctx = { repo: 'acme/forge', pr: 65 };
		const outcomes = [
			await owner.bindMigrationSnapshot({ snapshotHash, updatedAt: NOW }, opts),
			await owner.publishMigrationConflict({
				snapshotHash, conflictCode: 'legacy_owner_conflict', updatedAt: NOW,
			}, opts),
			await owner.completeMigrationGate({ snapshotHash, updatedAt: NOW }, opts),
			await owner.markLegacyBlocked(ctx, {
				blockReason: 'legacy_lossy', snapshotHash, legacyEvidenceHash: OTHER_HASH, startedAt: NOW,
			}, opts),
			await owner.markLegacyBlocked(ctx, {
				blockReason: 'legacy_lossy', snapshotHash: HASH, legacyEvidenceHash, startedAt: NOW,
			}, opts),
			await owner.recheckLegacyBlocked(ctx, {
				generation: 'generation-65', action: 'release', legacyEvidenceHash, updatedAt: NOW,
			}, opts),
			await owner.importLegacyComplete(ctx, {
				snapshotHash, legacyEvidenceHash: OTHER_HASH, terminalReceiptId: 'receipt-65', startedAt: NOW,
			}, opts),
			await owner.importLegacyComplete(ctx, {
				snapshotHash: HASH, legacyEvidenceHash, terminalReceiptId: 'receipt-65', startedAt: NOW,
			}, opts),
			await owner.importLegacyStarting(ctx, {
				snapshotHash, legacyEvidenceHash: OTHER_HASH, legacyPid: 65, controllerPid: 165,
				providerEvidence: { state: 'OPEN' }, startedAt: NOW,
			}, opts),
			await owner.importLegacyStarting(ctx, {
				snapshotHash: HASH, legacyEvidenceHash, legacyPid: 65, controllerPid: 165,
				providerEvidence: { state: 'OPEN' }, startedAt: NOW,
			}, opts),
		];

		expect(outcomes.map(result => result.reason)).toEqual([
			'invalid_snapshot', 'invalid_conflict', 'invalid_snapshot',
			'invalid_legacy_evidence', 'invalid_legacy_evidence', 'invalid_legacy_evidence',
			'invalid_legacy_evidence', 'invalid_legacy_evidence',
			'invalid_legacy_evidence', 'invalid_legacy_evidence',
		]);
		expect(driverCalls).toBe(0);
		expect(owner.validateRecord({
			repo: 'acme/forge', pr: 65, version: 1, generation: 'generation-65', phase: 'complete',
			controllerPid: null, watcherPid: null, startedAt: NOW, updatedAt: NOW, heartbeatAt: null,
			terminalReceiptId: 'receipt-65', blockReason: null, legacyEvidenceHash,
		})).toBe('invalid_evidence');
	});

	test('imports and evidence-rechecks blocked legacy rows with exact hash and PID fencing', async () => {
		const base = { driver, now: NOW };
		await owner.publishMigrationQuarantine({ updatedAt: NOW }, base);
		await owner.bindMigrationSnapshot({ snapshotHash: HASH, updatedAt: NOW }, base);
		const liveCtx = { repo: 'acme/forge', pr: 54 };
		const blocked = await owner.markLegacyBlocked(liveCtx, {
			blockReason: 'legacy_live_pid', pid: 500, snapshotHash: HASH,
			legacyEvidenceHash: OTHER_HASH, startedAt: NOW,
		}, { ...base, isPidAlive: () => true });
		expect(blocked).toMatchObject({ ok: true, changed: true, reason: 'blocked', record: { watcherPid: 500 } });
		expect(await owner.recheckLegacyBlocked(liveCtx, {
			generation: blocked.record.generation, pid: 501, action: 'release',
			legacyEvidenceHash: OTHER_HASH, updatedAt: LATER,
		}, { ...base, isPidAlive: () => false })).toMatchObject({ ok: false, reason: 'pid_mismatch' });
		expect(await owner.recheckLegacyBlocked(liveCtx, {
			generation: blocked.record.generation, pid: 500, action: 'release',
			legacyEvidenceHash: OTHER_HASH, updatedAt: LATER,
		}, { ...base, isPidAlive: () => false })).toEqual({ ok: true, changed: true, reason: 'released', record: null });

		const receiptCtx = { repo: 'acme/forge', pr: 55 };
		const receiptBlocked = await owner.markLegacyBlocked(receiptCtx, {
			blockReason: 'legacy_receipt_unverified', terminalReceiptId: 'receipt-55',
			snapshotHash: HASH, legacyEvidenceHash: OTHER_HASH, startedAt: NOW,
		}, base);
		const completed = await owner.recheckLegacyBlocked(receiptCtx, {
			generation: receiptBlocked.record.generation, action: 'complete',
			legacyEvidenceHash: OTHER_HASH, terminalReceiptId: 'receipt-55', updatedAt: LATER,
		}, { ...base, verifyTerminalReceipt: async () => true });
		expect(completed).toMatchObject({ ok: true, changed: true, reason: 'complete', record: { phase: 'complete' } });

		const liveCompleteCtx = { repo: 'acme/forge', pr: 58 };
		const liveComplete = await owner.markLegacyBlocked(liveCompleteCtx, {
			blockReason: 'legacy_live_pid', pid: 508, terminalReceiptId: 'receipt-58',
			snapshotHash: HASH, legacyEvidenceHash: OTHER_HASH, startedAt: NOW,
		}, { ...base, isPidAlive: () => true });
		const completedLive = await owner.recheckLegacyBlocked(liveCompleteCtx, {
			generation: liveComplete.record.generation, pid: 508, action: 'complete',
			legacyEvidenceHash: OTHER_HASH, terminalReceiptId: 'receipt-58', updatedAt: LATER,
		}, { ...base, isPidAlive: () => false, verifyTerminalReceipt: async () => true });
		expect(completedLive).toMatchObject({
			ok: true, changed: true, reason: 'complete',
			record: { phase: 'complete', watcherPid: null, terminalReceiptId: 'receipt-58' },
		});
	});

	test.each([
		'legacy_conflict',
		'legacy_unreadable',
		'legacy_lossy',
		'legacy_receipt_unverified',
	])('does not release a %s blocked row without reason-specific evidence', async blockReason => {
		const ctx = { repo: 'acme/forge', pr: 59 };
		const base = { driver, now: NOW };
		await owner.publishMigrationQuarantine({ updatedAt: NOW }, base);
		await owner.bindMigrationSnapshot({ snapshotHash: HASH, updatedAt: NOW }, base);
		const blocked = await owner.markLegacyBlocked(ctx, {
			blockReason, snapshotHash: HASH, legacyEvidenceHash: OTHER_HASH, startedAt: NOW,
			...(blockReason === 'legacy_receipt_unverified' ? { terminalReceiptId: 'receipt-59' } : {}),
		}, base);
		const before = await owner.readOwner(ctx, { driver });

		const result = await owner.recheckLegacyBlocked(ctx, {
			generation: blocked.record.generation, action: 'release',
			legacyEvidenceHash: OTHER_HASH, updatedAt: LATER,
		}, base);

		expect(result).toMatchObject({ ok: false, changed: false, reason: 'invalid_transition' });
		expect(await owner.readOwner(ctx, { driver })).toEqual(before);
	});

	test('requires the exact stored legacy-live PID before liveness verification or deletion', async () => {
		const ctx = { repo: 'acme/forge', pr: 62 };
		const base = { driver, now: NOW };
		await owner.publishMigrationQuarantine({ updatedAt: NOW }, base);
		await owner.bindMigrationSnapshot({ snapshotHash: HASH, updatedAt: NOW }, base);
		const blocked = await owner.markLegacyBlocked(ctx, {
			blockReason: 'legacy_live_pid', pid: 562, snapshotHash: HASH,
			legacyEvidenceHash: OTHER_HASH, startedAt: NOW,
		}, { ...base, isPidAlive: () => true });
		let checkedPids = [];
		const liveness = pid => { checkedPids.push(pid); return true; };
		const attempt = pid => owner.recheckLegacyBlocked(ctx, {
			generation: blocked.record.generation, ...(pid === undefined ? {} : { pid }),
			action: 'release', legacyEvidenceHash: OTHER_HASH, updatedAt: LATER,
		}, { ...base, isPidAlive: liveness });

		expect(await attempt()).toMatchObject({ ok: false, changed: false, reason: 'pid_mismatch' });
		expect(checkedPids).toEqual([]);
		expect(await attempt(999)).toMatchObject({ ok: false, changed: false, reason: 'pid_mismatch' });
		expect(checkedPids).toEqual([]);
		expect(await attempt(562)).toMatchObject({ ok: false, changed: false, reason: 'pid_live' });
		expect(checkedPids).toEqual([562]);
		expect(await driver.queryAll('SELECT pr FROM kernel_pr_watch_owners WHERE pr = 62')).toEqual([{ pr: 62 }]);
	});

	test('publishes a bounded tagged migration conflict without fabricating an owner row', async () => {
		const base = { driver, now: NOW };
		await owner.publishMigrationQuarantine({ updatedAt: NOW }, base);
		const conflict = await owner.publishMigrationConflict({
			snapshotHash: HASH, conflictCode: 'legacy_identity_unmappable', updatedAt: LATER,
		}, base);
		expect(conflict).toMatchObject({ ok: true, changed: true, reason: 'conflict', gate: {
			state: 'conflict', snapshot_hash: HASH, conflict_code: 'legacy_identity_unmappable',
		} });
		expect(await owner.publishMigrationConflict({
			snapshotHash: HASH, conflictCode: 'legacy_identity_unmappable', updatedAt: LATER,
		}, base)).toMatchObject({ ok: true, changed: false, reason: 'idempotent', gate: {
			state: 'conflict', snapshot_hash: HASH,
		} });
		expect(await driver.queryAll('SELECT count(*) AS count FROM kernel_pr_watch_owners')).toEqual([{ count: 0 }]);
	});

	test('never replaces a bound migration snapshot while publishing conflict', async () => {
		const base = { driver, now: NOW };
		await owner.publishMigrationQuarantine({ updatedAt: NOW }, base);
		await owner.bindMigrationSnapshot({ snapshotHash: HASH, updatedAt: NOW }, base);
		const conflict = await owner.publishMigrationConflict({
			snapshotHash: OTHER_HASH, conflictCode: 'legacy_snapshot_changed', updatedAt: LATER,
		}, base);
		expect(conflict).toMatchObject({ ok: false, changed: false, reason: 'snapshot_mismatch', gate: {
			state: 'quarantined', snapshot_hash: HASH, conflict_code: null,
		} });
		expect(await driver.queryAll('SELECT state, snapshot_hash, conflict_code FROM kernel_pr_watch_migration_gate'))
			.toEqual([{ state: 'quarantined', snapshot_hash: HASH, conflict_code: null }]);
	});

	test('caps deterministic owner enumeration at 4096 rows', async () => {
		const statements = ['BEGIN;'];
		for (let index = 0; index < 4_097; index += 1) {
			statements.push(`INSERT INTO kernel_pr_watch_owners
				(repo, pr, version, generation, phase, controller_pid, watcher_pid, started_at, updated_at)
				VALUES ('acme/forge', ${1_000 + index}, 1, 'g-${index}', 'starting', 1, NULL, '${NOW}', '${NOW}');`);
		}
		statements.push('COMMIT;');
		await driver.exec(statements.join('\n'));
		expect(await owner.enumerateOwners(null, { driver }))
			.toEqual({ ok: false, changed: false, reason: 'enumeration_overflow', records: [] });
	}, 20_000);

	test('fails closed for missing, memory, unsafe, uninitialized, and corrupt authority', async () => {
		const missingPath = path.join(root, 'missing', 'forge', 'kernel.sqlite');
		const missing = createBuiltinSQLiteDriver({ databasePath: missingPath });
		const result = await owner.reserveStarting({ repo: 'acme/forge', pr: 47 }, {
			controllerPid: 107, startedAt: NOW,
		}, { driver: missing });
		expect(result).toEqual({ ok: false, changed: false, reason: 'authority_unavailable', record: null });
		expect(await owner.readMigrationGate({}, { driver: missing }))
			.toEqual({ ok: false, changed: false, reason: 'authority_unavailable', gate: null });
		expect(fs.existsSync(missingPath)).toBe(false);
		missing.close();

		const memory = createBuiltinSQLiteDriver({ databasePath: ':memory:' });
		expect(await owner.reserveStarting({ repo: 'acme/forge', pr: 48 }, {
			controllerPid: 108, startedAt: NOW,
		}, { driver: memory })).toMatchObject({ ok: false, reason: 'authority_unavailable' });
		memory.close();

		const unsafePath = path.join(root, 'not-kernel.sqlite');
		const unsafe = createBuiltinSQLiteDriver({ databasePath: unsafePath });
		await unsafe.exec('CREATE TABLE placeholder (id INTEGER);');
		expect(await owner.reserveStarting({ repo: 'acme/forge', pr: 49 }, {
			controllerPid: 109, startedAt: NOW,
		}, { driver: unsafe })).toMatchObject({ ok: false, reason: 'authority_unavailable' });
		unsafe.close();

		await driver.exec(`INSERT INTO kernel_pr_watch_owners
			(repo, pr, version, generation, phase, controller_pid, watcher_pid, started_at, updated_at)
			VALUES ('acme/forge', 50, 2, 'bad', 'starting', 1, NULL, '${NOW}', '${NOW}')`);
		expect(await owner.readOwner({ repo: 'acme/forge', pr: 50 }, { driver }))
			.toMatchObject({ ok: false, changed: false, reason: 'corrupt' });
		expect(await owner.enumerateOwners(null, { driver }))
			.toEqual({ ok: false, changed: false, reason: 'corrupt', records: [] });
	});

	test('bounds identity, generation, receipt, evidence, and migration PID inputs before SQLite', async () => {
		const longRepo = `${'a'.repeat(251)}/forge`;
		expect(await owner.reserveStarting({ repo: longRepo, pr: 51 }, { controllerPid: 1, startedAt: NOW }, { driver }))
			.toMatchObject({ ok: false, reason: 'invalid_reservation' });
		expect(await owner.bindRunning({ repo: 'acme/forge', pr: 51 }, {
			generation: 'g'.repeat(129), controllerPid: 1, pid: 2, updatedAt: NOW,
		}, { driver })).toMatchObject({ ok: false });
		expect(await owner.importLegacyComplete({ repo: 'acme/forge', pr: 51 }, {
			snapshotHash: HASH, legacyEvidenceHash: HASH, legacyPid: 0,
			terminalReceiptId: 'r', startedAt: NOW,
		}, { driver, verifyTerminalReceipt: async () => true })).toMatchObject({ ok: false, reason: 'invalid_legacy_evidence' });
		expect(await owner.publishMigrationConflict({
			snapshotHash: HASH, conflictCode: 'not-a-code', updatedAt: NOW,
		}, { driver })).toMatchObject({ ok: false, reason: 'invalid_conflict' });
	});

	test('rejects boolean and string coercion for every numeric owner identity input', async () => {
		let pr = 80;
		for (const coerced of [true, '1']) {
			expect(await owner.reserveStarting({ repo: 'acme/forge', pr: coerced }, {
				controllerPid: 180, startedAt: NOW,
			}, { driver }), `pr=${String(coerced)}`)
				.toMatchObject({ ok: false, changed: false, reason: 'invalid_reservation' });
			expect(await owner.reserveStarting({ repo: 'acme/forge', pr }, {
				controllerPid: coerced, startedAt: NOW,
			}, { driver }), `controller=${String(coerced)}`)
				.toMatchObject({ ok: false, changed: false, reason: 'invalid_reservation' });
			const ctx = { repo: 'acme/forge', pr: pr + 10 };
			const start = await owner.reserveStarting(ctx, { controllerPid: 280, startedAt: NOW }, { driver });
			expect(await owner.bindRunning(ctx, {
				generation: start.record.generation, controllerPid: 280, pid: coerced, updatedAt: LATER,
			}, { driver }), `watcher=${String(coerced)}`)
				.toMatchObject({ ok: false, changed: false, reason: 'invalid_pid' });
			expect(await owner.readOwner(ctx, { driver })).toMatchObject({ ok: true, record: { phase: 'starting' } });
			pr += 1;
		}
		expect(await driver.queryAll('SELECT pr FROM kernel_pr_watch_owners WHERE pr IN (1, 80, 81)')).toEqual([]);
	});
});
