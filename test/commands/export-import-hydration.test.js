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
const crypto = require('node:crypto');
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

// Full-fidelity fixture: every kernel_issues column is populated with a non-default
// value on at least one issue, including the beads-carried fields Fable flagged as
// silently stripped (labels, assignee, closed_at, close_reason). `hydr-2` is a CLOSED
// issue so its close metadata is exercised. labels/metadata/stage_state are stored as
// the JSON *string* the driver persists (kernel_issues stores them as TEXT).
const FIXTURE_MODEL = {
	issues: [
		{
			id: 'hydr-1', title: 'Parent', body: 'the parent body', type: 'task',
			status: 'in_progress', priority: 'P1', priority_rank: 10,
			created_at: NOW, updated_at: NOW, entity_revision: 3,
			parent_id: null, sprint_id: 'sprint-7', release_id: 'rel-1', stage_state: '{"stage":"dev"}',
			labels: '["urgent","backend"]', acceptance_criteria: 'all tests pass', estimate: '3',
			design: 'design.md#parent', notes: 'internal note', assignee: 'dev@example.com',
			created_by: 'alice@example.com', closed_at: null, close_reason: null, metadata: '{"src":"seed"}',
		},
		{
			id: 'hydr-2', title: 'Child', body: null, type: 'bug',
			status: 'closed', priority: 'P2', priority_rank: 0,
			created_at: NOW, updated_at: NOW, entity_revision: 1,
			parent_id: 'hydr-1', sprint_id: null, release_id: null, stage_state: null,
			labels: '["regression"]', acceptance_criteria: null, estimate: null,
			design: null, notes: null, assignee: 'qa@example.com',
			created_by: 'bob', closed_at: NOW, close_reason: 'fixed in #42', metadata: null,
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
	test('a fresh clone restores the FULL kernel_issues column set with lossless fidelity', async () => {
		const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-hydrate-'));
		const projectionDir = path.join(projectRoot, '.forge', 'kernel');

		// Author DB: seed the full-fidelity fixture (this is exactly what
		// `forge migrate --from beads` writes), then read back the canonical rows.
		const author = await freshBroker(projectRoot, path.join(projectRoot, 'kernel-author.sqlite'));
		// Fresh clone DB: empty, but the committed JSONL survives.
		const fresh = await freshBroker(projectRoot, path.join(projectRoot, 'kernel-fresh.sqlite'));
		try {
			await author.broker.importIssues(FIXTURE_MODEL, { now: NOW });
			const authorModel = await author.broker.loadProjectionModel();
			// Author the committed snapshot exactly as `forge export` would.
			writeProjection({ model: authorModel, projectionDir });

			const before = await fresh.broker.loadProjectionModel();
			expect(before.issues).toHaveLength(0);

			const result = await exportCommand.handler(['--import'], {}, projectRoot, { _broker: fresh.broker, _now: NOW });
			expect(result.success).toBe(true);
			expect(result.counts.issues.inserted).toBe(2);
			expect(result.counts.comments.inserted).toBe(1);
			expect(result.counts.dependencies.inserted).toBe(1);

			const freshModel = await fresh.broker.loadProjectionModel();

			// Lossless: EVERY column of every issue/comment/dependency round-trips
			// identically (both sides pass through the same driver coercion).
			expect(freshModel.issues).toEqual(authorModel.issues);
			expect(freshModel.comments).toEqual(authorModel.comments);
			expect(freshModel.dependencies).toEqual(authorModel.dependencies);

			// Explicit proof for the beads-carried columns Fable flagged as stripped
			// by the v2 (11-key) projection.
			const byId = Object.fromEntries(freshModel.issues.map(i => [i.id, i]));
			expect(byId['hydr-1'].labels).toBe('["urgent","backend"]');
			expect(byId['hydr-1'].assignee).toBe('dev@example.com');
			expect(byId['hydr-1'].sprint_id).toBe('sprint-7');
			expect(byId['hydr-1'].release_id).toBe('rel-1');
			expect(byId['hydr-1'].stage_state).toBe('{"stage":"dev"}');
			expect(byId['hydr-1'].acceptance_criteria).toBe('all tests pass');
			expect(byId['hydr-1'].metadata).toBe('{"src":"seed"}');
			expect(byId['hydr-2'].closed_at).toBe(NOW);
			expect(byId['hydr-2'].close_reason).toBe('fixed in #42');
			expect(byId['hydr-2'].assignee).toBe('qa@example.com');
			expect(byId['hydr-2'].labels).toBe('["regression"]');
			expect(byId['hydr-2'].parent_id).toBe('hydr-1');
		} finally {
			author.driver.close();
			fresh.driver.close();
			await removeDirWithRetry(projectRoot);
		}
	}, 20000);

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

	test('reads older v1 and v2 snapshots under the v3 reader (missing columns hydrate as null)', async () => {
		// Backward-read compat: hand-craft older-version snapshots — v1 (11-key issues,
		// no created_by) and v2 (12-key issues, with created_by). Both must import under
		// the v3 reader; the newer columns are simply absent and hydrate as null.
		const legacy = [
			{ version: 1, issue: { kind: 'issue', id: 'v1-1', title: 'Legacy v1', body: null, type: 'task', status: 'open', priority: 'P2', priority_rank: 0, created_at: NOW, updated_at: NOW, entity_revision: 1 } },
			{ version: 2, issue: { kind: 'issue', id: 'v2-1', title: 'Legacy v2', body: null, type: 'task', status: 'open', priority: 'P2', priority_rank: 0, created_at: NOW, updated_at: NOW, entity_revision: 1, created_by: 'legacy@example.com' } },
		];

		for (const { version, issue } of legacy) {
			const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), `forge-hydrate-v${version}-`));
			const projectionDir = path.join(projectRoot, '.forge', 'kernel');
			fs.mkdirSync(projectionDir, { recursive: true });

			const issuesJsonl = JSON.stringify(issue) + '\n';
			const commentsJsonl = '';
			const depsJsonl = '';
			// Match importProjection's integrity hash: sha256 over the concatenated bytes.
			const sha = crypto.createHash('sha256').update(issuesJsonl).update(commentsJsonl).update(depsJsonl).digest('hex');
			const manifest = { schema_version: version, source: 'kernel', counts: { issues: 1, comments: 0, dependencies: 0 }, content_sha256: sha };
			fs.writeFileSync(path.join(projectionDir, 'issues.jsonl'), issuesJsonl);
			fs.writeFileSync(path.join(projectionDir, 'comments.jsonl'), commentsJsonl);
			fs.writeFileSync(path.join(projectionDir, 'dependencies.jsonl'), depsJsonl);
			fs.writeFileSync(path.join(projectionDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');

			const { broker, driver } = await freshBroker(projectRoot, path.join(projectRoot, 'kernel-fresh.sqlite'));
			try {
				const result = await exportCommand.handler(['--import'], {}, projectRoot, { _broker: broker, _now: NOW });
				expect(result.success).toBe(true);
				expect(result.counts.issues.inserted).toBe(1);

				const after = await broker.loadProjectionModel();
				expect(after.issues).toHaveLength(1);
				expect(after.issues[0].id).toBe(issue.id);
				// Columns absent from the older format hydrate as null — no error.
				expect(after.issues[0].labels).toBeNull();
				expect(after.issues[0].assignee).toBeNull();
				expect(after.issues[0].created_by).toBe(version === 2 ? 'legacy@example.com' : null);
			} finally {
				driver.close();
				await removeDirWithRetry(projectRoot);
			}
		}
	}, 20000);
});
