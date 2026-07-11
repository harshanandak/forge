const { describe, expect, test, beforeEach, afterEach } = require('bun:test');
const os = require('node:os');
const path = require('node:path');

const fs = require('node:fs');

const {
	CONFLICT_SIGNAL,
	classifyConflictSignal,
} = require('../../lib/kernel/conflict-signal');
const { createLocalBroker } = require('../../lib/kernel/broker');
const { createBuiltinSQLiteDriver } = require('../../lib/kernel/sqlite-driver');

// The typed conflict-signal refactor (issues 89bf8930 / d4ce47bb): the broker must
// branch on a driver-supplied TYPED signal, not on engine-specific error text. These
// tests assert the classification is produced by the typed classifier — the SINGLE
// place that owns SQLite error-dialect knowledge — so the broker never parses strings.

describe('classifyConflictSignal — typed classification (no string-matching in broker)', () => {
	test('exposes a frozen, stable enum of conflict codes', () => {
		expect(CONFLICT_SIGNAL).toEqual({
			CAS_STALE: 'CAS_STALE',
			UNIQUE_IDEMPOTENCY: 'UNIQUE_IDEMPOTENCY',
			UNIQUE_CLAIM_LEASE: 'UNIQUE_CLAIM_LEASE',
			BUSY: 'BUSY',
			LOCKED: 'LOCKED',
		});
		expect(Object.isFrozen(CONFLICT_SIGNAL)).toBe(true);
	});

	test('CAS lost-update: honors the driver-tagged structural marker', () => {
		const err = Object.assign(new Error('kernel issue revision conflict'), {
			kernelRevisionConflict: true,
			actualRevision: 3,
		});
		expect(classifyConflictSignal(err)).toBe(CONFLICT_SIGNAL.CAS_STALE);
	});

	test('CAS lost-update: honors a pre-tagged typed conflictSignal', () => {
		const err = Object.assign(new Error('anything'), {
			conflictSignal: CONFLICT_SIGNAL.CAS_STALE,
		});
		expect(classifyConflictSignal(err)).toBe(CONFLICT_SIGNAL.CAS_STALE);
	});

	test('idempotency UNIQUE violation → UNIQUE_IDEMPOTENCY', () => {
		const err = new Error('UNIQUE constraint failed: kernel_events.idempotency_key');
		expect(classifyConflictSignal(err)).toBe(CONFLICT_SIGNAL.UNIQUE_IDEMPOTENCY);
	});

	test('claim-lease partial UNIQUE violation → UNIQUE_CLAIM_LEASE', () => {
		const err = new Error('UNIQUE constraint failed: kernel_claims.issue_id');
		expect(classifyConflictSignal(err)).toBe(CONFLICT_SIGNAL.UNIQUE_CLAIM_LEASE);
	});

	test('a duplicate kernel_claims.id (PK) is NOT a lease conflict', () => {
		// The PK collision is a distinct bug; it must not be misclassified as a lease
		// conflict (preserves the isClaimLeaseConflict targeting semantics).
		const err = new Error('UNIQUE constraint failed: kernel_claims.id');
		expect(classifyConflictSignal(err)).toBeNull();
	});

	test('BUSY / LOCKED are recognized from code or message', () => {
		expect(classifyConflictSignal(Object.assign(new Error('x'), { code: 'SQLITE_BUSY' })))
			.toBe(CONFLICT_SIGNAL.BUSY);
		expect(classifyConflictSignal(new Error('database is locked')))
			.toBe(CONFLICT_SIGNAL.BUSY);
		expect(classifyConflictSignal(Object.assign(new Error('x'), { code: 'SQLITE_LOCKED' })))
			.toBe(CONFLICT_SIGNAL.LOCKED);
	});

	test('unrelated errors and nullish input classify as null', () => {
		expect(classifyConflictSignal(new Error('CHECK constraint failed: foo'))).toBeNull();
		expect(classifyConflictSignal(new Error('no such table: bar'))).toBeNull();
		expect(classifyConflictSignal(null)).toBeNull();
		expect(classifyConflictSignal(undefined)).toBeNull();
	});

	test('accepts a bare string error message', () => {
		expect(classifyConflictSignal('UNIQUE constraint failed: kernel_events.idempotency_key'))
			.toBe(CONFLICT_SIGNAL.UNIQUE_IDEMPOTENCY);
	});
});

// ---------------------------------------------------------------------------
// CI CONTRACT / INTEGRATION TEST (per d4ce47bb comment, 2026-07-09):
// Provoke REAL conflicts against the actually-deployed SQLite driver and assert
// the typed classifier recognizes them. This converts the standing "error text"
// assumption into a CI-enforced, backend-agnostic contract: if a future backend
// (libSQL/Turso/CF) emits a different error dialect, this fails at build time.
// ---------------------------------------------------------------------------

describe('real-backend conflict contract (CI-enforced)', () => {
	let tmpDir;
	let driver;
	let broker;
	let config;
	const now = '2026-07-10T00:00:00.000Z';

	beforeEach(async () => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'confsig-'));
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

	// Provoke a GENUINE partial-UNIQUE(active-lease) violation from the real driver
	// (two active claims on one issue_id) and assert BOTH the error dialect (the
	// substring the classifier keys on) AND that the typed classifier recognizes it.
	// If a future backend emits a different error dialect, this fails at build time.
	test('the deployed SQLite driver emits a claim-lease UNIQUE error the classifier recognizes', async () => {
		await broker.runIssueOperation(
			'create', ['--id', 'issue-cs', '--title', 'cs', '--type', 'task'],
			{ now, actor: 'tester' },
		);
		const baseClaim = {
			issue_id: 'issue-cs', actor: 'tester', state: 'active',
			claimed_at: now, expires_at: null,
		};
		await driver.insertKernelClaim({ ...baseClaim, id: 'claim-1' }, {}, config);

		let caught = null;
		try {
			await driver.insertKernelClaim({ ...baseClaim, id: 'claim-2' }, {}, config);
		} catch (err) {
			caught = err;
		}

		expect(caught).not.toBeNull();
		// Contract pin: the real error dialect still contains the substring we key on.
		expect(String(caught.message)).toContain('kernel_claims.issue_id');
		// Typed classification recognizes the real backend error.
		expect(classifyConflictSignal(caught)).toBe(CONFLICT_SIGNAL.UNIQUE_CLAIM_LEASE);
	});
});
