'use strict';

const { describe, test, expect, beforeAll, afterAll } = require('bun:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createLocalBroker } = require('../../lib/kernel/broker');
const { createBuiltinSQLiteDriver } = require('../../lib/kernel/sqlite-driver');

// Wave 1 (K-DRV): the SQLite driver's issueOperation read branch. Mutations are a
// later wave and must still throw. Acceptance for reads = contract-shaped responses
// (forge.issue.v1) with derived ready/blocked from the readiness model.
describe('Kernel SQLite driver — issueOperation reads (Wave 1)', () => {
	let tmpDir;
	let driver;
	let config;
	const now = '2026-06-19T00:00:00.000Z';

	beforeAll(async () => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kdrv-issue-'));
		const dbPath = path.join(tmpDir, 'kernel.sqlite');
		config = { databasePath: dbPath };
		driver = createBuiltinSQLiteDriver({});
		const broker = createLocalBroker({
			projectRoot: tmpDir,
			execFileSync: () => path.join(tmpDir, '.git'),
			databasePath: dbPath,
			driver,
		});
		await broker.initialize();

		await driver.exec(
			`INSERT INTO kernel_issues (id,title,type,status,priority_rank,created_at,updated_at,entity_revision) VALUES
				('k1','Alpha task','task','open',1,'${now}','${now}',0),
				('k2','Beta bug','bug','open',2,'${now}','${now}',0),
				('k3','Closed thing','task','done',3,'${now}','${now}',0);`,
			config,
		);
		// k1 depends on k2 (k2 blocks k1) — so k1 is blocked while k2 stays open.
		await driver.exec(
			`INSERT INTO kernel_dependencies (id,issue_id,blocks_issue_id,dependency_type,created_at) VALUES
				('d1','k1','k2','blocks','${now}');`,
			config,
		);
	});

	afterAll(() => {
		if (driver) driver.close();
		if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	test('list returns a contract-shaped issueList ranked by priority_rank', async () => {
		const res = await driver.issueOperation('list', [], {}, config);
		expect(res.ok).toBe(true);
		expect(res.schema_version).toBe('forge.issue.v1');
		expect(res.command).toBe('issue.list');
		expect(res.data.issues.map(issue => issue.id)).toEqual(['k1', 'k2', 'k3']);
		expect(res.data.count).toBe(3);
		expect(res.data.issues.find(issue => issue.id === 'k1')).toMatchObject({
			title: 'Alpha task', type: 'task', status: 'open', revision: 0,
		});
		expect(Array.isArray(res.next_commands)).toBe(true);
	});

	test('ready excludes blocked (k1) and closed (k3) — k2 is the only ready issue', async () => {
		const res = await driver.issueOperation('ready', [], {}, config);
		expect(res.ok).toBe(true);
		expect(res.data.issues.map(issue => issue.id)).toEqual(['k2']);
	});

	test('show returns one issue with the derived blocked flag', async () => {
		const res = await driver.issueOperation('show', ['k1'], {}, config);
		expect(res.ok).toBe(true);
		expect(res.data).toMatchObject({ id: 'k1', blocked: true, status: 'open' });
	});

	test('show on a missing id returns the notFound error shape', async () => {
		const res = await driver.issueOperation('show', ['nope'], {}, config);
		expect(res.ok).toBe(false);
		expect(res.error.code).toBe('FORGE_ISSUE_NOT_FOUND');
		expect(res.error.exit_code).toBe(3);
		expect(res.error.retryable).toBe(false);
	});

	test('search matches a title substring', async () => {
		const res = await driver.issueOperation('search', ['Beta'], {}, config);
		expect(res.data.issues.map(issue => issue.id)).toEqual(['k2']);
	});

	test('stats reports status counts plus derived ready/blocked/active_claims', async () => {
		const res = await driver.issueOperation('stats', [], {}, config);
		expect(res.ok).toBe(true);
		expect(res.data.counts).toMatchObject({ open: 2, done: 1 });
		expect(res.data.ready_count).toBe(1);
		expect(res.data.blocked_count).toBe(1);
		expect(res.data.active_claims).toBe(0);
	});

	test('a mutation op still throws (deferred to a later wave)', async () => {
		await expect(driver.issueOperation('create', ['x'], {}, config)).rejects.toThrow(/not implemented yet/);
	});
});

// KAP-2: enrich the issue output projection. parent_id, priority (label),
// created_at, labels[] and dependencies[] are all stored already — surface them
// through rowToIssueSummary so agents see the full shape, not just rank/blocked.
describe('Kernel SQLite driver — enriched issue projection (KAP-2)', () => {
	let tmpDir;
	let driver;
	let config;
	const now = '2026-06-20T00:00:00.000Z';

	beforeAll(async () => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kdrv-kap2-'));
		const dbPath = path.join(tmpDir, 'kernel.sqlite');
		config = { databasePath: dbPath };
		driver = createBuiltinSQLiteDriver({});
		const broker = createLocalBroker({
			projectRoot: tmpDir,
			execFileSync: () => path.join(tmpDir, '.git'),
			databasePath: dbPath,
			driver,
		});
		await broker.initialize();

		await driver.exec(
			`INSERT INTO kernel_issues (id,title,type,status,priority,priority_rank,parent_id,labels,created_at,updated_at,entity_revision) VALUES
				('p1','Parent epic','epic','open','P1',0,NULL,NULL,'${now}','${now}',0),
				('c1','Child task','task','open','P2',1,'p1','["backend","api"]','${now}','${now}',0),
				('b1','Blocker','task','open','P3',2,NULL,NULL,'${now}','${now}',0);`,
			config,
		);
		// c1 depends on b1 (b1 blocks c1) — so c1 lists b1 as a dependency and is blocked.
		await driver.exec(
			`INSERT INTO kernel_dependencies (id,issue_id,blocks_issue_id,dependency_type,created_at) VALUES
				('e1','c1','b1','blocks','${now}');`,
			config,
		);
	});

	afterAll(() => {
		if (driver) driver.close();
		if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	test('show surfaces parent_id, priority, created_at, labels and dependencies', async () => {
		const res = await driver.issueOperation('show', ['c1'], {}, config);
		expect(res.ok).toBe(true);
		expect(res.data).toMatchObject({
			id: 'c1',
			parent_id: 'p1',
			priority: 'P2',
			created_at: now,
			labels: ['backend', 'api'],
			dependencies: ['b1'],
			blocked: true,
		});
	});

	test('a parentless, label-less, dependency-free issue yields null parent_id and empty arrays', async () => {
		const res = await driver.issueOperation('show', ['p1'], {}, config);
		expect(res.data).toMatchObject({
			id: 'p1',
			parent_id: null,
			priority: 'P1',
			labels: [],
			dependencies: [],
		});
	});

	test('list carries the enriched fields for every issue', async () => {
		const res = await driver.issueOperation('list', [], {}, config);
		const c1 = res.data.issues.find(issue => issue.id === 'c1');
		expect(c1.parent_id).toBe('p1');
		expect(c1.priority).toBe('P2');
		expect(c1.labels).toEqual(['backend', 'api']);
		expect(c1.dependencies).toEqual(['b1']);
		expect(c1.created_at).toBe(now);
	});
});
