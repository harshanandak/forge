'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { afterEach, describe, expect, test } = require('bun:test');

const { createLocalBroker } = require('../../lib/kernel/broker');
const {
	createBuiltinSQLiteDriver,
	hardenBackupPermissions,
} = require('../../lib/kernel/sqlite-driver');
const {
	cleanupRestoreProofDirectory,
	createVerifiedClaimRepairBackup,
	verifyClaimRepairBackup,
} = require('../../lib/kernel/legacy-claim-repair');
const { parseArgs } = require('../../scripts/legacy-claim-repair');

const OBSERVED_AT = '2026-08-12T08:00:00.000Z';
const tempDirs = [];

async function removeDirWithRetry(dir, attempts = 10) {
	for (let attempt = 0; attempt < attempts; attempt += 1) {
		try {
			fs.rmSync(dir, { recursive: true, force: true });
			return;
		} catch (error) {
			const locked = ['EBUSY', 'EPERM', 'ENOTEMPTY'].includes(error.code);
			if (!locked) throw error;
			if (attempt === attempts - 1) return;
			await new Promise(resolve => setTimeout(resolve, 100));
		}
	}
}

afterEach(async () => {
	while (tempDirs.length > 0) await removeDirWithRetry(tempDirs.pop());
});

async function createFixture(driverOptions = {}) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-legacy-claim-repair-'));
	tempDirs.push(root);
	const databasePath = path.join(root, 'kernel.sqlite');
	const config = { databasePath };
	const driver = createBuiltinSQLiteDriver({ databasePath, ...driverOptions });
	const broker = createLocalBroker({
		projectRoot: root,
		execFileSync: () => path.join(root, '.git'),
		databasePath,
		driver,
	});
	await broker.initialize();

	async function issue(id, status = 'open') {
		const created = await broker.runIssueOperation(
			'create',
			['--id', id, '--title', `Issue ${id}`, '--type', 'task'],
			{ now: '2026-08-12T06:00:00.000Z', actor: 'fixture' },
		);
		expect(created.ok).toBe(true);
		if (status !== 'open') {
			await driver.exec(`UPDATE kernel_issues SET status = '${status}' WHERE id = '${id}';`, config);
		}
	}

	async function claim(id, issueId, overrides = {}) {
		await driver.insertKernelClaim({
			id,
			issue_id: issueId,
			actor: overrides.actor || `actor-${id}`,
			state: overrides.state || 'active',
			session_id: overrides.session_id ?? `session-${id}`,
			worktree_id: overrides.worktree_id ?? `worktree-${id}`,
			claimed_at: overrides.claimed_at || '2026-08-12T06:30:00.000Z',
			expires_at: Object.hasOwn(overrides, 'expires_at')
				? overrides.expires_at
				: '2026-08-12T09:00:00.000Z',
		}, {}, config);
	}

	return { root, databasePath, config, driver, broker, issue, claim };
}

async function seedMixedClaims(fixture) {
	await fixture.issue('terminal-expired', 'done');
	await fixture.claim('claim-terminal', 'terminal-expired', {
		actor: 'private-terminal-actor',
		expires_at: '2026-08-12T07:00:00.000Z',
	});
	await fixture.issue('expired-open');
	await fixture.claim('claim-expired', 'expired-open', {
		actor: 'private-expired-actor',
		expires_at: '2026-08-12T07:30:00.000Z',
	});
	await fixture.issue('durable-open');
	await fixture.claim('claim-durable', 'durable-open', { expires_at: null });
	await fixture.issue('future-open');
	await fixture.claim('claim-future', 'future-open');
}

describe('legacy claim repair preflight', () => {
	test('operator script requires an explicit mode, database, backup, and apply approval', () => {
		expect(() => parseArgs([])).toThrow('Choose exactly one');
		expect(() => parseArgs(['--dry-run'])).toThrow('Missing required option');
		expect(() => parseArgs([
			'--apply', '--database', 'kernel.sqlite', '--backup', 'backup.sqlite', '--at', OBSERVED_AT,
		])).toThrow('--apply requires --approved-digest');
		expect(() => parseArgs([
			'--apply', '--database', 'kernel.sqlite', '--backup', 'backup.sqlite', '--at', OBSERVED_AT,
			'--approved-digest', 'a'.repeat(64),
		])).toThrow('--apply requires --actor');
		expect(parseArgs([
			'--apply', '--database', 'kernel.sqlite', '--backup', 'backup.sqlite', '--at', OBSERVED_AT,
			'--approved-digest', 'a'.repeat(64), '--actor', 'operator@example.com',
		])).toMatchObject({ mode: 'apply', actor: 'operator@example.com' });
		expect(parseArgs([
			'--dry-run', '--database', 'kernel.sqlite', '--backup', 'backup.sqlite', '--at', OBSERVED_AT,
		])).toEqual({
			mode: 'dry-run',
			databasePath: 'kernel.sqlite',
			backupPath: 'backup.sqlite',
			observedAt: OBSERVED_AT,
		});
		expect(() => parseArgs([
			'--dry-run', '--database', 'kernel.sqlite', '--backup', 'backup.sqlite', '--at', OBSERVED_AT,
			'constructor', 'ignored',
		])).toThrow('Unknown argument: constructor');
	});

	test('hardens backup files to owner-only mode and fails closed when permissions remain broad', () => {
		const calls = [];
		hardenBackupPermissions('backup.sqlite', {
			platform: 'linux',
			fsApi: {
				chmodSync(filePath, mode) { calls.push({ filePath, mode }); },
				statSync() { return { mode: 0o100600 }; },
			},
		});
		expect(calls).toEqual([{ filePath: 'backup.sqlite', mode: 0o600 }]);
		expect(() => hardenBackupPermissions('backup.sqlite', {
			platform: 'linux',
			fsApi: {
				chmodSync() {},
				statSync() { return { mode: 0o100644 }; },
			},
		})).toThrow('owner-only permissions');
	});

	test('restore-proof cleanup retries Windows file locks without replacing valid proof', () => {
		let cleanupOptions;
		expect(() => cleanupRestoreProofDirectory('restore-proof', {
			rmSync(_directory, options) {
				cleanupOptions = options;
				const error = new Error('still locked');
				error.code = 'EBUSY';
				throw error;
			},
		})).not.toThrow();
		expect(cleanupOptions).toMatchObject({ recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
	});

	test('classifies terminal rows before expiry and emits deterministic privacy-safe counts', async () => {
		const fixture = await createFixture();
		await seedMixedClaims(fixture);

		const first = await fixture.driver.preflightLegacyClaimRepair({ observedAt: OBSERVED_AT }, fixture.config);
		const second = await fixture.driver.preflightLegacyClaimRepair({ observedAt: OBSERVED_AT }, fixture.config);

		expect(first).toEqual(second);
		expect(first).toMatchObject({
			schema_version: 'forge.claim-repair.preflight.v1',
			mode: 'dry-run',
			observed_at: OBSERVED_AT,
			counts: {
				active_claims: 4,
				terminal_active_to_release: 1,
				expired_nonterminal_to_reclaimable: 1,
				preserved_null_expiry_active: 1,
				preserved_unexpired_active: 1,
				planned_mutations: 2,
			},
		});
		expect(first.digest).toMatch(/^[0-9a-f]{64}$/);
		const serialized = JSON.stringify(first);
		for (const privateValue of [
			'claim-terminal', 'terminal-expired', 'private-terminal-actor',
			'claim-expired', 'expired-open', 'private-expired-actor',
		]) {
			expect(serialized).not.toContain(privateValue);
		}
		fixture.driver.close();
	});

	test('fails closed on invalid clocks, issue/claim states, timestamps, foreign keys, indexes, and duplicates', async () => {
		const invalidClock = await createFixture();
		await expect(invalidClock.driver.preflightLegacyClaimRepair(
			{ observedAt: '2026-08-12T08:00:00Z' }, invalidClock.config,
		)).rejects.toMatchObject({ code: 'CLAIM_REPAIR_INVALID_OBSERVED_AT' });
		invalidClock.driver.close();

		const invalidRows = await createFixture();
		await invalidRows.issue('invalid-row');
		await invalidRows.claim('invalid-claim', 'invalid-row');
		await invalidRows.driver.exec("UPDATE kernel_claims SET state = 'paused', expires_at = 'tomorrow' WHERE id = 'invalid-claim';", invalidRows.config);
		await invalidRows.driver.exec("UPDATE kernel_issues SET status = 'finished' WHERE id = 'invalid-row';", invalidRows.config);
		await expect(invalidRows.driver.preflightLegacyClaimRepair(
			{ observedAt: OBSERVED_AT }, invalidRows.config,
		)).rejects.toMatchObject({ code: 'CLAIM_REPAIR_PREFLIGHT_FAILED' });
		invalidRows.driver.close();

		const brokenAuthority = await createFixture();
		await brokenAuthority.issue('duplicate-target');
		await brokenAuthority.driver.exec('PRAGMA foreign_keys=OFF;', brokenAuthority.config);
		await brokenAuthority.driver.exec('DROP INDEX idx_kernel_claims_active_lease;', brokenAuthority.config);
		await brokenAuthority.claim('duplicate-a', 'duplicate-target');
		await brokenAuthority.claim('duplicate-b', 'duplicate-target');
		await brokenAuthority.claim('orphan', 'missing-issue');
		await expect(brokenAuthority.driver.preflightLegacyClaimRepair(
			{ observedAt: OBSERVED_AT }, brokenAuthority.config,
		)).rejects.toMatchObject({ code: 'CLAIM_REPAIR_PREFLIGHT_FAILED' });
		brokenAuthority.driver.close();
	});
});

describe('legacy claim repair backup and apply', () => {
	test('proves a separate SQLite backup can be restored to the exact approved snapshot', async () => {
		const fixture = await createFixture();
		await seedMixedClaims(fixture);
		const backupPath = path.join(fixture.root, 'backups', 'claims-before.sqlite');

		const proof = await createVerifiedClaimRepairBackup({
			sourceDriver: fixture.driver,
			backupPath,
			observedAt: OBSERVED_AT,
			openDriver: databasePath => createBuiltinSQLiteDriver({ databasePath }),
		});

		expect(fs.existsSync(backupPath)).toBe(true);
		expect(proof).toMatchObject({
			schema_version: 'forge.claim-repair.backup-proof.v1',
			integrity: 'ok',
		});
		expect(proof.backup_sha256).toMatch(/^[0-9a-f]{64}$/);
		expect(proof.plan_digest).toBe(proof.restore_digest);
		await expect(createVerifiedClaimRepairBackup({
			sourceDriver: fixture.driver,
			backupPath,
			observedAt: OBSERVED_AT,
			openDriver: databasePath => createBuiltinSQLiteDriver({ databasePath }),
		})).rejects.toMatchObject({ code: 'CLAIM_REPAIR_BACKUP_EXISTS' });
		const verifiedAgain = await verifyClaimRepairBackup({
			backupPath,
			observedAt: OBSERVED_AT,
			openDriver: databasePath => createBuiltinSQLiteDriver({ databasePath }),
		});
		expect(verifiedAgain).toEqual(proof);
		fixture.driver.close();
	});

	test('requires the approved digest, applies exact CAS updates, and replays idempotently', async () => {
		const fixture = await createFixture();
		await seedMixedClaims(fixture);
		const backupPath = path.join(fixture.root, 'claims-before.sqlite');
		const preflight = await fixture.driver.preflightLegacyClaimRepair({ observedAt: OBSERVED_AT }, fixture.config);
		await createVerifiedClaimRepairBackup({
			sourceDriver: fixture.driver,
			backupPath,
			observedAt: OBSERVED_AT,
			openDriver: databasePath => createBuiltinSQLiteDriver({ databasePath }),
		});
		await expect(fixture.driver.applyLegacyClaimRepair({
			observedAt: OBSERVED_AT,
			approvedDigest: preflight.digest,
			backupPath: fixture.databasePath,
			actor: 'approved-operator',
		}, fixture.config)).rejects.toThrow('must not alias');
		const hardlinkPath = path.join(fixture.root, 'kernel-hardlink.sqlite');
		fs.linkSync(fixture.databasePath, hardlinkPath);
		await expect(fixture.driver.applyLegacyClaimRepair({
			observedAt: OBSERVED_AT,
			approvedDigest: preflight.digest,
			backupPath: hardlinkPath,
			actor: 'approved-operator',
		}, fixture.config)).rejects.toThrow('must not alias');
		await expect(fixture.driver.applyLegacyClaimRepair({
			observedAt: OBSERVED_AT,
			approvedDigest: preflight.digest,
			backupProof: {
				schema_version: 'forge.claim-repair.backup-proof.v1',
				integrity: 'ok',
				plan_digest: preflight.digest,
				restore_digest: preflight.digest,
				backup_sha256: 'a'.repeat(64),
			},
			actor: 'approved-operator',
		}, fixture.config)).rejects.toMatchObject({ code: 'CLAIM_REPAIR_BACKUP_PROOF_REQUIRED' });

		const applied = await fixture.driver.applyLegacyClaimRepair({
			observedAt: OBSERVED_AT,
			approvedDigest: preflight.digest,
			backupPath,
			actor: 'approved-operator',
		}, fixture.config);
		expect(applied).toMatchObject({
			schema_version: 'forge.claim-repair.receipt.v1',
			approved_digest: preflight.digest,
			replayed: false,
			mutations: { released: 1, reclaimable: 1, total: 2 },
		});
		const rows = await fixture.driver.queryAll('SELECT id, state FROM kernel_claims ORDER BY id;', fixture.config);
		expect(rows).toEqual([
			{ id: 'claim-durable', state: 'active' },
			{ id: 'claim-expired', state: 'reclaimable' },
			{ id: 'claim-future', state: 'active' },
			{ id: 'claim-terminal', state: 'released' },
		]);
		// A lost-response retry must replay its durable receipt even after normal
		// claim authority changes the mutable snapshot.
		await fixture.issue('unrelated-after-repair');
		await fixture.claim('claim-after-repair', 'unrelated-after-repair');
		const replay = await fixture.driver.applyLegacyClaimRepair({
			observedAt: OBSERVED_AT,
			approvedDigest: preflight.digest,
			backupPath,
			actor: 'approved-operator',
		}, fixture.config);
		expect(replay).toEqual({ ...applied, replayed: true });
		const receipts = await fixture.driver.queryAll(
			"SELECT * FROM kernel_events WHERE event_type = 'claim.repair';",
			fixture.config,
		);
		expect(receipts).toHaveLength(1);
		expect(receipts[0].payload_json).not.toContain('claim-terminal');
		fixture.driver.close();
	});

	test('rejects drift from the approved snapshot without mutating rows', async () => {
		const fixture = await createFixture();
		await seedMixedClaims(fixture);
		const backupPath = path.join(fixture.root, 'claims-before.sqlite');
		const preflight = await fixture.driver.preflightLegacyClaimRepair({ observedAt: OBSERVED_AT }, fixture.config);
		await createVerifiedClaimRepairBackup({
			sourceDriver: fixture.driver,
			backupPath,
			observedAt: OBSERVED_AT,
			openDriver: databasePath => createBuiltinSQLiteDriver({ databasePath }),
		});
		await fixture.driver.exec("UPDATE kernel_claims SET actor = 'changed-after-approval' WHERE id = 'claim-expired';", fixture.config);

		await expect(fixture.driver.applyLegacyClaimRepair({
			observedAt: OBSERVED_AT,
			approvedDigest: preflight.digest,
			backupPath,
			actor: 'approved-operator',
		}, fixture.config)).rejects.toMatchObject({ code: 'CLAIM_REPAIR_DIGEST_DRIFT' });
		const states = await fixture.driver.queryAll('SELECT state FROM kernel_claims ORDER BY id;', fixture.config);
		expect(states.filter(row => row.state !== 'active')).toEqual([]);
		fixture.driver.close();
	});

	test('rolls back every state change when interrupted before the receipt commit', async () => {
		const fixture = await createFixture({
			claimRepairFaultInjector(phase) {
				if (phase === 'after-mutations') throw new Error('simulated interruption');
			},
		});
		await seedMixedClaims(fixture);
		const backupPath = path.join(fixture.root, 'claims-before.sqlite');
		const preflight = await fixture.driver.preflightLegacyClaimRepair({ observedAt: OBSERVED_AT }, fixture.config);
		await createVerifiedClaimRepairBackup({
			sourceDriver: fixture.driver,
			backupPath,
			observedAt: OBSERVED_AT,
			openDriver: databasePath => createBuiltinSQLiteDriver({ databasePath }),
		});

		await expect(fixture.driver.applyLegacyClaimRepair({
			observedAt: OBSERVED_AT,
			approvedDigest: preflight.digest,
			backupPath,
			actor: 'approved-operator',
		}, fixture.config)).rejects.toThrow('simulated interruption');
		const rows = await fixture.driver.queryAll('SELECT state FROM kernel_claims ORDER BY id;', fixture.config);
		expect(rows).toEqual([{ state: 'active' }, { state: 'active' }, { state: 'active' }, { state: 'active' }]);
		const receipts = await fixture.driver.queryAll(
			"SELECT * FROM kernel_events WHERE event_type = 'claim.repair';",
			fixture.config,
		);
		expect(receipts).toEqual([]);
		fixture.driver.close();
	});
});
