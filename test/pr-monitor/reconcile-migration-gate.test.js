'use strict';

const { describe, expect, test } = require('bun:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createBuiltinSQLiteDriver } = require('../../lib/kernel/sqlite-driver');
const watchOwnerAuthority = require('../../lib/pr-monitor/watch-owner');
const {
	migrateLegacyAuthority,
	hashLegacySnapshot,
	defaultReadLegacySnapshot,
	runDaemon,
} = require('../../lib/pr-monitor/reconcile-executor');

const NOW = 1787077800000;

function entry(repo, pr, fields = {}) {
	return { repo, pr, pid: 100 + pr, startedAt: '2026-08-19T00:00:00.000Z', providerState: 'open', ...fields };
}

function snapshot(entries, fields = {}) {
	return { entries, sources: [{ path: 'shepherd.lock', content: '{}' }], corrupt: false, unmappable: false, ...fields };
}

function authorityHarness(options = {}) {
	const rows = new Map();
	const calls = [];
	let gate = null;
	let imports = 0;
	let generations = 0;
	const boundSnapshotHashes = [];
	const key = value => `${value.repo}#${value.pr}`;
	const importRow = (ctx, input, phase) => {
		const existing = rows.get(key(ctx));
		const startedAt = input.startedAt || ctx.startedAt || null;
		if (existing?.phase === phase && existing.legacyEvidenceHash === input.legacyEvidenceHash) {
			if (existing.startedAt !== startedAt) return { ok: false, changed: false, reason: 'owner_conflict', record: existing };
			return { ok: true, changed: false, record: existing };
		}
		const record = {
			...ctx,
			startedAt,
			phase,
			generation: `generation-${generations += 1}`,
			legacyEvidenceHash: input.legacyEvidenceHash,
			...(input.controllerPid ? { controllerPid: input.controllerPid } : {}),
			...(input.terminalReceiptId ? { terminalReceiptId: input.terminalReceiptId } : {}),
		};
		rows.set(key(ctx), record);
		return { ok: true, changed: true, record };
	};
	const api = {
		calls,
		rows,
		boundSnapshotHashes,
		async publishMigrationQuarantine(input = {}) {
			calls.push('quarantine');
			if (gate) return { ok: gate.state === 'quarantined', changed: false, reason: 'gate_conflict', gate };
			gate = { state: 'quarantined', snapshot_hash: null, updated_at: input.updatedAt || null };
			return { ok: true, changed: true, gate };
		},
		async bindMigrationSnapshot(input) {
			calls.push('bind');
			boundSnapshotHashes.push(input.snapshotHash);
			if (options.failBindOnce) {
				options.failBindOnce = false;
				return { ok: false, reason: 'authority_unavailable', gate };
			}
			if (gate.snapshot_hash && gate.snapshot_hash !== input.snapshotHash) return { ok: false, reason: 'snapshot_mismatch', gate };
			gate = { ...gate, snapshot_hash: input.snapshotHash, updated_at: input.updatedAt || gate.updated_at };
			return { ok: true, changed: true, gate };
		},
		async publishMigrationConflict(input) {
			calls.push(`conflict:${input.conflictCode}`);
			gate = { state: 'conflict', snapshot_hash: input.snapshotHash, conflict_code: input.conflictCode };
			return { ok: true, changed: true, gate };
		},
		async importLegacyStarting(ctx, input) {
			imports += 1;
			calls.push(`starting:${key(ctx)}`);
			if (options.crashImportAt === imports) throw new Error('simulated crash');
			return importRow(ctx, input, 'starting');
		},
		async importLegacyComplete(ctx, input) {
			imports += 1;
			calls.push(`complete:${key(ctx)}`);
			if (options.crashImportAt === imports) throw new Error('simulated crash');
			return importRow(ctx, input, 'complete');
		},
		async markLegacyBlocked(ctx, input) {
			calls.push(`blocked:${key(ctx)}:${input.blockReason}`);
			rows.set(key(ctx), {
				...ctx,
				startedAt: input.startedAt || ctx.startedAt || null,
				phase: 'blocked',
				blockReason: input.blockReason,
				terminalReceiptId: input.terminalReceiptId || null,
				legacyEvidenceHash: input.legacyEvidenceHash,
			});
			return { ok: true, changed: true, record: rows.get(key(ctx)) };
		},
		async enumerateOwners() {
			calls.push('enumerate');
			return { ok: true, records: [...rows.values()] };
		},
		async readMigrationGate() {
			calls.push('read-gate');
			return gate ? { ok: true, gate } : { ok: false, reason: 'absent', gate: null };
		},
		async completeMigrationGate(input) {
			calls.push('complete-gate');
			if (options.crashBeforeCompleteOnce) {
				options.crashBeforeCompleteOnce = false;
				throw new Error('simulated pre-complete crash');
			}
			if (gate.state !== 'quarantined' || gate.snapshot_hash !== input.snapshotHash) return { ok: false, reason: 'gate_mismatch', gate };
			gate = { ...gate, state: 'complete' };
			return { ok: true, changed: true, gate };
		},
	};
	return api;
}

function verifierHonoringHarness() {
	const api = authorityHarness();
	const importStarting = api.importLegacyStarting;
	const importComplete = api.importLegacyComplete;
	api.importLegacyStarting = async (ctx, input, operationOptions) => {
		const dead = await operationOptions.isPidAlive(input.legacyPid) === false;
		const providerVerified = await operationOptions.verifyProviderEvidence(
			input.providerEvidence, { ...ctx, states: ['open'] },
		) === true;
		return dead && providerVerified
			? importStarting(ctx, input, operationOptions)
			: { ok: false, changed: false, reason: 'provider_evidence_invalid', record: null };
	};
	api.importLegacyComplete = async (ctx, input, operationOptions) => {
		const dead = input.legacyPid == null
			|| await operationOptions.isPidAlive(input.legacyPid) === false;
		const receiptVerified = await operationOptions.verifyTerminalReceipt(input.terminalReceiptId, ctx) === true;
		return dead && receiptVerified
			? importComplete(ctx, input, operationOptions)
			: { ok: false, changed: false, reason: 'receipt_unverified', record: null };
	};
	return api;
}

function run(api, legacy, extra = {}) {
	return migrateLegacyAuthority('/repo', {
		authority: api,
		now: () => NOW,
		readLegacySnapshot: async () => structuredClone(legacy),
		isAlive: () => false,
		readProviderState: async identity => identity.providerState,
		...extra,
	});
}

describe('one-release watcher authority migration gate', () => {
	test('hashes only legacy watcher authority from the daemon lease, not changing election heartbeats', () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-legacy-snapshot-'));
		const gitCommonDir = path.join(root, '.git');
		const forgeDir = path.join(gitCommonDir, 'forge');
		fs.mkdirSync(forgeDir, { recursive: true });
		const file = path.join(forgeDir, 'shepherd.lock');
		try {
			fs.writeFileSync(file, JSON.stringify({
				pid: 1, token: 'a', heartbeatAt: 'first', watchers: [{ repo: 'acme/repo', pr: 7, pid: 107 }],
			}));
			const first = defaultReadLegacySnapshot(root, { gitCommonDir, repo: 'acme/repo' });
			fs.writeFileSync(file, JSON.stringify({
				pid: 2, token: 'b', heartbeatAt: 'second', watchers: [{ repo: 'acme/repo', pr: 7, pid: 107 }],
			}));
			const second = defaultReadLegacySnapshot(root, { gitCommonDir, repo: 'acme/repo' });
			expect(hashLegacySnapshot(first)).toBe(hashLegacySnapshot(second));
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	test('hashes parsed watcher authority, not volatile monitor checks or verdicts', () => {
		const first = snapshot([entry('acme/repo', 7, {
			pid: 107, startedAt: '2026-08-19T00:00:00.000Z', providerState: 'open',
		})], {
			sources: [
				{ path: 'cleanup-repo-7/snapshot.json', content: '{"checks":[{"name":"ci","class":"green"}]}' },
				{ path: 'cleanup-repo-7/watch.generation', content: 'generation-a' },
				{ path: 'cleanup-repo-7/cleanup.marker', content: 'cleanup-a' },
			],
		});
		const monitorOnly = structuredClone(first);
		monitorOnly.sources[0].content = '{"checks":[{"name":"ci","class":"failed"}],"verdict":{"state":"BLOCKED"}}';
		expect(hashLegacySnapshot(monitorOnly)).toBe(hashLegacySnapshot(first));

		for (const [field, value] of [
			['pid', 108],
			['startedAt', '2026-08-19T00:01:00.000Z'],
			['repo', 'other/repo'],
			['pr', 8],
			['terminalReceiptId', 'receipt-7'],
		]) {
			const changed = structuredClone(first);
			changed.entries[0][field] = value;
			expect(hashLegacySnapshot(changed), field).not.toBe(hashLegacySnapshot(first));
		}
		for (const markerIndex of [1, 2]) {
			const changed = structuredClone(first);
			changed.sources[markerIndex].content += '-changed';
			expect(hashLegacySnapshot(changed)).not.toBe(hashLegacySnapshot(first));
		}
	});

	test('hashes shared markers identically from the primary checkout and a linked worktree', () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-legacy-marker-'));
		const gitCommonDir = path.join(root, '.git');
		try {
			const monitorDir = path.join(root, '.forge', 'pr-monitor', 'acme-repo-7');
			fs.mkdirSync(monitorDir, { recursive: true });
			fs.writeFileSync(path.join(monitorDir, 'snapshot.json'), JSON.stringify({
				repo: 'acme/repo', pr: 7, startedAt: '2026-08-19T00:00:00.000Z', state: 'open',
			}));
			fs.writeFileSync(path.join(monitorDir, 'watch.pid'), '107');
			fs.writeFileSync(path.join(monitorDir, 'watch.generation'), 'generation-a');
			fs.writeFileSync(path.join(monitorDir, 'cleanup.marker'), 'cleanup-a');
			const worktreeRoot = path.join(root, '.worktrees', 'feature');
			fs.mkdirSync(worktreeRoot, { recursive: true });

			const fromPrimary = defaultReadLegacySnapshot(root, { gitCommonDir, repo: 'acme/repo' });
			const fromWorktree = defaultReadLegacySnapshot(worktreeRoot, { gitCommonDir, repo: 'acme/repo' });

			expect(fromPrimary.sources.some(source => source.path.startsWith('.forge/pr-monitor/'))).toBe(true);
			expect(fromWorktree.sources.some(source => source.path.startsWith('git-common-root/.forge/pr-monitor/'))).toBe(true);
			expect(hashLegacySnapshot(fromWorktree)).toBe(hashLegacySnapshot(fromPrimary));
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	test('assigns distinct stable hashes to each canonical migrated entry', async () => {
		const legacy = snapshot([
			entry('zeta/repo', 2, { pid: 102 }),
			entry('acme/repo', 9, { pid: 109 }),
		]);
		const firstApi = authorityHarness();
		await run(firstApi, legacy);
		const firstHashes = Object.fromEntries(
			[...firstApi.rows].map(([key, row]) => [key, row.legacyEvidenceHash]),
		);

		const reorderedApi = authorityHarness();
		await run(reorderedApi, snapshot([
			{ ...legacy.entries[1], ignoredMonitorField: 'changing' },
			{ ...legacy.entries[0], ignoredMonitorField: 'changing' },
		]));
		const reorderedHashes = Object.fromEntries(
			[...reorderedApi.rows].map(([key, row]) => [key, row.legacyEvidenceHash]),
		);

		expect(firstHashes).toEqual(reorderedHashes);
		expect(firstHashes['acme/repo#9']).not.toBe(firstHashes['zeta/repo#2']);
	});

	test('enumerates the filesystem-owner prototype as read-only legacy evidence', () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-legacy-owner-'));
		const gitCommonDir = path.join(root, '.git');
		const ownerDir = path.join(gitCommonDir, 'forge', 'pr-monitor', 'owners', 'digest');
		fs.mkdirSync(ownerDir, { recursive: true });
		fs.writeFileSync(path.join(ownerDir, 'watch.owner.json'), JSON.stringify({
			version: 1, repo: 'acme/repo', pr: 8, generation: 'legacy-generation', phase: 'running',
			controllerPid: null, pid: 108, startedAt: '2026-08-19T00:00:00.000Z',
			updatedAt: '2026-08-19T00:00:00.000Z', heartbeatAt: '2026-08-19T00:00:00.000Z',
			terminalReceiptId: null, blockReason: null,
		}));
		try {
			const value = defaultReadLegacySnapshot(root, { gitCommonDir, repo: 'acme/repo' });
			expect(value).toMatchObject({ corrupt: false, unmappable: false });
			expect(value.entries).toContainEqual(expect.objectContaining({ repo: 'acme/repo', pr: 8, pid: 108 }));
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	test('hashes stable owner authority fields but ignores heartbeat timestamps', () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-legacy-owner-hash-'));
		const gitCommonDir = path.join(root, '.git');
		const ownerFile = path.join(gitCommonDir, 'forge', 'pr-monitor', 'owners', 'digest', 'watch.owner.json');
		fs.mkdirSync(path.dirname(ownerFile), { recursive: true });
			const record = {
			version: 1, repo: 'acme/repo', pr: 8, generation: 'generation-a', phase: 'blocked',
			controllerPid: 108, pid: 208, startedAt: '2026-08-19T00:00:00.000Z',
			updatedAt: '2026-08-19T00:00:00.000Z', heartbeatAt: '2026-08-19T00:00:00.000Z',
			terminalReceiptId: 'receipt-8', blockReason: 'legacy_conflict',
		};
		try {
			fs.writeFileSync(ownerFile, JSON.stringify(record));
			const first = defaultReadLegacySnapshot(root, { gitCommonDir, repo: 'acme/repo' });
			const firstHash = hashLegacySnapshot(first);
			fs.writeFileSync(ownerFile, JSON.stringify({ ...record,
				updatedAt: '2026-08-19T00:01:00.000Z', heartbeatAt: '2026-08-19T00:01:00.000Z',
			}));
			expect(hashLegacySnapshot(defaultReadLegacySnapshot(root, { gitCommonDir, repo: 'acme/repo' })))
				.toBe(firstHash);
			for (const [field, value] of [
				['generation', 'generation-b'], ['controllerPid', 109], ['blockReason', 'legacy_lossy'],
			]) {
				fs.writeFileSync(ownerFile, JSON.stringify({ ...record, [field]: value }));
				expect(hashLegacySnapshot(defaultReadLegacySnapshot(root, { gitCommonDir, repo: 'acme/repo' })), field)
					.not.toBe(firstHash);
			}
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	test('reads standard-repository PID and started-at markers without writing them', () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-legacy-standard-root-'));
		const gitCommonDir = path.join(root, '.git');
		const monitorDir = path.join(root, '.forge', 'pr-monitor', 'acme-repo-9');
		fs.mkdirSync(monitorDir, { recursive: true });
		fs.writeFileSync(path.join(monitorDir, 'snapshot.json'), JSON.stringify({
			snapshot: { repo: 'acme/repo', pr: 9, state: 'open' },
		}));
		fs.writeFileSync(path.join(monitorDir, 'watch.pid'), '109');
		fs.writeFileSync(path.join(monitorDir, 'watch.startedat'), '2026-08-19T00:00:00.000Z');
		try {
			const before = fs.readdirSync(monitorDir).sort();
			const value = defaultReadLegacySnapshot(root, { gitCommonDir, repo: 'acme/repo' });
			expect(value.entries).toContainEqual(expect.objectContaining({
				repo: 'acme/repo', pr: 9, pid: 109, startedAt: '2026-08-19T00:00:00.000Z',
			}));
			expect(value.sources.some(source => source.path.endsWith('/watch.startedat'))).toBe(true);
			expect(fs.readdirSync(monitorDir).sort()).toEqual(before);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	test('ignores a PID-less inline journal snapshot without lifecycle authority', async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-inline-journal-only-'));
		const gitCommonDir = path.join(root, '.git');
		const monitorDir = path.join(root, '.forge', 'pr-monitor', 'acme-repo-9');
		fs.mkdirSync(monitorDir, { recursive: true });
		fs.writeFileSync(path.join(monitorDir, 'snapshot.json'), JSON.stringify({
			snapshot: { repo: 'acme/repo', pr: 9, state: 'open', checks: [] },
		}));
		const api = authorityHarness();
		try {
			const result = await migrateLegacyAuthority(root, {
				authority: api,
				gitCommonDir,
				repo: 'acme/repo',
				now: () => NOW,
				isAlive: () => false,
				readProviderState: async () => 'open',
			});
			expect(result).toMatchObject({ ok: true, state: 'complete' });
			expect(api.rows.size).toBe(0);
			expect(api.calls.some(value => value.startsWith('blocked:'))).toBe(false);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	test('retains a PID-less snapshot when lifecycle authority evidence exists', async () => {
		for (const [marker, content] of [
			['watch.pid', 'not-a-pid'],
			['watch.startedat', '2026-08-19T00:00:00.000Z'],
			['watch.generation', 'generation-a'],
			['cleanup.marker', 'cleanup-a'],
		]) {
			const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-inline-journal-authority-'));
			const gitCommonDir = path.join(root, '.git');
			const monitorDir = path.join(root, '.forge', 'pr-monitor', 'acme-repo-9');
			fs.mkdirSync(monitorDir, { recursive: true });
			fs.writeFileSync(path.join(monitorDir, 'snapshot.json'), JSON.stringify({
				snapshot: { repo: 'acme/repo', pr: 9, state: 'open' },
			}));
			fs.writeFileSync(path.join(monitorDir, marker), content);
			const api = authorityHarness();
			try {
				const result = await migrateLegacyAuthority(root, {
					authority: api,
					gitCommonDir,
					repo: 'acme/repo',
					now: () => NOW,
					isAlive: () => false,
					readProviderState: async () => 'open',
				});
				expect(result).toMatchObject({ ok: true, state: 'complete' });
				expect(api.rows.get('acme/repo#9')).toMatchObject({ phase: 'blocked' });
				expect(api.calls).toContain('blocked:acme/repo#9:legacy_lossy');
			} finally {
				fs.rmSync(root, { recursive: true, force: true });
			}
		}
	});

	test('reads the shared standard-repository journal when invoked from a linked worktree', () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-legacy-linked-worktree-'));
		const primaryRoot = path.join(root, 'primary');
		const worktreeRoot = path.join(root, 'linked');
		const gitCommonDir = path.join(primaryRoot, '.git');
		const monitorDir = path.join(primaryRoot, '.forge', 'pr-monitor', 'acme-repo-19');
		fs.mkdirSync(monitorDir, { recursive: true });
		fs.mkdirSync(worktreeRoot, { recursive: true });
		fs.writeFileSync(path.join(monitorDir, 'snapshot.json'), JSON.stringify({
			snapshot: { repo: 'acme/repo', pr: 19, state: 'open' },
		}));
		fs.writeFileSync(path.join(monitorDir, 'watch.pid'), '119');
		try {
			const value = defaultReadLegacySnapshot(worktreeRoot, { gitCommonDir, repo: 'acme/repo' });
			expect(value.entries).toContainEqual(expect.objectContaining({ repo: 'acme/repo', pr: 19, pid: 119 }));
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	test('imports a numeric shepherd lease watcher as one canonical owner row', async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-legacy-numeric-watcher-'));
		const gitCommonDir = path.join(root, '.git');
		const forgeDir = path.join(gitCommonDir, 'forge');
		fs.mkdirSync(forgeDir, { recursive: true });
		fs.writeFileSync(path.join(forgeDir, 'shepherd.lock'), JSON.stringify({ watchers: [7] }));
		const api = authorityHarness();
		try {
			const result = await migrateLegacyAuthority(root, {
				authority: api,
				gitCommonDir,
				repo: 'acme/repo',
				now: () => NOW,
				isAlive: () => false,
				readProviderState: async () => 'open',
			});
			expect(result).toMatchObject({ ok: true, state: 'complete' });
			expect(api.rows.size).toBe(1);
			expect(api.rows.get('acme/repo#7')).toMatchObject({
				repo: 'acme/repo', pr: 7, phase: 'blocked',
			});
			expect(api.calls.filter(value => value.startsWith('blocked:acme/repo#7:'))).toHaveLength(1);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	test('daemon resolves the parent repository before migrating a numeric lease watcher', async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-daemon-numeric-watcher-'));
		const gitCommonDir = path.join(root, '.git');
		const forgeDir = path.join(gitCommonDir, 'forge');
		fs.mkdirSync(forgeDir, { recursive: true });
		fs.writeFileSync(path.join(forgeDir, 'shepherd.lock'), JSON.stringify({ watchers: [12] }));
		const api = authorityHarness();
		let convergedRepo = null;
		try {
			const result = await runDaemon(root, {
				gitCommonDir,
				authority: api,
				broker: {},
				driver: {},
				once: true,
				acquire: () => ({ ok: true, token: 'lease-token' }),
				startHeartbeat: () => null,
				stopHeartbeat: () => {},
				release: () => {},
				exit: () => {},
				runGh: args => {
					expect(args).toEqual(['repo', 'view', '--json', 'nameWithOwner,parent']);
					return { nameWithOwner: 'fork/repo', parent: { nameWithOwner: 'Upstream/Repo' } };
				},
				isAlive: () => false,
				readProviderState: async () => 'open',
				convergeOnce: async (_projectRoot, options) => {
					convergedRepo = options.repo;
					return { desiredCount: 0, authorityOk: true, activeOwnerCount: 0, executionOk: true };
				},
			});
			expect(result.ok).toBe(true);
			expect(convergedRepo).toBe('upstream/repo');
			expect(api.rows.get('upstream/repo#12')).toMatchObject({ repo: 'upstream/repo', pr: 12 });
			expect(api.calls.some(value => value.startsWith('conflict:'))).toBe(false);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	test('hashes equivalent legacy evidence independently of enumeration order', () => {
		const first = snapshot([
			entry('zeta/repo', 2),
			entry('acme/repo', 1),
		], {
			sources: [
				{ path: 'zeta/generation.marker', content: 'g-zeta' },
				{ path: 'acme/cleanup.marker', content: 'c-acme' },
			],
		});
		const permuted = { ...first, entries: [...first.entries].reverse(), sources: [...first.sources].reverse() };
		expect(hashLegacySnapshot(permuted)).toBe(hashLegacySnapshot(first));
	});

	test('canonicalizes object keys with an explicit locale comparator', () => {
		const original = String.prototype.localeCompare;
		let comparisons = 0;
		String.prototype.localeCompare = function trackedLocaleCompare(...args) {
			comparisons += 1;
			return original.apply(this, args);
		};
		try {
			hashLegacySnapshot({ zeta: 1, alpha: 2, entries: [], sources: [] });
		} finally {
			String.prototype.localeCompare = original;
		}

		expect(comparisons).toBeGreaterThan(0);
	});

	test('binds generation and cleanup marker contents into the legacy snapshot hash', async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-legacy-marker-hash-'));
		const gitCommonDir = path.join(root, '.git');
		const monitorDir = path.join(root, '.forge', 'pr-monitor', 'acme-repo-10');
		fs.mkdirSync(monitorDir, { recursive: true });
		fs.writeFileSync(path.join(monitorDir, 'snapshot.json'), JSON.stringify({
			snapshot: { repo: 'acme/repo', pr: 10, state: 'open' },
		}));
		fs.writeFileSync(path.join(monitorDir, 'watch.pid'), '110');
		fs.writeFileSync(path.join(monitorDir, 'watch.generation'), 'generation-a');
		fs.writeFileSync(path.join(monitorDir, 'cleanup.marker'), 'cleanup-a');
		const api = authorityHarness();
		try {
			const first = defaultReadLegacySnapshot(root, { gitCommonDir, repo: 'acme/repo' });
			const firstHash = hashLegacySnapshot(first);
			fs.writeFileSync(path.join(monitorDir, 'watch.generation'), 'generation-b');
			expect(hashLegacySnapshot(defaultReadLegacySnapshot(root, { gitCommonDir, repo: 'acme/repo' })))
				.not.toBe(firstHash);
			fs.writeFileSync(path.join(monitorDir, 'watch.generation'), 'generation-a');
			fs.writeFileSync(path.join(monitorDir, 'cleanup.marker'), 'cleanup-b');
			expect(hashLegacySnapshot(defaultReadLegacySnapshot(root, { gitCommonDir, repo: 'acme/repo' })))
				.not.toBe(firstHash);

			const result = await migrateLegacyAuthority(root, {
				authority: api,
				gitCommonDir,
				repo: 'acme/repo',
				now: () => NOW,
				isAlive: () => false,
				readProviderState: async () => 'open',
			});
			expect(result).toMatchObject({ ok: true, state: 'complete' });
			expect(api.boundSnapshotHashes).toEqual([result.snapshotHash]);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	test('imports and preserves a pre-v1 terminal receipt from a real snapshot file', async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-legacy-terminal-receipt-'));
		const gitCommonDir = path.join(root, '.git');
		const monitorDir = path.join(root, '.forge', 'pr-monitor', 'acme-repo-11');
		fs.mkdirSync(monitorDir, { recursive: true });
		fs.writeFileSync(path.join(monitorDir, 'snapshot.json'), JSON.stringify({
			terminalReceiptId: 'legacy-receipt-11',
			snapshot: { repo: 'acme/repo', pr: 11, state: 'closed' },
		}));
		const api = authorityHarness();
		try {
			const result = await migrateLegacyAuthority(root, {
				authority: api,
				gitCommonDir,
				repo: 'acme/repo',
				now: () => NOW,
				isAlive: () => false,
				readProviderState: async () => 'closed',
				verifyTerminalReceipt: async () => true,
			});
			expect(result).toMatchObject({ ok: true, state: 'complete' });
			expect(api.rows.get('acme/repo#11')).toMatchObject({
				phase: 'complete', terminalReceiptId: 'legacy-receipt-11',
			});
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	test('binds a stable double snapshot and imports one canonical PR at a time in deterministic order', async () => {
		const api = authorityHarness();
		const legacy = snapshot([
			entry('zeta/repo', 2),
			entry('acme/repo', 9, { terminalReceiptId: 'receipt-9', providerState: 'closed' }),
		]);
		const result = await run(api, legacy, { verifyTerminalReceipt: async () => true });
		expect(result).toMatchObject({ ok: true, state: 'complete' });
		expect(api.calls.filter(value => /^(starting|complete):/.test(value))).toEqual([
			'complete:acme/repo#9',
			'starting:zeta/repo#2',
		]);
		expect(api.calls.indexOf('bind')).toBeLessThan(api.calls.indexOf('complete:acme/repo#9'));
		expect(api.calls.indexOf('enumerate')).toBeGreaterThan(api.calls.indexOf('starting:zeta/repo#2'));
	});

	for (const evidenceKind of ['PID', 'provider', 'receipt']) {
		test(`never binds or imports when ${evidenceKind} evidence mutates the legacy snapshot`, async () => {
			const api = authorityHarness();
			const legacy = snapshot([entry('acme/repo', 7, evidenceKind === 'receipt'
				? { terminalReceiptId: 'receipt-7', providerState: 'closed' }
				: {})]);
			let revision = 0;
			const mutate = () => {
				revision += 1;
				const field = evidenceKind === 'PID'
					? 'pid' : evidenceKind === 'provider' ? 'providerState' : 'terminalReceiptId';
				legacy.entries[0][field] = field === 'pid' ? 100 + revision : `${field}-${revision}`;
			};
			const extra = {
				readLegacySnapshot: async () => structuredClone(legacy),
				isAlive: () => {
					if (evidenceKind === 'PID') mutate();
					return false;
				},
				readProviderState: async identity => {
					if (evidenceKind === 'provider') mutate();
					return identity.providerState;
				},
				verifyTerminalReceipt: async () => {
					if (evidenceKind === 'receipt') mutate();
					return true;
				},
			};
			if (evidenceKind === 'receipt') {
				const importComplete = api.importLegacyComplete;
				api.importLegacyComplete = async (ctx, input, operationOptions) => {
					await operationOptions.verifyTerminalReceipt(input.terminalReceiptId, ctx);
					return importComplete(ctx, input, operationOptions);
				};
			}

			const result = await migrateLegacyAuthority('/repo', {
				authority: api,
				now: () => NOW,
				...extra,
			});
			expect(result).toMatchObject({ ok: false, state: 'conflict', reason: 'legacy_snapshot_changed' });
			expect(api.boundSnapshotHashes, evidenceKind).toEqual([]);
			expect(api.rows.size, evidenceKind).toBe(0);
			expect(api.calls.some(value => /^(starting|complete|blocked):/.test(value)), evidenceKind).toBe(false);
		});
	}

	test('blocks canonical terminal evidence when its durable receipt is unverified', async () => {
		const api = verifierHonoringHarness();
		let receiptChecks = 0;
		const result = await run(api, snapshot([entry('acme/repo', 8, {
			providerState: 'closed', terminalReceiptId: 'missing-receipt-8',
		})]), {
			verifyTerminalReceipt: async () => { receiptChecks += 1; return false; },
		});
		expect(result).toMatchObject({ ok: true, state: 'complete' });
		expect(api.rows.get('acme/repo#8')).toMatchObject({
			phase: 'blocked', blockReason: 'legacy_receipt_unverified',
			terminalReceiptId: 'missing-receipt-8',
		});
		expect(api.calls.some(value => value.startsWith('complete:acme/repo#8'))).toBe(false);
		expect(api.calls.some(value => value.startsWith('conflict:'))).toBe(false);
		expect(receiptChecks).toBe(1);
	});

	test('blocks canonical open evidence when provider verification fails', async () => {
		const api = verifierHonoringHarness();
		let providerChecks = 0;
		const result = await run(api, snapshot([entry('acme/repo', 9)]), {
			ownerOptions: {
				verifyProviderEvidence: async () => { providerChecks += 1; return false; },
			},
		});
		expect(result).toMatchObject({ ok: true, state: 'complete' });
		expect(api.rows.get('acme/repo#9')).toMatchObject({
			phase: 'blocked', blockReason: 'legacy_unreadable',
		});
		expect(api.calls.some(value => value.startsWith('starting:acme/repo#9'))).toBe(false);
		expect(api.calls.some(value => value.startsWith('conflict:'))).toBe(false);
		expect(providerChecks).toBe(1);
	});

	test('keeps the migration gate quarantined when provider evidence is unreadable, then retries', async () => {
		const api = verifierHonoringHarness();
		let providerAvailable = false;
		const options = {
			readProviderState: async () => providerAvailable ? 'open' : null,
			ownerOptions: { verifyProviderEvidence: async () => true },
		};
		const first = await run(api, snapshot([entry('acme/repo', 11)]), options);
		expect(first).toMatchObject({ ok: false, state: 'quarantined', reason: 'legacy_provider_unreadable' });
		expect(api.rows.has('acme/repo#11')).toBe(false);
		expect(api.calls.some(value => value.startsWith('blocked:acme/repo#11'))).toBe(false);
		expect(api.calls.some(value => value === 'complete-gate')).toBe(false);

		providerAvailable = true;
		const second = await run(api, snapshot([entry('acme/repo', 11)]), options);
		expect(second).toMatchObject({ ok: true, state: 'complete' });
		expect(api.rows.get('acme/repo#11')).toMatchObject({ phase: 'starting' });
	});

	test('retries provider-unreadable migration against the real SQLite owner authority', async () => {
		for (const failure of ['null', 'throw']) {
			const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-migration-retry-'));
			const driver = createBuiltinSQLiteDriver({ databasePath: path.join(root, 'forge', 'kernel.sqlite') });
			try {
				await driver.exec(`
					CREATE TABLE kernel_pr_watch_owners (
						repo TEXT NOT NULL, pr INTEGER NOT NULL, version INTEGER NOT NULL,
						generation TEXT NOT NULL, phase TEXT NOT NULL, controller_pid INTEGER,
						watcher_pid INTEGER, started_at TEXT NOT NULL, updated_at TEXT NOT NULL,
						heartbeat_at TEXT, terminal_receipt_id TEXT, block_reason TEXT,
						legacy_evidence_hash TEXT, PRIMARY KEY (repo, pr)
					);
					CREATE TABLE kernel_pr_watch_migration_gate (
						singleton INTEGER NOT NULL PRIMARY KEY, state TEXT NOT NULL,
						snapshot_hash TEXT, conflict_code TEXT, updated_at TEXT NOT NULL
					);
				`);
				let providerAvailable = false;
				const legacy = snapshot([entry('acme/repo', 12)]);
				const options = {
					authority: watchOwnerAuthority,
					driver,
					now: () => NOW,
					readLegacySnapshot: async () => structuredClone(legacy),
					isAlive: () => false,
					readProviderState: async () => {
						if (providerAvailable) return 'open';
						if (failure === 'throw') throw new Error('provider unavailable');
						return null;
					},
					ownerOptions: { now: NOW, verifyProviderEvidence: async () => true },
				};
			const first = await migrateLegacyAuthority('/repo', options);
			expect(first).toMatchObject({ ok: false, state: 'quarantined', reason: 'legacy_provider_unreadable' });
			expect(await driver.queryAll('SELECT phase FROM kernel_pr_watch_owners')).toEqual([]);
			expect(await driver.queryAll('SELECT state FROM kernel_pr_watch_migration_gate')).toEqual([{ state: 'quarantined' }]);

			providerAvailable = true;
			const second = await migrateLegacyAuthority('/repo', options);
			expect(second).toMatchObject({ ok: true, state: 'complete' });
			expect(await driver.queryAll('SELECT phase FROM kernel_pr_watch_owners')).toEqual([{ phase: 'starting' }]);
			expect(await driver.queryAll('SELECT state FROM kernel_pr_watch_migration_gate')).toEqual([{ state: 'complete' }]);
			} finally {
				driver.close();
				fs.rmSync(root, { recursive: true, force: true });
			}
		}
	});

	for (const pidFailure of ['unknown', 'throw']) {
		test(`blocks canonical evidence when its PID probe is ${pidFailure}`, async () => {
			const api = verifierHonoringHarness();
			const result = await run(api, snapshot([entry('acme/repo', 10)]), {
				isAlive: () => {
					if (pidFailure === 'throw') throw new Error('PID probe unavailable');
					return null;
				},
			});
			expect(result).toMatchObject({ ok: true, state: 'complete' });
			expect(api.rows.get('acme/repo#10')).toMatchObject({
				phase: 'blocked', blockReason: 'legacy_unreadable',
			});
			expect(api.calls.some(value => value.startsWith('conflict:'))).toBe(false);
		});
	}

	test('coalesces duplicate legacy sources into one transaction per canonical PR', async () => {
		const api = authorityHarness();
		const duplicate = entry('acme/repo', 7);
		const result = await run(api, snapshot([duplicate, { ...duplicate }]));
		expect(result).toMatchObject({ ok: true, state: 'complete' });
		expect(api.calls.filter(value => value === 'starting:acme/repo#7')).toHaveLength(1);
	});

	test('turns conflicting lifecycle evidence for a mapped PR into one blocked row', async () => {
		const api = authorityHarness();
		const result = await run(api, snapshot([
			entry('acme/repo', 7, { pid: 107 }),
			entry('acme/repo', 7, { pid: 207 }),
		]));
		expect(result).toMatchObject({ ok: true, state: 'complete' });
		expect(api.calls).toContain('blocked:acme/repo#7:legacy_conflict');
		expect(api.calls.filter(value => /^(starting|complete|blocked):acme\/repo#7/.test(value))).toHaveLength(1);
	});

	test('keeps the migration gate in conflict when any conflicting legacy PID is live', async () => {
		const api = authorityHarness();
		const result = await run(api, snapshot([
			entry('acme/repo', 7, { pid: 107 }),
			entry('acme/repo', 7, { pid: 207 }),
		]), { isAlive: pid => pid === 207 });
		expect(result).toMatchObject({ ok: false, state: 'conflict', reason: 'legacy_owner_conflict' });
		expect(api.rows.size).toBe(0);
		expect(api.calls).toContain('conflict:legacy_owner_conflict');
	});

	test('refuses gate completion when the durable owner reread differs from the inserted row', async () => {
		const api = authorityHarness();
		const enumerate = api.enumerateOwners;
		api.enumerateOwners = async (...args) => {
			const result = await enumerate(...args);
			return { ...result, records: result.records.map(row => ({ ...row, phase: 'complete' })) };
		};
		const result = await run(api, snapshot([entry('acme/repo', 7)]));
		expect(result).toMatchObject({ ok: false, state: 'quarantined', reason: 'legacy_reread_mismatch' });
		expect(api.calls).not.toContain('complete-gate');
	});

	test('refuses gate completion when the durable owner reread contains an extra row', async () => {
		const api = authorityHarness();
		api.rows.set('other/repo#99', { repo: 'other/repo', pr: 99 });
		const result = await run(api, snapshot([]));
		expect(result).toMatchObject({ ok: false, state: 'quarantined', reason: 'legacy_reread_mismatch' });
		expect(api.calls).not.toContain('complete-gate');
	});

	test('publishes identity-unmappable conflict without fabricating an owner row', async () => {
		const api = authorityHarness();
		const result = await run(api, snapshot([], { unmappable: true }));
		expect(result).toMatchObject({ ok: false, state: 'conflict', reason: 'legacy_identity_unmappable' });
		expect(api.rows.size).toBe(0);
		expect(api.calls).toContain('conflict:legacy_identity_unmappable');
	});

	for (const invalidKind of ['unmappable', 'corrupt']) {
		test(`retries a transient first ${invalidKind} snapshot before publishing conflict`, async () => {
			const api = authorityHarness();
			const invalid = snapshot([], { [invalidKind]: true });
			const canonical = snapshot([]);
			const reads = [invalid, canonical, canonical, canonical, canonical];
			const result = await migrateLegacyAuthority('/repo', {
				authority: api,
				now: () => NOW,
				readLegacySnapshot: async () => structuredClone(reads.shift()),
			});
			expect(result).toMatchObject({ ok: true, state: 'complete' });
			expect(api.calls.some(value => value.startsWith('conflict:'))).toBe(false);
			expect(api.rows.size).toBe(0);
			expect(reads).toHaveLength(0);
		});

		test(`requires two equal ${invalidKind} snapshots before publishing conflict`, async () => {
			const api = authorityHarness();
			let reads = 0;
			const result = await migrateLegacyAuthority('/repo', {
				authority: api,
				now: () => NOW,
				readLegacySnapshot: async () => {
					reads += 1;
					return snapshot([], { [invalidKind]: true });
				},
			});
			expect(result).toMatchObject({
				ok: false,
				state: 'conflict',
				reason: invalidKind === 'unmappable' ? 'legacy_identity_unmappable' : 'legacy_owner_conflict',
			});
			expect(reads).toBe(2);
			expect(api.boundSnapshotHashes).toEqual([]);
			expect(api.rows.size).toBe(0);
		});
	}

	test('retries three unstable snapshots then fails closed', async () => {
		const api = authorityHarness();
		let version = 0;
		const result = await migrateLegacyAuthority('/repo', {
			authority: api,
			now: () => NOW,
			readLegacySnapshot: async () => snapshot([entry('acme/repo', 1, { pid: version += 1 })]),
			isAlive: () => false,
			readProviderState: async () => 'open',
		});
		expect(result).toMatchObject({ ok: false, state: 'conflict', reason: 'legacy_snapshot_changed' });
		expect(api.rows.size).toBe(0);
		expect(api.calls).toContain('conflict:legacy_snapshot_changed');
	});

	for (const corruptSource of ['shepherd.lock', 'snapshot.json']) {
		test(`fails closed on a malformed real ${corruptSource} without owner lifecycle or cleanup`, async () => {
			const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-corrupt-legacy-source-'));
			const gitCommonDir = path.join(root, '.git');
			if (corruptSource === 'shepherd.lock') {
				const forgeDir = path.join(gitCommonDir, 'forge');
				fs.mkdirSync(forgeDir, { recursive: true });
				fs.writeFileSync(path.join(forgeDir, corruptSource), '{');
			} else {
				const monitorDir = path.join(root, '.forge', 'pr-monitor', 'acme-repo-7');
				fs.mkdirSync(monitorDir, { recursive: true });
				fs.writeFileSync(path.join(monitorDir, corruptSource), '{');
			}
			const api = authorityHarness();
			let converged = 0;
			let cleaned = 0;
			try {
				const result = await runDaemon(root, {
					gitCommonDir,
					repo: 'acme/repo',
					authority: api,
					broker: {},
					driver: {},
					once: true,
					acquire: () => ({ ok: true, token: 'lease-token' }),
					startHeartbeat: () => null,
					stopHeartbeat: () => {},
					release: () => {},
					exit: () => {},
					convergeOnce: async () => { converged += 1; },
					cleanupLegacyEvidence: async () => { cleaned += 1; },
				});
				expect(result).toMatchObject({ ok: false, reason: 'legacy_owner_conflict' });
				expect({ converged, cleaned }).toEqual({ converged: 0, cleaned: 0 });
				expect(api.rows.size).toBe(0);
				expect(api.calls).toContain('conflict:legacy_owner_conflict');
				expect(api.calls.some(value => /^(starting|complete|blocked):/.test(value))).toBe(false);
			} finally {
				fs.rmSync(root, { recursive: true, force: true });
			}
		});
	}

	test('resumes idempotently after a crash between per-PR inserts', async () => {
		const options = { crashImportAt: 2 };
		const api = authorityHarness(options);
		const legacy = snapshot([entry('acme/repo', 1), entry('acme/repo', 2)]);
		await expect(run(api, legacy)).rejects.toThrow('simulated crash');
		expect(api.rows.size).toBe(1);
		options.crashImportAt = 0;
		const resumed = await run(api, legacy);
		expect(resumed).toMatchObject({ ok: true, state: 'complete' });
		expect(api.rows.size).toBe(2);
	});

	test('resumes after all imports but before gate completion without replacing generations', async () => {
		const options = { crashBeforeCompleteOnce: true };
		const api = authorityHarness(options);
		const legacy = snapshot([entry('acme/repo', 1), entry('acme/repo', 2)]);
		await expect(run(api, legacy)).rejects.toThrow('simulated pre-complete crash');
		const generations = [...api.rows.values()].map(row => row.generation);
		expect(generations).toHaveLength(2);

		const resumed = await run(api, legacy);
		expect(resumed).toMatchObject({ ok: true, state: 'complete' });
		expect([...api.rows.values()].map(row => row.generation)).toEqual(generations);
		expect(new Set(generations).size).toBe(2);
	});

	test('pins a missing legacy started-at to the durable quarantine timestamp across crash resume', async () => {
		const options = { crashBeforeCompleteOnce: true };
		const api = authorityHarness(options);
		const legacy = snapshot([entry('acme/repo', 1, { startedAt: null })]);
		const firstNow = Date.parse('2026-08-20T01:00:00.000Z');
		const secondNow = Date.parse('2026-08-20T02:00:00.000Z');
		const runAt = now => migrateLegacyAuthority('/repo', {
			authority: api,
			now: () => now,
			readLegacySnapshot: async () => structuredClone(legacy),
			isAlive: () => false,
			readProviderState: async identity => identity.providerState,
		});

		await expect(runAt(firstNow)).rejects.toThrow('simulated pre-complete crash');
		const startedAt = api.rows.get('acme/repo#1')?.startedAt;
		expect(startedAt).toBe(new Date(firstNow).toISOString());
		const resumed = await runAt(secondNow);
		expect(resumed).toMatchObject({ ok: true, state: 'complete' });
		expect(api.rows.get('acme/repo#1')?.startedAt).toBe(startedAt);
	});

	test('does not import before a successful hash bind', async () => {
		const options = { failBindOnce: true };
		const api = authorityHarness(options);
		const legacy = snapshot([entry('acme/repo', 1)]);
		const failed = await run(api, legacy);
		expect(failed).toMatchObject({ ok: false, state: 'conflict', reason: 'authority_unavailable' });
		expect(api.rows.size).toBe(0);
		const resumed = await run(api, legacy);
		expect(resumed).toMatchObject({ ok: true, state: 'complete' });
	});

	test('keeps a live legacy PID blocked and never starts it', async () => {
		const api = authorityHarness();
		const legacy = snapshot([entry('acme/repo', 1)]);
		const result = await run(api, legacy, { isAlive: () => true });
		expect(result).toMatchObject({ ok: true, state: 'complete' });
		expect(api.calls).toContain('blocked:acme/repo#1:legacy_live_pid');
		expect(api.calls.some(value => value.startsWith('starting:'))).toBe(false);
	});

	test('preserves a verified terminal receipt while its legacy PID remains live', async () => {
		const api = authorityHarness();
		const result = await run(api, snapshot([entry('acme/repo', 2, {
			terminalReceiptId: 'receipt-2', providerState: 'closed',
		})]), {
			isAlive: () => true,
			readProviderState: async () => 'closed',
			verifyTerminalReceipt: async () => true,
		});
		expect(result).toMatchObject({ ok: true, state: 'complete' });
		expect(api.rows.get('acme/repo#2')).toMatchObject({
			phase: 'blocked', blockReason: 'legacy_live_pid', terminalReceiptId: 'receipt-2',
		});
	});

	test('verifies dead legacy PR provider state outside the import transaction before starting', async () => {
		const api = authorityHarness();
		const legacy = snapshot([entry('acme/repo', 3, { providerState: null })]);
		const order = [];
		const originalImport = api.importLegacyStarting;
		api.importLegacyStarting = async (...args) => {
			order.push('import');
			return originalImport(...args);
		};
		const result = await run(api, legacy, {
			readProviderState: async identity => {
				order.push(`provider:${identity.repo}#${identity.pr}`);
				return 'open';
			},
		});
		expect(result).toMatchObject({ ok: true, state: 'complete' });
		expect(order).toEqual(['provider:acme/repo#3', 'import']);
		expect(api.rows.get('acme/repo#3')).toMatchObject({ phase: 'starting', controllerPid: 103 });
	});

	test('uses fresh provider evidence instead of trusting the legacy snapshot state', async () => {
		const api = authorityHarness();
		const legacy = snapshot([entry('acme/repo', 4, {
			providerState: 'closed', terminalReceiptId: 'receipt-4',
		})]);
		const result = await run(api, legacy, { readProviderState: async () => 'open' });
		expect(result).toMatchObject({ ok: true, state: 'complete' });
		expect(api.calls).toContain('starting:acme/repo#4');
		expect(api.calls).not.toContain('complete:acme/repo#4');
	});

	test('retries cleanup after the gate is already complete only when the source hash still matches', async () => {
		const api = authorityHarness();
		const legacy = snapshot([]);
		let cleanupCalls = 0;
		const first = await run(api, legacy, {
			cleanupLegacyEvidence: async () => { cleanupCalls += 1; throw new Error('crash during cleanup'); },
		});
		expect(first).toMatchObject({ ok: true, state: 'complete', cleanupPending: true });
		const second = await run(api, legacy, {
			cleanupLegacyEvidence: async value => {
				cleanupCalls += 1;
				expect(hashLegacySnapshot(value)).toBe(hashLegacySnapshot(legacy));
			},
		});
		expect(second).toMatchObject({ ok: true, state: 'complete' });
		expect(cleanupCalls).toBe(2);
	});
});
