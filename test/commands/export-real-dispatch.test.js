'use strict';

// End-to-end proof that `forge export` actually moves a Kernel-created issue into
// git-tracked JSONL — the beads-signature portability capability (D16). Unlike
// export.test.js (which unit-tests the handler with a hand-rolled mock broker that
// seeds 'jsonl' rows and ignores the target filter), this drives the REAL dispatch:
//
//   1. `runIssueOperation('create', …)` — the real CLI Kernel mutation path, which
//      must enqueue the projection-outbox row under the target the export consumer
//      drains ('jsonl'), not the broker's legacy primitive default ('beads').
//   2. `resolveCommandOpts('export', …)` — the real command dispatcher, which must
//      inject a Kernel broker as the handler's `_broker` (it previously injected one
//      only for ISSUE_COMMANDS, so `export` silently ran with no broker).
//   3. `exportCommand.handler(…)` — the real handler draining the outbox to disk.
//
// Both fixes are load-bearing: with either missing this test is RED (no `_broker` →
// skip, or 'beads' rows → 0 drained → nothing written).

const { describe, test, expect } = require('bun:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { runIssueOperation } = require('../../lib/forge-issues');
const { createLocalBroker } = require('../../lib/kernel/broker');
const { createBuiltinSQLiteDriver } = require('../../lib/kernel/sqlite-driver');
const { resolveCommandOpts } = require('../../lib/commands/_resolve-command-opts');
const exportCommand = require('../../lib/commands/export');

const NOW = '2026-06-20T00:00:00.000Z';

// Deterministic local-ok classifier: keeps this DB-acceptance test independent of
// the host filesystem class and avoids the real Windows drive probe the D19 gate
// runs in the broker getConfig() chokepoint (mirrors driver-smoke.test.js).
const LOCAL_OK_CLASSIFIER = () => ({
	class: 'local-ok', riskTier: 'safe', signal: 'test-stub', remediationKey: 'local-ok',
});

// Windows releases the SQLite WAL/SHM sidecars asynchronously after close, so a
// teardown rmSync can race the unmap and throw EBUSY/EPERM. Retry with a real timer
// yield, then tolerate a final lock error only (the OS reclaims temp dirs).
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

describe('forge export — real dispatch (Kernel create → git-tracked JSONL)', () => {
	test('a Kernel-created issue is drained to .forge/kernel/issues.jsonl with fidelity', async () => {
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-export-real-'));
		const dbPath = path.join(tmpDir, 'kernel.sqlite');
		const projectRoot = tmpDir;
		// Share ONE driver across the setup / create / export brokers: it caches the
		// open connection keyed on config.databasePath, so every broker sees the same
		// migrated DB (the create's outbox + issue rows are visible to the exporter).
		const driver = createBuiltinSQLiteDriver({});
		const execFileSync = () => path.join(tmpDir, '.git');

		try {
			// Migrate once — the public entry point never initializes the broker.
			const setup = createLocalBroker({
				projectRoot, execFileSync, databasePath: dbPath, driver, classifyFilesystem: LOCAL_OK_CLASSIFIER,
			});
			await setup.initialize();

			const deps = {
				issueBackend: 'kernel',
				kernelDatabasePath: dbPath,
				kernelDriver: driver,
				execFileSync,
				classifyFilesystem: LOCAL_OK_CLASSIFIER,
			};

			// 1) Create through the REAL CLI Kernel mutation path.
			const created = await runIssueOperation(
				'create',
				['--id', 'portable-1', '--title', 'Portable', '--type', 'task'],
				projectRoot,
				{ ...deps, now: NOW, actor: 'tester' },
			);
			expect(created.ok).toBe(true);
			expect(created.data.id).toBe('portable-1');

			// 2) Export through the REAL dispatcher broker injection. The injected
			// factory is the same DI seam production uses; it reuses the shared driver
			// + fs-gate stub so the exporter reads the same DB the create wrote to.
			const { commandOpts } = await resolveCommandOpts('export', [], {
				projectRoot,
				databasePath: dbPath,
				buildKernelIssueDeps: async () => {
					const broker = createLocalBroker({
						projectRoot, execFileSync, databasePath: dbPath, driver, classifyFilesystem: LOCAL_OK_CLASSIFIER,
					});
					await broker.initialize();
					return { kernelBroker: broker };
				},
			});
			// Root cause #1: the dispatcher must hand the export handler a broker.
			expect(commandOpts._broker).toBeDefined();

			const result = await exportCommand.handler([], {}, projectRoot, { ...commandOpts, _now: NOW });

			// Root cause #2: the enqueued 'jsonl' marker is actually drained + written.
			expect(result.success).toBe(true);
			expect(result.exported).toBe(true);
			expect(result.drained).toBeGreaterThanOrEqual(1);

			// The issue reaches deterministic git-tracked JSONL with id + status fidelity.
			const issuesJsonl = path.join(projectRoot, '.forge', 'kernel', 'issues.jsonl');
			expect(fs.existsSync(issuesJsonl)).toBe(true);
			const lines = fs.readFileSync(issuesJsonl, 'utf8').trim().split('\n').filter(Boolean);
			const record = JSON.parse(lines[0]);
			expect(record.id).toBe('portable-1');
			expect(record.status).toBe('open');
		} finally {
			if (driver) driver.close();
			await removeDirWithRetry(tmpDir);
		}
	}, 15000);
});
