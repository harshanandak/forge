'use strict';

const { describe, test, expect, beforeEach, afterEach } = require('bun:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { runIssueOperation } = require('../../lib/forge-issues');
const { createLocalBroker } = require('../../lib/kernel/broker');
const { createBuiltinSQLiteDriver } = require('../../lib/kernel/sqlite-driver');
const { runJsonlProjectionConsumer } = require('../../lib/kernel/projection-jsonl-writer');

// Deterministic local-ok classifier: keeps these DB-acceptance tests independent
// of the host filesystem class and avoids the real Windows drive probe the D19
// gate runs in the broker getConfig() chokepoint.
const LOCAL_OK_CLASSIFIER = () => ({
	class: 'local-ok', riskTier: 'safe', signal: 'test-stub', remediationKey: 'local-ok',
});

// Windows releases the SQLite WAL/SHM mmap sidecars asynchronously after close, so
// a teardown rmSync can race the unmap and throw EBUSY/EPERM (worse for the heavy
// 13-op test). Retry with a REAL timer yield (a sync spin would block the very
// thread that finalizes the unmap), then tolerate a final lock error only — the OS
// reclaims temp dirs, so a Windows file race must not fail an otherwise-green test.
// A non-lock error is a genuine bug and still rethrows. POSIX removes first try.
async function removeDirWithRetry(dir, attempts = 10) {
	for (let attempt = 0; attempt < attempts; attempt += 1) {
		try {
			fs.rmSync(dir, { recursive: true, force: true });
			return;
		} catch (error) {
			const locked = ['EBUSY', 'EPERM', 'ENOTEMPTY'].includes(error.code);
			if (!locked || attempt === attempts - 1) {
				if (locked) return;
				throw error;
			}
			await new Promise(resolve => setTimeout(resolve, 100));
		}
	}
}

// Wave 5 (K-DRV): acceptance smoke. Drives ALL 13 issue ops through the PUBLIC
// entry point — forge-issues.runIssueOperation(op, args, projectRoot, deps) with
// deps.issueBackend='kernel' + kernelDatabasePath — against the REAL SQLite driver,
// proving the full read + guarded-mutation surface answers contract-shaped results
// end-to-end. A second focused test exercises the projection-outbox primitives the
// 13 ops never reach (the consumer drains pending rows → marks delivered).
//
// Note (recorded finding): forge-issues.runIssueOperation does NOT call
// broker.initialize() — production callers must migrate the kernel DB at setup.
// The smoke test migrates once through a setup broker that SHARES the driver
// instance (the driver caches its connection), so the per-op brokers built from
// kernelDatabasePath see the already-migrated tables.
describe('Kernel SQLite driver — acceptance smoke through the public entry point (Wave 5)', () => {
	let tmpDir;
	let dbPath;
	let projectRoot;
	let driver;
	let deps;
	const now = '2026-06-20T00:00:00.000Z';

	beforeEach(async () => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kdrv-smoke-'));
		dbPath = path.join(tmpDir, 'kernel.sqlite');
		projectRoot = tmpDir;
		// Share ONE driver: createBuiltinSQLiteDriver({}) has no configured path, so it
		// adopts config.databasePath and caches the open connection for the run.
		driver = createBuiltinSQLiteDriver({});
		const execFileSync = () => path.join(tmpDir, '.git');
		// Deterministic FS classifier: this is an acceptance test for the 13 DB ops,
		// NOT for the D19 filesystem gate. Injecting a local-ok stub keeps it
		// independent of the host's actual filesystem class (a tmpdir on a network
		// mount would otherwise REFUSE) and avoids the real per-broker Windows drive
		// probe (net use + PowerShell) that the gate now runs in getConfig().
		const classifyFilesystem = LOCAL_OK_CLASSIFIER;

		// Migrate once: the public entry point never initializes the broker.
		const setup = createLocalBroker({
			projectRoot,
			execFileSync,
			databasePath: dbPath,
			driver,
			classifyFilesystem,
		});
		await setup.initialize();

		// The deps the task names — issueBackend + kernelDatabasePath select the kernel
		// backend; kernelDriver/execFileSync are the mechanically-required plumbing
		// (no default driver; resolveGitCommonDir runs against projectRoot otherwise).
		// classifyFilesystem is forwarded into each per-op broker (forge-issues).
		deps = {
			issueBackend: 'kernel',
			kernelDatabasePath: dbPath,
			kernelDriver: driver,
			execFileSync,
			classifyFilesystem,
		};
	});

	afterEach(async () => {
		if (driver) driver.close();
		// Windows can briefly hold a lock on the WAL/SHM sidecar files after close;
		// retry the temp-dir removal (async yield) rather than failing on EBUSY.
		if (tmpDir) await removeDirWithRetry(tmpDir);
	});

	function op(operation, args, ctx = {}) {
		return runIssueOperation(operation, args, projectRoot, { ...deps, ...ctx });
	}

	test('all 13 issue ops answer ok-shaped results in sequence', async () => {
		// 1. create — the issue under test.
		const created = await op('create', ['--id', 'smoke-1', '--title', 'Primary', '--type', 'task'], { now, actor: 'tester' });
		expect(created.ok).toBe(true);
		expect(created.command).toBe('issue.create');
		expect(created.data.id).toBe('smoke-1');
		expect(created.data.revision).toBe(0);

		// A second issue so dep.add/dep.remove have a valid FK-constrained blocker
		// (a self-edge would trip the cycle guard → quarantine → not ok).
		const blocker = await op('create', ['--id', 'smoke-2', '--title', 'Blocker', '--type', 'task'], { now, actor: 'tester' });
		expect(blocker.ok).toBe(true);

		// 2. list — both issues present.
		const listed = await op('list', [], { now });
		expect(listed.ok).toBe(true);
		expect(listed.command).toBe('issue.list');
		expect(listed.data.issues.map(issue => issue.id).sort()).toEqual(['smoke-1', 'smoke-2']);

		// 3. ready — unblocked issues are ready.
		const ready = await op('ready', [], { now });
		expect(ready.ok).toBe(true);
		expect(ready.command).toBe('issue.ready');
		expect(ready.data.issues.map(issue => issue.id)).toContain('smoke-1');

		// 4. show — single contract-shaped issue.
		const shown = await op('show', ['smoke-1'], { now });
		expect(shown.ok).toBe(true);
		expect(shown.command).toBe('issue.show');
		expect(shown.data).toMatchObject({ id: 'smoke-1', title: 'Primary', status: 'open', revision: 0 });

		// 5. update — bumps the revision.
		const updated = await op('update', ['smoke-1', '--status', 'in_progress'], { now: '2026-06-20T00:01:00.000Z', actor: 'tester' });
		expect(updated.ok).toBe(true);
		expect(updated.command).toBe('issue.update');
		expect(updated.data.revision).toBe(1);

		// 6. comment — appends a comment, returns comment_id.
		const commented = await op('comment', ['smoke-1', 'A handoff note'], { now: '2026-06-20T00:02:00.000Z', actor: 'tester' });
		expect(commented.ok).toBe(true);
		expect(commented.command).toBe('issue.comment');
		expect(typeof commented.data.comment_id).toBe('string');
		expect(commented.data.comment_id.length).toBeGreaterThan(0);

		// 7. claim — acquires an active lease, returns claim_id.
		const claimed = await op('claim', ['--issue', 'smoke-1'], { now: '2026-06-20T00:03:00.000Z', actor: 'alice' });
		expect(claimed.ok).toBe(true);
		expect(claimed.command).toBe('claim');
		expect(typeof claimed.data.claim_id).toBe('string');
		expect(claimed.data.claim_id.length).toBeGreaterThan(0);

		// 8. release — clears the lease (must follow claim).
		const released = await op('release', ['--issue', 'smoke-1'], { now: '2026-06-20T00:04:00.000Z', actor: 'alice' });
		expect(released.ok).toBe(true);
		expect(released.command).toBe('release');
		expect(typeof released.data.claim_id).toBe('string');

		// 9. dep.add — smoke-1 blocked by smoke-2, returns dependency_id.
		const depAdded = await op('dep.add', ['--issue', 'smoke-1', '--blocks', 'smoke-2'], { now: '2026-06-20T00:05:00.000Z', actor: 'tester' });
		expect(depAdded.ok).toBe(true);
		expect(depAdded.command).toBe('issue.dep.add');
		expect(typeof depAdded.data.dependency_id).toBe('string');
		expect(depAdded.data.dependency_id.length).toBeGreaterThan(0);

		// 10. dep.remove — restores the edge (must follow dep.add).
		const depRemoved = await op('dep.remove', ['--issue', 'smoke-1', '--blocks', 'smoke-2'], { now: '2026-06-20T00:06:00.000Z', actor: 'tester' });
		expect(depRemoved.ok).toBe(true);
		expect(depRemoved.command).toBe('issue.dep.remove');
		expect(typeof depRemoved.data.dependency_id).toBe('string');

		// 11. search — title/body LIKE match.
		const searched = await op('search', ['Primary'], { now });
		expect(searched.ok).toBe(true);
		expect(searched.command).toBe('issue.search');
		expect(searched.data.issues.map(issue => issue.id)).toContain('smoke-1');

		// 12. stats — aggregate counts.
		const stats = await op('stats', [], { now });
		expect(stats.ok).toBe(true);
		expect(stats.command).toBe('issue.stats');
		expect(typeof stats.data.counts).toBe('object');

		// 13. close — terminal status, bumps the revision again.
		const closed = await op('close', ['smoke-1'], { now: '2026-06-20T00:07:00.000Z', actor: 'tester' });
		expect(closed.ok).toBe(true);
		expect(closed.command).toBe('issue.close');
		expect(closed.data.revision).toBe(2);
	});

	test('projection-outbox primitives drain pending rows through the real driver', async () => {
		// Each accepted mutation enqueues a pending kernel_outbox row. Run the JSONL
		// consumer against a broker built from the SAME shared driver: it lists pending
		// rows (target/status/now filtered), loads the projection model, writes a
		// snapshot, and marks the drained rows delivered — exercising 3 of the 5 new
		// primitives end-to-end against the real SQLite driver.
		await op('create', ['--id', 'proj-1', '--title', 'Projected', '--type', 'task'], { now, actor: 'tester' });
		await op('comment', ['proj-1', 'note'], { now: '2026-06-20T00:01:00.000Z', actor: 'tester' });

		const consumerBroker = createLocalBroker({
			projectRoot,
			execFileSync: () => path.join(tmpDir, '.git'),
			databasePath: dbPath,
			driver,
			classifyFilesystem: LOCAL_OK_CLASSIFIER,
		});

		const projectionDir = path.join(tmpDir, 'projection');
		const result = await runJsonlProjectionConsumer({
			broker: consumerBroker,
			projectionDir,
			projectRoot,
			now: '2026-06-20T00:10:00.000Z',
			target: 'beads', // commitGuardedAccept defaults the outbox target to 'beads'
		});

		expect(result.written).toBe(true);
		expect(result.drained).toBeGreaterThanOrEqual(2);
		expect(result.delivered.length).toBe(result.drained);
		expect(result.dead).toEqual([]);
		expect(result.retried).toEqual([]);

		// Drained rows are now delivered, so a second drain finds nothing pending.
		const second = await runJsonlProjectionConsumer({
			broker: consumerBroker,
			projectionDir,
			projectRoot,
			now: '2026-06-20T00:11:00.000Z',
			target: 'beads',
		});
		expect(second.drained).toBe(0);
		expect(second.written).toBe(false);
	});

	test('recordProjectionFailure keeps a row pending under backoff and deadLetterProjection retires it', async () => {
		// Drive the failure + dead-letter primitives directly against the real driver
		// (the consumer only reaches them on a write error). Enqueue one pending row,
		// then prove: (a) a failure with a FUTURE next_attempt_at hides the row from a
		// now-gated list, and (b) dead-lettering inserts a dead_letters row and flips
		// the outbox row out of pending so it is never re-drained.
		await op('create', ['--id', 'fail-1', '--title', 'Fails', '--type', 'task'], { now, actor: 'tester' });

		const consumerBroker = createLocalBroker({
			projectRoot,
			execFileSync: () => path.join(tmpDir, '.git'),
			databasePath: dbPath,
			driver,
			classifyFilesystem: LOCAL_OK_CLASSIFIER,
		});

		const pending = await consumerBroker.listProjectionOutbox({ target: 'beads', status: 'pending', now: '2026-06-20T00:10:00.000Z' });
		expect(pending.length).toBe(1);
		const row = pending[0];

		await consumerBroker.recordProjectionFailure({
			id: row.id,
			attempts: 1,
			next_attempt_at: '2026-06-20T01:00:00.000Z',
			error: 'boom',
			now: '2026-06-20T00:10:00.000Z',
		});

		// The row is still pending but in backoff — a now-gated list before the
		// backoff elapses must NOT return it.
		const beforeBackoff = await consumerBroker.listProjectionOutbox({ target: 'beads', status: 'pending', now: '2026-06-20T00:30:00.000Z' });
		expect(beforeBackoff.map(entry => entry.id)).not.toContain(row.id);
		// After the backoff elapses, the row is eligible again.
		const afterBackoff = await consumerBroker.listProjectionOutbox({ target: 'beads', status: 'pending', now: '2026-06-20T02:00:00.000Z' });
		expect(afterBackoff.map(entry => entry.id)).toContain(row.id);

		// Dead-letter it: a dead_letters row is inserted and the outbox row leaves
		// 'pending' so it is never re-drained.
		const dead = await consumerBroker.deadLetterProjection({
			outbox_id: row.id,
			target: 'beads',
			error: 'boom',
			payload_json: JSON.stringify({ event_id: row.event_id, attempts: 5 }),
			now: '2026-06-20T02:00:00.000Z',
		});
		expect(typeof dead.id).toBe('string');
		expect(dead.id.length).toBeGreaterThan(0);

		const deadLetters = await driver.queryAll('SELECT * FROM kernel_dead_letters', { databasePath: dbPath });
		expect(deadLetters).toHaveLength(1);
		expect(deadLetters[0].outbox_id).toBe(row.id);

		const stillPending = await consumerBroker.listProjectionOutbox({ target: 'beads', status: 'pending', now: '2026-06-20T03:00:00.000Z' });
		expect(stillPending.map(entry => entry.id)).not.toContain(row.id);
	});
});
