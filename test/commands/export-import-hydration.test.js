'use strict';

// JSONL → Kernel HYDRATION (the reverse of the D16 export projection).
//
// `forge export --import` must READ the committed `.forge/kernel/*.jsonl` snapshot
// and WRITE it into a fresh kernel.sqlite (the DB is never cloned). These tests use
// the REAL projection writer (writeProjection — the exact bytes `forge export`
// produces) to author a snapshot, then hydrate a SEPARATE, empty kernel DB (the
// "fresh clone") through the real export handler + a real local broker, and assert
// the issues/comments/dependencies are restored with fidelity. Idempotency,
// versioned-manifest refusal, and the no-broker message are covered too.

const { describe, test, expect } = require('bun:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createLocalBroker } = require('../../lib/kernel/broker');
const { createBuiltinSQLiteDriver } = require('../../lib/kernel/sqlite-driver');
const { writeProjection } = require('../../lib/kernel/projection-jsonl-writer');
const exportCommand = require('../../lib/commands/export');

const NOW = '2026-07-03T00:00:00.000Z';

// Deterministic local-ok classifier: keeps DB acceptance independent of the host
// filesystem class (mirrors export-real-dispatch.test.js).
const LOCAL_OK_CLASSIFIER = () => ({
	class: 'local-ok', riskTier: 'safe', signal: 'test-stub', remediationKey: 'local-ok',
});

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

// A fresh, empty kernel broker over its own DB file but the SAME projectRoot — the
// "fresh clone": DB absent, committed JSONL present. Each broker owns its driver so
// closing one never unmaps another's connection.
async function freshBroker(projectRoot, databasePath) {
	const driver = createBuiltinSQLiteDriver({});
	const broker = createLocalBroker({
		projectRoot,
		execFileSync: () => path.join(projectRoot, '.git'),
		databasePath,
		driver,
		classifyFilesystem: LOCAL_OK_CLASSIFIER,
	});
	await broker.initialize();
	return { broker, driver };
}

const FIXTURE_MODEL = {
	issues: [
		{
			id: 'hydr-1', title: 'Parent', body: 'the parent body', type: 'task',
			status: 'in_progress', priority: 'P1', priority_rank: 10,
			created_by: 'alice@example.com', created_at: NOW, updated_at: NOW, entity_revision: 3,
		},
		{
			id: 'hydr-2', title: 'Child', body: null, type: 'bug',
			status: 'open', priority: 'P2', priority_rank: 0,
			created_by: 'bob', created_at: NOW, updated_at: NOW, entity_revision: 1,
		},
	],
	comments: [
		{ id: 'cmt-1', issue_id: 'hydr-1', body: 'a note', actor: 'carol', visibility: 'public', created_at: NOW },
	],
	dependencies: [
		{ id: 'dep-1', issue_id: 'hydr-2', blocks_issue_id: 'hydr-1', dependency_type: 'blocks', created_at: NOW },
	],
};

describe('forge export --import — JSONL → kernel hydration', () => {
	test('a fresh clone (empty DB + committed JSONL) restores issues/comments/deps with fidelity', async () => {
		const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-hydrate-'));
		const projectionDir = path.join(projectRoot, '.forge', 'kernel');
		// Author the committed snapshot exactly as `forge export` would.
		writeProjection({ model: FIXTURE_MODEL, projectionDir });

		const { broker, driver } = await freshBroker(projectRoot, path.join(projectRoot, 'kernel-fresh.sqlite'));
		try {
			// Sanity: the fresh clone starts empty.
			const before = await broker.loadProjectionModel();
			expect(before.issues).toHaveLength(0);

			const result = await exportCommand.handler(['--import'], {}, projectRoot, { _broker: broker, _now: NOW });

			expect(result.success).toBe(true);
			expect(result.imported).toBe(true);
			expect(result.counts.issues.inserted).toBe(2);
			expect(result.counts.comments.inserted).toBe(1);
			expect(result.counts.dependencies.inserted).toBe(1);

			// The fresh DB now holds the issues with fidelity.
			const after = await broker.loadProjectionModel();
			const byId = Object.fromEntries(after.issues.map(i => [i.id, i]));
			expect(after.issues).toHaveLength(2);
			expect(byId['hydr-1'].status).toBe('in_progress');
			expect(byId['hydr-1'].priority).toBe('P1');
			expect(byId['hydr-1'].body).toBe('the parent body');
			expect(byId['hydr-1'].created_by).toBe('alice@example.com');
			expect(byId['hydr-2'].created_by).toBe('bob');
			expect(after.comments).toHaveLength(1);
			expect(after.comments[0].issue_id).toBe('hydr-1');
			expect(after.dependencies).toHaveLength(1);
			expect(after.dependencies[0].blocks_issue_id).toBe('hydr-1');
		} finally {
			driver.close();
			await removeDirWithRetry(projectRoot);
		}
	}, 15000);

	test('re-importing is idempotent — no duplicates, second run applies nothing', async () => {
		const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-hydrate-'));
		writeProjection({ model: FIXTURE_MODEL, projectionDir: path.join(projectRoot, '.forge', 'kernel') });

		const { broker, driver } = await freshBroker(projectRoot, path.join(projectRoot, 'kernel-fresh.sqlite'));
		try {
			await exportCommand.handler(['--import'], {}, projectRoot, { _broker: broker, _now: NOW });
			const second = await exportCommand.handler(['--import'], {}, projectRoot, { _broker: broker, _now: NOW });

			expect(second.success).toBe(true);
			expect(second.counts.issues.inserted).toBe(0);
			expect(second.counts.issues.skipped).toBe(2);
			expect(second.applied).toBe(0);
			// Human message must not claim it imported anything on the no-op run.
			expect(second.output.toLowerCase()).not.toMatch(/imported.*2 issues/);

			const after = await broker.loadProjectionModel();
			expect(after.issues).toHaveLength(2); // still 2, not 4
		} finally {
			driver.close();
			await removeDirWithRetry(projectRoot);
		}
	}, 15000);

	test('reports success but writes nothing when no Kernel broker is available', async () => {
		const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-hydrate-'));
		writeProjection({ model: FIXTURE_MODEL, projectionDir: path.join(projectRoot, '.forge', 'kernel') });
		try {
			const result = await exportCommand.handler(['--import'], {}, projectRoot, { _now: NOW });

			expect(result.imported).toBe(false);
			expect(result.output.toLowerCase()).toMatch(/no kernel broker|nothing (was )?written|cannot import/);
		} finally {
			await removeDirWithRetry(projectRoot);
		}
	});

	test('refuses a snapshot whose manifest schema_version is newer than we understand', async () => {
		const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-hydrate-'));
		const projectionDir = path.join(projectRoot, '.forge', 'kernel');
		writeProjection({ model: FIXTURE_MODEL, projectionDir });
		// Bump only the manifest version (content_sha256 covers the JSONL, not the
		// manifest, so it still matches — the version guard must catch this).
		const manifestPath = path.join(projectionDir, 'manifest.json');
		const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
		manifest.schema_version = 999;
		fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');

		const { broker, driver } = await freshBroker(projectRoot, path.join(projectRoot, 'kernel-fresh.sqlite'));
		try {
			const result = await exportCommand.handler(['--import'], {}, projectRoot, { _broker: broker, _now: NOW });

			expect(result.success).toBe(false);
			expect(result.error).toMatch(/schema_version|version/i);
			const after = await broker.loadProjectionModel();
			expect(after.issues).toHaveLength(0); // nothing hydrated from an incompatible snapshot
		} finally {
			driver.close();
			await removeDirWithRetry(projectRoot);
		}
	}, 15000);
});
