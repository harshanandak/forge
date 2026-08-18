'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { afterEach, describe, expect, test } = require('bun:test');

const { createLocalBroker } = require('../../lib/kernel/broker');
const {
	createBuiltinSQLiteDriver,
	hardenBackupPermissions,
	hardenBackupPermissionsBatch,
	resolveWindowsPowerShellPath,
	secureWindowsPathsAcl,
	syncClaimRepairRecoveryDirectory,
} = require('../../lib/kernel/sqlite-driver');
const {
	cleanupRestoreProofDirectory,
	createVerifiedClaimRepairBackup,
	prepareRestoreProofSnapshot,
	verifyClaimRepairBackup,
} = require('../../lib/kernel/legacy-claim-repair');
const { parseArgs, run } = require('../../scripts/legacy-claim-repair');

const OBSERVED_AT = '2026-08-12T08:00:00.000Z';
const tempDirs = [];
const hardenPath = filePath => hardenBackupPermissions(filePath);
hardenPath.batch = filePaths => hardenBackupPermissionsBatch(filePaths);

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

	async function issue(id, status = 'open', type = 'task') {
		const created = await broker.runIssueOperation(
			'create',
			['--id', id, '--title', `Issue ${id}`, '--type', type],
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
		const databasePath = path.resolve('kernel.sqlite');
		const backupPath = path.resolve('backup.sqlite');
		expect(parseArgs(['--help'])).toEqual({ help: true });
		expect(parseArgs(['-h'])).toEqual({ help: true });
		expect(() => parseArgs([])).toThrow('Choose exactly one');
		expect(() => parseArgs(['--dry-run', '--apply'])).toThrow('Choose exactly one');
		expect(() => parseArgs(['--unknown'])).toThrow('Unknown argument');
		expect(() => parseArgs(['--dry-run', '--database', '--backup'])).toThrow('--database requires a value');
		expect(() => parseArgs(['--dry-run'])).toThrow('Missing required option');
		expect(() => parseArgs([
			'--apply', '--database', 'kernel.sqlite', '--backup', 'backup.sqlite', '--at', OBSERVED_AT,
		])).toThrow('databasePath must be an absolute path');
		expect(() => parseArgs([
			'--apply', '--database', databasePath, '--backup', backupPath, '--at', OBSERVED_AT,
			'--approved-digest', 'a'.repeat(64),
		])).toThrow('--apply requires --actor');
		expect(parseArgs([
			'--apply', '--database', databasePath, '--backup', backupPath, '--at', OBSERVED_AT,
			'--approved-digest', 'a'.repeat(64), '--actor', 'operator@example.com',
		])).toMatchObject({ mode: 'apply', actor: 'operator@example.com' });
		expect(parseArgs([
			'--dry-run', '--database', databasePath, '--backup', backupPath, '--at', OBSERVED_AT,
		])).toEqual({
			mode: 'dry-run',
			databasePath,
			backupPath,
			observedAt: OBSERVED_AT,
		});
		expect(() => parseArgs([
			'--dry-run', '--database', databasePath, '--backup', backupPath, '--at', OBSERVED_AT,
			'--approved-digest', 'a'.repeat(64),
		])).toThrow('--approved-digest is valid only with --apply');
		expect(() => parseArgs([
			'--dry-run', '--database', databasePath, '--backup', backupPath, '--at', OBSERVED_AT,
			'constructor', 'ignored',
		])).toThrow('Unknown argument: constructor');
	});

	test('hardens backup files to owner-only mode and fails closed when permissions remain broad', () => {
		expect(resolveWindowsPowerShellPath({ SystemRoot: 'C:\\Windows' }))
			.toBe('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
		expect(() => resolveWindowsPowerShellPath({ SystemRoot: 'relative' })).toThrow('absolute SystemRoot');
		const calls = [];
		hardenBackupPermissions('backup.sqlite', {
			platform: 'linux',
			effectiveUserId: 1000,
			fsApi: {
				chmodSync(filePath, mode) { calls.push({ filePath, mode }); },
				statSync() { return { mode: 0o100600, uid: 1000 }; },
			},
		});
		expect(calls).toEqual([{ filePath: 'backup.sqlite', mode: 0o600 }]);
		const directoryCalls = [];
		hardenBackupPermissions('restore-dir', {
			platform: 'linux',
			effectiveUserId: 1000,
			fsApi: {
				chmodSync(filePath, mode) { directoryCalls.push({ filePath, mode }); },
				statSync() { return { mode: 0o040700, uid: 1000, isDirectory: () => true }; },
			},
		});
		expect(directoryCalls).toEqual([{ filePath: 'restore-dir', mode: 0o700 }]);
		expect(() => hardenBackupPermissions('backup.sqlite', {
			platform: 'linux',
			fsApi: {
				chmodSync() {},
				statSync() { return { mode: 0o100644 }; },
			},
		})).toThrow('owner-only permissions');
		const secured = [];
		hardenBackupPermissions('backup.sqlite', {
			platform: 'win32',
			aclSecurer(filePath) { secured.push(filePath); },
		});
		expect(secured).toEqual(['backup.sqlite']);
		expect(() => hardenBackupPermissions('backup.sqlite', {
			platform: 'win32',
			aclSecurer() { throw new Error('ACL remained inherited'); },
		})).toThrow('owner-only permissions');
	});

	test('batches Windows ACL hardening while preserving per-path failure handling', () => {
		const secured = [];
		hardenBackupPermissionsBatch(['backup.sqlite', 'restore.sqlite', 'backup.sqlite'], {
			platform: 'win32',
			aclSecurer(filePath) { secured.push(filePath); },
		});
		expect(secured).toEqual(['backup.sqlite', 'restore.sqlite']);
		expect(() => hardenBackupPermissionsBatch(['backup.sqlite'], {
			platform: 'win32',
			aclSecurer() { throw new Error('ACL remained inherited'); },
		})).toThrow('owner-only permissions');
	});

	test('runs Windows ACL hardening through the bounded native Bun process API', () => {
		let invocation;
		secureWindowsPathsAcl(['backup.sqlite'], {
			environment: { SystemRoot: 'C:\\Windows' },
			bunSpawnSync(command, options) {
				invocation = { command, options };
				return { success: true };
			},
		});
		expect(invocation.command).toEqual([
			'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
			'-NoLogo', '-NoProfile', '-NonInteractive', '-Command', expect.any(String),
		]);
		expect(invocation.command.at(-1)).not.toContain('{;');
		expect(invocation.options).toMatchObject({
			cwd: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0',
			stderr: 'pipe',
			stdout: 'pipe',
			timeout: 15_000,
			env: {
				FORGE_PRIVATE_ACL_TARGETS: '["backup.sqlite"]',
				SystemRoot: 'C:\\Windows',
			},
		});
	});

	test('fails closed when the native Bun ACL subprocess times out', () => {
		expect(() => secureWindowsPathsAcl(['backup.sqlite'], {
			environment: { SystemRoot: 'C:\\Windows' },
			bunSpawnSync() { return { success: false, exitedDueToTimeout: true }; },
		})).toThrow('subprocess timed out');
	});

	(process.platform === 'win32' ? test : test.skip)('terminates a timed-out native Bun PowerShell child', () => {
		const result = globalThis.Bun.spawnSync([
			resolveWindowsPowerShellPath(process.env),
			'-NoLogo', '-NoProfile', '-NonInteractive', '-Command', 'Start-Sleep -Seconds 30',
		], { stderr: 'pipe', stdout: 'pipe', timeout: 200 });
		let childAlive = true;
		try { process.kill(result.pid, 0); } catch { childAlive = false; }
		if (childAlive) process.kill(result.pid, 'SIGKILL');
		expect(result.exitedDueToTimeout).toBe(true);
		expect(childAlive).toBe(false);
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

	test('hardens the restore-proof directory and copied snapshot before either is opened', () => {
		const calls = [];
		const fsApi = {
			copyFileSync(source, destination, flag) { calls.push(['copy', source, destination, flag]); },
		};
		prepareRestoreProofSnapshot('backup.sqlite', 'private-restore', 'private-restore/kernel.sqlite', {
			fsApi,
			hardenPath(filePath) { calls.push(['harden', filePath]); },
		});
		expect(calls).toEqual([
			['harden', 'private-restore'],
			['copy', 'backup.sqlite', 'private-restore/kernel.sqlite', fs.constants.COPYFILE_EXCL],
			['harden', 'private-restore/kernel.sqlite'],
		]);
	});

	test('fsyncs the recovery parent directory on POSIX before commit', () => {
		const calls = [];
		syncClaimRepairRecoveryDirectory('/private/backups/recovery.sqlite', {
			platform: 'linux',
			fsApi: {
				openSync(directory, mode) { calls.push(['open', directory, mode]); return 17; },
				fsyncSync(descriptor) { calls.push(['fsync', descriptor]); },
				closeSync(descriptor) { calls.push(['close', descriptor]); },
			},
		});
		expect(calls).toEqual([
			['open', '/private/backups', 'r'],
			['fsync', 17],
			['close', 17],
		]);
	});

	test('dry-run reports only a preflight bound to the verified backup snapshot', async () => {
		const driver = {
			async preflightLegacyClaimRepair() { return { digest: 'b'.repeat(64) }; },
			close() {},
		};
		await expect(run({
			mode: 'dry-run',
			databasePath: 'source.sqlite',
			backupPath: 'backup.sqlite',
			observedAt: OBSERVED_AT,
		}, {
			openDriver: () => driver,
			createVerifiedClaimRepairBackup: async () => ({ plan_digest: 'a'.repeat(64) }),
		})).rejects.toMatchObject({ code: 'CLAIM_REPAIR_BACKUP_DRIFT' });
	});

	test('uses an injected single-path hardener without pairing it with the production batch', async () => {
		const driver = {
			async preflightLegacyClaimRepair() { return { digest: 'a'.repeat(64) }; },
			close() {},
		};
		const hardenPath = () => {};
		let received;
		await run({
			mode: 'dry-run',
			databasePath: 'source.sqlite',
			backupPath: 'backup.sqlite',
			observedAt: OBSERVED_AT,
		}, {
			openDriver: () => driver,
			hardenPath,
			createVerifiedClaimRepairBackup: async options => {
				received = options;
				return { plan_digest: 'a'.repeat(64) };
			},
		});
		expect(received.hardenPath).toBe(hardenPath);
		expect(received.hardenPaths).toBeUndefined();
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
		)).rejects.toMatchObject({
			code: 'CLAIM_REPAIR_PREFLIGHT_FAILED',
			details: { errors: expect.objectContaining({
				invalid_issue_state: 1,
				invalid_claim_state: 1,
				invalid_expires_at: 1,
			}) },
		});
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
		)).rejects.toMatchObject({
			code: 'CLAIM_REPAIR_PREFLIGHT_FAILED',
			details: { errors: expect.objectContaining({
				foreign_keys_disabled: 1,
				'index:idx_kernel_claims_active_lease': 1,
				duplicate_active_claim: 1,
				orphan_claim: 1,
			}) },
		});
		brokenAuthority.driver.close();
	});

	test('fails closed when an active claim targets an unclaimable issue type', async () => {
		const fixture = await createFixture();
		await fixture.issue('unclaimable-epic', 'open', 'epic');
		await fixture.claim('invalid-epic-claim', 'unclaimable-epic', { expires_at: null });

		await expect(fixture.driver.preflightLegacyClaimRepair(
			{ observedAt: OBSERVED_AT }, fixture.config,
		)).rejects.toMatchObject({
			code: 'CLAIM_REPAIR_PREFLIGHT_FAILED',
			details: { errors: { unclaimable_active_claim: 1 } },
		});
		fixture.driver.close();
	});
});

describe('legacy claim repair backup and apply', () => {
	test('proves a separate SQLite backup can be restored to the exact approved snapshot', async () => {
		const fixture = await createFixture();
		await seedMixedClaims(fixture);
		const backupPath = path.join(fixture.root, 'backups', 'claims-before.sqlite');
		const hardenedPaths = [];
		const trackingHardener = filePath => {
			hardenedPaths.push(filePath);
			hardenPath(filePath);
		};
		trackingHardener.batch = filePaths => {
			hardenedPaths.push(...filePaths);
			hardenBackupPermissionsBatch(filePaths);
		};

		const proof = await createVerifiedClaimRepairBackup({
			sourceDriver: fixture.driver,
			backupPath,
			observedAt: OBSERVED_AT,
			openDriver: databasePath => createBuiltinSQLiteDriver({ databasePath }),
			hardenPath: trackingHardener,
		});

		expect(fs.existsSync(backupPath)).toBe(true);
		expect(proof).toMatchObject({
			schema_version: 'forge.claim-repair.backup-proof.v1',
			integrity: 'ok',
		});
		expect(proof.backup_sha256).toMatch(/^[0-9a-f]{64}$/);
		expect(proof.plan_digest).toBe(proof.restore_digest);
		expect(hardenedPaths.filter(filePath => filePath === backupPath)).toHaveLength(1);
		await expect(createVerifiedClaimRepairBackup({
			sourceDriver: fixture.driver,
			backupPath,
			observedAt: OBSERVED_AT,
			openDriver: databasePath => createBuiltinSQLiteDriver({ databasePath }),
			hardenPath,
		})).rejects.toMatchObject({ code: 'CLAIM_REPAIR_BACKUP_EXISTS' });
		const verifiedAgain = await verifyClaimRepairBackup({
			backupPath,
			observedAt: OBSERVED_AT,
			openDriver: databasePath => createBuiltinSQLiteDriver({ databasePath }),
			hardenPath,
		});
		expect(verifiedAgain).toEqual(proof);
		fixture.driver.close();
	}, 30_000);

	test('rejects a backup changed after the restore snapshot was read', async () => {
		const fixture = await createFixture();
		await seedMixedClaims(fixture);
		const backupPath = path.join(fixture.root, 'claims-before.sqlite');
		await fixture.driver.backup(backupPath, {}, { noReplace: true });

		await expect(verifyClaimRepairBackup({
			backupPath,
			observedAt: OBSERVED_AT,
			openDriver(databasePath) {
				const restored = createBuiltinSQLiteDriver({ databasePath });
				return {
					async preflightLegacyClaimRepair(input) {
						const result = await restored.preflightLegacyClaimRepair(input);
						fs.writeFileSync(backupPath, 'replaced-after-restore');
						return result;
					},
					close() { restored.close(); },
				};
			},
			hardenPath,
		})).rejects.toMatchObject({ code: 'CLAIM_REPAIR_BACKUP_DRIFT' });
		fixture.driver.close();
	});

	test('never replaces a backup path created during publication', async () => {
		let racedBackupPath;
		const fixture = await createFixture({
			backupVerifier() {
				fs.writeFileSync(racedBackupPath, 'racing-writer', { flag: 'wx' });
			},
		});
		await seedMixedClaims(fixture);
		racedBackupPath = path.join(fixture.root, 'raced-backup.sqlite');
		await expect(createVerifiedClaimRepairBackup({
			sourceDriver: fixture.driver,
			backupPath: racedBackupPath,
			observedAt: OBSERVED_AT,
			openDriver: databasePath => createBuiltinSQLiteDriver({ databasePath }),
			hardenPath,
		})).rejects.toMatchObject({ code: 'CLAIM_REPAIR_BACKUP_EXISTS' });
		expect(fs.readFileSync(racedBackupPath, 'utf8')).toBe('racing-writer');
		fixture.driver.close();
	});

	test('rejects a hardlink backup alias without reusing that SQLite handle', async () => {
		const fixture = await createFixture();
		await seedMixedClaims(fixture);
		const preflight = await fixture.driver.preflightLegacyClaimRepair({ observedAt: OBSERVED_AT }, fixture.config);
		fixture.driver.close();
		const aliasDriver = createBuiltinSQLiteDriver({ databasePath: fixture.databasePath });
		const hardlinkPath = path.join(fixture.root, 'kernel-hardlink.sqlite');
		fs.linkSync(fixture.databasePath, hardlinkPath);
		await expect(aliasDriver.applyLegacyClaimRepair({
			observedAt: OBSERVED_AT,
			approvedDigest: preflight.digest,
			backupPath: hardlinkPath,
			actor: 'approved-operator',
		}, fixture.config)).rejects.toThrow('must not alias');
		aliasDriver.close();
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
			hardenPath,
		});
		await expect(fixture.driver.applyLegacyClaimRepair({
			observedAt: OBSERVED_AT,
			approvedDigest: preflight.digest,
			backupPath: fixture.databasePath,
			actor: 'approved-operator',
		}, fixture.config)).rejects.toThrow('must not alias');
		// Apply accepts only a backupPath and recomputes its proof itself; a
		// caller-supplied proof cannot bypass this missing-path guard.
		await expect(fixture.driver.applyLegacyClaimRepair({
			observedAt: OBSERVED_AT,
			approvedDigest: preflight.digest,
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
		expect(typeof applied.recovery_path).toBe('string');
		expect(fs.existsSync(applied.recovery_path)).toBe(true);
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
		fs.rmSync(backupPath, { force: true });
		const replayWithoutBackup = await fixture.driver.applyLegacyClaimRepair({
			observedAt: OBSERVED_AT,
			approvedDigest: preflight.digest,
			backupPath,
			actor: 'approved-operator',
		}, fixture.config);
		expect(replayWithoutBackup).toEqual({ ...applied, replayed: true });
		await expect(fixture.driver.applyLegacyClaimRepair({
			observedAt: OBSERVED_AT,
			approvedDigest: preflight.digest,
			backupPath,
		}, fixture.config)).rejects.toMatchObject({ code: 'CLAIM_REPAIR_ACTOR_REQUIRED' });
		const receipts = await fixture.driver.queryAll(
			"SELECT * FROM kernel_events WHERE event_type = 'claim.repair';",
			fixture.config,
		);
		expect(receipts).toHaveLength(1);
		expect(receipts[0].payload_json).not.toContain('claim-terminal');
		fixture.driver.close();
	});

	test('reserves the durable claim-repair receipt namespace from generic event writers', async () => {
		const fixture = await createFixture();
		await seedMixedClaims(fixture);
		const preflight = await fixture.driver.preflightLegacyClaimRepair({ observedAt: OBSERVED_AT }, fixture.config);
		const forgedReceipt = {
			schema_version: 'forge.claim-repair.receipt.v1',
			receipt_id: 'forged-row',
			observed_at: OBSERVED_AT,
			approved_digest: preflight.digest,
			after_digest: 'a'.repeat(64),
			backup_sha256: 'b'.repeat(64),
			recovery_ref: '11111111-1111-4111-8111-111111111111',
			mutations: { released: 1, reclaimable: 1, total: 2 },
			replayed: false,
		};
		await expect(fixture.driver.insertKernelEvent({
			id: 'forged-row',
			entity_type: 'claim_repair',
			entity_id: 'legacy_claims',
			event_type: 'claim.repair',
			idempotency_key: `claim.repair:${preflight.digest}`,
			expected_revision: 0,
			actor: 'attacker',
			origin: 'forge.claim-repair',
			payload_json: JSON.stringify(forgedReceipt),
			created_at: OBSERVED_AT,
		}, fixture.config)).rejects.toMatchObject({ code: 'CLAIM_REPAIR_RECEIPT_RESERVED' });
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
			hardenPath,
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

	test('rejects unrelated authority writes after backup without mutating claims', async () => {
		const fixture = await createFixture();
		await seedMixedClaims(fixture);
		const backupPath = path.join(fixture.root, 'claims-before.sqlite');
		const preflight = await fixture.driver.preflightLegacyClaimRepair({ observedAt: OBSERVED_AT }, fixture.config);
		await createVerifiedClaimRepairBackup({
			sourceDriver: fixture.driver,
			backupPath,
			observedAt: OBSERVED_AT,
			openDriver: databasePath => createBuiltinSQLiteDriver({ databasePath }),
			hardenPath,
		});
		await fixture.issue('unrelated-after-backup');

		await expect(fixture.driver.applyLegacyClaimRepair({
			observedAt: OBSERVED_AT,
			approvedDigest: preflight.digest,
			backupPath,
			actor: 'approved-operator',
		}, fixture.config)).rejects.toMatchObject({ code: 'CLAIM_REPAIR_DIGEST_DRIFT' });
		const states = await fixture.driver.queryAll('SELECT state FROM kernel_claims ORDER BY id;', fixture.config);
		expect(states).toEqual([{ state: 'active' }, { state: 'active' }, { state: 'active' }, { state: 'active' }]);
		fixture.driver.close();
	});

	test('binds the digest to rowids used for stage-history and recent-memory ordering', async () => {
		const fixture = await createFixture();
		await fixture.issue('rowid-ordering');
		await fixture.driver.exec(`
			INSERT INTO kernel_stage_runs (
				id, issue_id, stage, substage, status, started_at, completed_at, evidence_id
			) VALUES
				('run-target', 'rowid-ordering', 'dev', NULL, 'done', '${OBSERVED_AT}', '${OBSERVED_AT}', NULL),
				('run-sentinel', 'rowid-ordering', 'dev', NULL, 'done', '${OBSERVED_AT}', '${OBSERVED_AT}', NULL);
			INSERT INTO kernel_memories (
				key, value_json, source_agent, scope, confidence, tags_json,
				supersedes_json, beads_refs_json, created_at, updated_at
			) VALUES
				('memory-target', '{}', 'fixture', NULL, NULL, NULL, NULL, NULL, '${OBSERVED_AT}', '${OBSERVED_AT}'),
				('memory-sentinel', '{}', 'fixture', NULL, NULL, NULL, NULL, NULL, '${OBSERVED_AT}', '${OBSERVED_AT}');
		`, fixture.config);
		const beforeStageReinsert = await fixture.driver.preflightLegacyClaimRepair(
			{ observedAt: OBSERVED_AT },
			fixture.config,
		);
		await fixture.driver.exec(`
			DELETE FROM kernel_stage_runs WHERE id = 'run-target';
			INSERT INTO kernel_stage_runs (
				id, issue_id, stage, substage, status, started_at, completed_at, evidence_id
			) VALUES ('run-target', 'rowid-ordering', 'dev', NULL, 'done', '${OBSERVED_AT}', '${OBSERVED_AT}', NULL);
		`, fixture.config);
		const afterStageReinsert = await fixture.driver.preflightLegacyClaimRepair(
			{ observedAt: OBSERVED_AT },
			fixture.config,
		);
		await fixture.driver.exec(`
			DELETE FROM kernel_memories WHERE key = 'memory-target';
			INSERT INTO kernel_memories (
				key, value_json, source_agent, scope, confidence, tags_json,
				supersedes_json, beads_refs_json, created_at, updated_at
			) VALUES ('memory-target', '{}', 'fixture', NULL, NULL, NULL, NULL, NULL, '${OBSERVED_AT}', '${OBSERVED_AT}');
		`, fixture.config);
		const afterMemoryReinsert = await fixture.driver.preflightLegacyClaimRepair(
			{ observedAt: OBSERVED_AT },
			fixture.config,
		);

		expect(afterStageReinsert.digest).not.toBe(beforeStageReinsert.digest);
		expect(afterMemoryReinsert.digest).not.toBe(afterStageReinsert.digest);
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
			hardenPath,
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

	test('rolls back when the verified backup changes immediately before receipt commit', async () => {
		let backupPath;
		const fixture = await createFixture({
			claimRepairFaultInjector(phase) {
				if (phase === 'before-backup-commit-check') fs.writeFileSync(backupPath, 'replaced');
			},
		});
		await seedMixedClaims(fixture);
		backupPath = path.join(fixture.root, 'claims-before.sqlite');
		const preflight = await fixture.driver.preflightLegacyClaimRepair({ observedAt: OBSERVED_AT }, fixture.config);
		await createVerifiedClaimRepairBackup({
			sourceDriver: fixture.driver,
			backupPath,
			observedAt: OBSERVED_AT,
			openDriver: databasePath => createBuiltinSQLiteDriver({ databasePath }),
			hardenPath,
		});

		await expect(fixture.driver.applyLegacyClaimRepair({
			observedAt: OBSERVED_AT,
			approvedDigest: preflight.digest,
			backupPath,
			actor: 'approved-operator',
		}, fixture.config)).rejects.toMatchObject({ code: 'CLAIM_REPAIR_BACKUP_DRIFT' });
		const rows = await fixture.driver.queryAll('SELECT state FROM kernel_claims ORDER BY id;', fixture.config);
		expect(rows).toEqual([{ state: 'active' }, { state: 'active' }, { state: 'active' }, { state: 'active' }]);
		fixture.driver.close();
	});

	test('keeps the verified backup fenced through receipt insertion and rolls back late replacement', async () => {
		let backupPath;
		const fixture = await createFixture({
			claimRepairFaultInjector(phase) {
				if (phase === 'after-receipt-before-commit') fs.writeFileSync(backupPath, 'replaced-late');
			},
		});
		await seedMixedClaims(fixture);
		backupPath = path.join(fixture.root, 'claims-before.sqlite');
		const preflight = await fixture.driver.preflightLegacyClaimRepair({ observedAt: OBSERVED_AT }, fixture.config);
		await createVerifiedClaimRepairBackup({
			sourceDriver: fixture.driver,
			backupPath,
			observedAt: OBSERVED_AT,
			openDriver: databasePath => createBuiltinSQLiteDriver({ databasePath }),
			hardenPath,
		});

		await expect(fixture.driver.applyLegacyClaimRepair({
			observedAt: OBSERVED_AT,
			approvedDigest: preflight.digest,
			backupPath,
			actor: 'approved-operator',
		}, fixture.config)).rejects.toMatchObject({ code: 'CLAIM_REPAIR_BACKUP_DRIFT' });
		const rows = await fixture.driver.queryAll('SELECT state FROM kernel_claims ORDER BY id;', fixture.config);
		expect(rows).toEqual([{ state: 'active' }, { state: 'active' }, { state: 'active' }, { state: 'active' }]);
		const receipts = await fixture.driver.queryAll(
			"SELECT * FROM kernel_events WHERE event_type = 'claim.repair';",
			fixture.config,
		);
		expect(receipts).toEqual([]);
		expect(fs.readdirSync(fixture.root).filter(name => name.includes('.forge-recovery-'))).toEqual([]);
		fixture.driver.close();
	});

	test('preserves the verified recovery copy when the backup name changes during commit', async () => {
		let backupPath;
		const fixture = await createFixture({
			claimRepairFaultInjector(phase) {
				if (phase !== 'after-commit-before-backup-check') return;
				fs.rmSync(backupPath);
				fs.writeFileSync(backupPath, 'post-commit replacement');
			},
		});
		await seedMixedClaims(fixture);
		backupPath = path.join(fixture.root, 'claims-before.sqlite');
		const preflight = await fixture.driver.preflightLegacyClaimRepair({ observedAt: OBSERVED_AT }, fixture.config);
		await createVerifiedClaimRepairBackup({
			sourceDriver: fixture.driver,
			backupPath,
			observedAt: OBSERVED_AT,
			openDriver: databasePath => createBuiltinSQLiteDriver({ databasePath }),
			hardenPath,
		});

		let failure;
		try {
			await fixture.driver.applyLegacyClaimRepair({
				observedAt: OBSERVED_AT,
				approvedDigest: preflight.digest,
				backupPath,
				actor: 'approved-operator',
			}, fixture.config);
		} catch (error) {
			failure = error;
		}
		const recoveryPath = failure?.details?.recovery_path;
		expect(failure?.code).toBe('CLAIM_REPAIR_BACKUP_POSTCOMMIT_DRIFT');
		expect(typeof recoveryPath).toBe('string');
		expect(fs.readdirSync(fixture.root)).toContain(path.basename(recoveryPath));
		const rows = await fixture.driver.queryAll('SELECT state FROM kernel_claims ORDER BY id;', fixture.config);
		expect(rows).toEqual([{ state: 'active' }, { state: 'reclaimable' }, { state: 'active' }, { state: 'released' }]);
		const receipts = await fixture.driver.queryAll(
			"SELECT * FROM kernel_events WHERE event_type = 'claim.repair';",
			fixture.config,
		);
		expect(receipts).toHaveLength(1);
		await expect(fixture.driver.applyLegacyClaimRepair({
			observedAt: OBSERVED_AT,
			approvedDigest: preflight.digest,
			backupPath,
			actor: 'approved-operator',
		}, fixture.config)).resolves.toMatchObject({ replayed: true });
		fixture.driver.close();
	});

	test('preserves an independent recovery copy when the named backup is overwritten in place', async () => {
		let backupPath;
		const fixture = await createFixture({
			claimRepairFaultInjector(phase) {
				if (phase === 'after-commit-before-backup-check') {
					fs.writeFileSync(backupPath, 'in-place post-commit corruption');
				}
			},
		});
		await seedMixedClaims(fixture);
		backupPath = path.join(fixture.root, 'claims-before.sqlite');
		const preflight = await fixture.driver.preflightLegacyClaimRepair({ observedAt: OBSERVED_AT }, fixture.config);
		await createVerifiedClaimRepairBackup({
			sourceDriver: fixture.driver,
			backupPath,
			observedAt: OBSERVED_AT,
			openDriver: databasePath => createBuiltinSQLiteDriver({ databasePath }),
			hardenPath,
		});

		let failure;
		try {
			await fixture.driver.applyLegacyClaimRepair({
				observedAt: OBSERVED_AT,
				approvedDigest: preflight.digest,
				backupPath,
				actor: 'approved-operator',
			}, fixture.config);
		} catch (error) {
			failure = error;
		}
		expect(failure?.code).toBe('CLAIM_REPAIR_BACKUP_POSTCOMMIT_DRIFT');
		const proof = await verifyClaimRepairBackup({
			backupPath: failure.details.recovery_path,
			observedAt: OBSERVED_AT,
			openDriver: databasePath => createBuiltinSQLiteDriver({ databasePath }),
			hardenPath,
		});
		expect(proof.plan_digest).toBe(preflight.digest);
		fixture.driver.close();
	});

	test('preserves the verified recovery copy when a sidecar blocker is replaced during commit', async () => {
		let backupPath;
		const fixture = await createFixture({
			claimRepairFaultInjector(phase) {
				if (phase !== 'after-commit-before-backup-check') return;
				fs.rmdirSync(`${backupPath}-wal`);
				fs.writeFileSync(`${backupPath}-wal`, 'replacement sidecar');
			},
		});
		await seedMixedClaims(fixture);
		backupPath = path.join(fixture.root, 'claims-before.sqlite');
		const preflight = await fixture.driver.preflightLegacyClaimRepair({ observedAt: OBSERVED_AT }, fixture.config);
		await createVerifiedClaimRepairBackup({
			sourceDriver: fixture.driver,
			backupPath,
			observedAt: OBSERVED_AT,
			openDriver: databasePath => createBuiltinSQLiteDriver({ databasePath }),
			hardenPath,
		});

		let failure;
		try {
			await fixture.driver.applyLegacyClaimRepair({
				observedAt: OBSERVED_AT,
				approvedDigest: preflight.digest,
				backupPath,
				actor: 'approved-operator',
			}, fixture.config);
		} catch (error) {
			failure = error;
		}
		const recoveryPath = failure?.details?.recovery_path;
		expect(failure?.code).toBe('CLAIM_REPAIR_BACKUP_POSTCOMMIT_DRIFT');
		expect(typeof recoveryPath).toBe('string');
		expect(fs.readdirSync(fixture.root)).toContain(path.basename(recoveryPath));
		await expect(fixture.driver.applyLegacyClaimRepair({
			observedAt: OBSERVED_AT,
			approvedDigest: preflight.digest,
			backupPath,
			actor: 'approved-operator',
		}, fixture.config)).resolves.toMatchObject({ replayed: true });
		fixture.driver.close();
	});

	test('retains the verified recovery copy when the backup changes after final verification', async () => {
		let backupPath;
		const fixture = await createFixture({
			claimRepairFaultInjector(phase) {
				if (phase !== 'after-postcommit-backup-check') return;
				fs.rmSync(backupPath);
				fs.writeFileSync(backupPath, 'post-verification replacement');
			},
		});
		await seedMixedClaims(fixture);
		backupPath = path.join(fixture.root, 'claims-before.sqlite');
		const preflight = await fixture.driver.preflightLegacyClaimRepair({ observedAt: OBSERVED_AT }, fixture.config);
		await createVerifiedClaimRepairBackup({
			sourceDriver: fixture.driver,
			backupPath,
			observedAt: OBSERVED_AT,
			openDriver: databasePath => createBuiltinSQLiteDriver({ databasePath }),
			hardenPath,
		});

		const applied = await fixture.driver.applyLegacyClaimRepair({
			observedAt: OBSERVED_AT,
			approvedDigest: preflight.digest,
			backupPath,
			actor: 'approved-operator',
		}, fixture.config);
		expect(typeof applied.recovery_path).toBe('string');
		expect(fs.existsSync(applied.recovery_path)).toBe(true);
		expect(fs.readFileSync(applied.recovery_path).equals(fs.readFileSync(backupPath))).toBe(false);
		await expect(fixture.driver.applyLegacyClaimRepair({
			observedAt: OBSERVED_AT,
			approvedDigest: preflight.digest,
			backupPath,
			actor: 'approved-operator',
		}, fixture.config)).resolves.toMatchObject({ replayed: true });
		fixture.driver.close();
	});

	test('replays a persisted recovery reference after response loss post-commit', async () => {
		let loseResponse = true;
		const fixture = await createFixture({
			claimRepairFaultInjector(phase) {
				if (phase === 'after-postcommit-backup-check' && loseResponse) {
					loseResponse = false;
					throw new Error('simulated response loss');
				}
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
			hardenPath,
		});

		await expect(fixture.driver.applyLegacyClaimRepair({
			observedAt: OBSERVED_AT,
			approvedDigest: preflight.digest,
			backupPath,
			actor: 'approved-operator',
		}, fixture.config)).rejects.toThrow('simulated response loss');
		const replay = await fixture.driver.applyLegacyClaimRepair({
			observedAt: OBSERVED_AT,
			approvedDigest: preflight.digest,
			backupPath,
			actor: 'approved-operator',
		}, fixture.config);
		expect(replay.replayed).toBe(true);
		expect(replay.recovery_ref).toMatch(/^[0-9a-f-]{36}$/);
		expect(typeof replay.recovery_path).toBe('string');
		expect(fs.existsSync(replay.recovery_path)).toBe(true);
		fixture.driver.close();
	});

	test('rejects replay when the retained recovery copy is missing or corrupted', async () => {
		const fixture = await createFixture();
		await seedMixedClaims(fixture);
		const backupPath = path.join(fixture.root, 'claims-before.sqlite');
		const preflight = await fixture.driver.preflightLegacyClaimRepair({ observedAt: OBSERVED_AT }, fixture.config);
		await createVerifiedClaimRepairBackup({
			sourceDriver: fixture.driver,
			backupPath,
			observedAt: OBSERVED_AT,
			openDriver: databasePath => createBuiltinSQLiteDriver({ databasePath }),
			hardenPath,
		});
		const applied = await fixture.driver.applyLegacyClaimRepair({
			observedAt: OBSERVED_AT,
			approvedDigest: preflight.digest,
			backupPath,
			actor: 'approved-operator',
		}, fixture.config);
		fs.writeFileSync(applied.recovery_path, 'corrupted recovery');

		await expect(fixture.driver.applyLegacyClaimRepair({
			observedAt: OBSERVED_AT,
			approvedDigest: preflight.digest,
			backupPath,
			actor: 'approved-operator',
		}, fixture.config)).rejects.toMatchObject({ code: 'CLAIM_REPAIR_RECOVERY_INVALID' });
		fixture.driver.close();
	});

	test('rejects replay when the retained recovery copy aliases the named backup', async () => {
		const fixture = await createFixture();
		await seedMixedClaims(fixture);
		const backupPath = path.join(fixture.root, 'claims-before.sqlite');
		const preflight = await fixture.driver.preflightLegacyClaimRepair({ observedAt: OBSERVED_AT }, fixture.config);
		await createVerifiedClaimRepairBackup({
			sourceDriver: fixture.driver,
			backupPath,
			observedAt: OBSERVED_AT,
			openDriver: databasePath => createBuiltinSQLiteDriver({ databasePath }),
			hardenPath,
		});
		const applied = await fixture.driver.applyLegacyClaimRepair({
			observedAt: OBSERVED_AT,
			approvedDigest: preflight.digest,
			backupPath,
			actor: 'approved-operator',
		}, fixture.config);
		fs.rmSync(applied.recovery_path);
		fs.linkSync(backupPath, applied.recovery_path);

		await expect(fixture.driver.applyLegacyClaimRepair({
			observedAt: OBSERVED_AT,
			approvedDigest: preflight.digest,
			backupPath,
			actor: 'approved-operator',
		}, fixture.config)).rejects.toMatchObject({ code: 'CLAIM_REPAIR_RECOVERY_INVALID' });
		fixture.driver.close();
	});

	test('rejects a backup replaced by a source alias at the commit-fence seam', async () => {
		let backupPath;
		let databasePath;
		const fixture = await createFixture({
			claimRepairFaultInjector(phase) {
				if (phase !== 'before-backup-commit-check') return;
				fs.rmSync(backupPath);
				fs.linkSync(databasePath, backupPath);
			},
		});
		await seedMixedClaims(fixture);
		backupPath = path.join(fixture.root, 'claims-before.sqlite');
		databasePath = fixture.databasePath;
		const preflight = await fixture.driver.preflightLegacyClaimRepair({ observedAt: OBSERVED_AT }, fixture.config);
		await createVerifiedClaimRepairBackup({
			sourceDriver: fixture.driver,
			backupPath,
			observedAt: OBSERVED_AT,
			openDriver: restoredPath => createBuiltinSQLiteDriver({ databasePath: restoredPath }),
			hardenPath,
		});

		await expect(fixture.driver.applyLegacyClaimRepair({
			observedAt: OBSERVED_AT,
			approvedDigest: preflight.digest,
			backupPath,
			actor: 'approved-operator',
		}, fixture.config)).rejects.toMatchObject({ code: 'CLAIM_REPAIR_BACKUP_DRIFT' });
		if (process.platform !== 'darwin') {
			const rows = await fixture.driver.queryAll('SELECT state FROM kernel_claims ORDER BY id;', fixture.config);
			expect(rows).toEqual([{ state: 'active' }, { state: 'active' }, { state: 'active' }, { state: 'active' }]);
		}
		fixture.driver.close();
	});

	test.skipIf(process.platform === 'win32')('restores owner-only backup permissions immediately before commit', async () => {
		let backupPath;
		const fixture = await createFixture({
			claimRepairFaultInjector(phase) {
				if (phase === 'after-receipt-before-commit') fs.chmodSync(backupPath, 0o644);
			},
		});
		await seedMixedClaims(fixture);
		backupPath = path.join(fixture.root, 'claims-before.sqlite');
		const preflight = await fixture.driver.preflightLegacyClaimRepair({ observedAt: OBSERVED_AT }, fixture.config);
		await createVerifiedClaimRepairBackup({
			sourceDriver: fixture.driver,
			backupPath,
			observedAt: OBSERVED_AT,
			openDriver: databasePath => createBuiltinSQLiteDriver({ databasePath }),
			hardenPath,
		});

		await expect(fixture.driver.applyLegacyClaimRepair({
			observedAt: OBSERVED_AT,
			approvedDigest: preflight.digest,
			backupPath,
			actor: 'approved-operator',
		}, fixture.config)).resolves.toMatchObject({ replayed: false });
		expect(fs.statSync(backupPath).mode & 0o077).toBe(0);
		fixture.driver.close();
	});
});
