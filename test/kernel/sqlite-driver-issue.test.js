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

	// KAP-10 (acceptance_criteria/design/notes) + KAP-11 (assignee): rowToIssueSummary
	// surfaces the four content fields, each defaulting to null when the column is empty.
	test('show surfaces acceptance_criteria/design/notes/assignee, null when unset', async () => {
		await driver.exec(
			`INSERT INTO kernel_issues (id,title,type,status,priority,priority_rank,acceptance_criteria,design,notes,assignee,created_at,updated_at,entity_revision) VALUES
				('cf-show','Has content','task','open','P2',9,'AC body','Design body','Notes body','alice','${now}','${now}',0);`,
			config,
		);

		const res = await driver.issueOperation('show', ['cf-show'], {}, config);
		expect(res.data).toMatchObject({
			id: 'cf-show',
			acceptance_criteria: 'AC body',
			design: 'Design body',
			notes: 'Notes body',
			assignee: 'alice',
		});

		// p1 was seeded without the content columns → each surfaces as null.
		const bare = await driver.issueOperation('show', ['p1'], {}, config);
		expect(bare.data.acceptance_criteria).toBeNull();
		expect(bare.data.design).toBeNull();
		expect(bare.data.notes).toBeNull();
		expect(bare.data.assignee).toBeNull();
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

	test('read responses carry catalog next_commands, with the id substituted for single-issue ops', async () => {
		// show resolves a single issue, so <id> binds to the concrete id (runnable hints).
		const shown = await driver.issueOperation('show', ['c1'], {}, config);
		expect(shown.next_commands).toEqual(['forge claim c1', 'forge issue comment c1 "<note>"']);

		// Multi-issue responses keep the <id> template (no single id to bind).
		const list = await driver.issueOperation('list', [], {}, config);
		expect(list.next_commands).toEqual(['forge issue show <id> --json', 'forge issue search <query> --json']);
	});
});

// KAP-3: `show` surfaces the issue's comments (the list/ready/search/stats reads do
// NOT). Comments are loaded from kernel_comments ordered created_at ASC, id ASC and
// mapped to { id, body, actor, created_at }. The contract field is optional, so list
// summaries (which never carry comments) still validate.
describe('Kernel SQLite driver — comments in show (KAP-3)', () => {
	let tmpDir;
	let driver;
	let config;
	const now = '2026-06-20T00:00:00.000Z';

	beforeAll(async () => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kdrv-kap3-'));
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

		// Insert the issue first (kernel_comments.issue_id references it), then two
		// comments with distinct created_at so the ASC sort is actually exercised.
		await driver.exec(
			`INSERT INTO kernel_issues (id,title,type,status,priority_rank,created_at,updated_at,entity_revision) VALUES
				('k1','Has comments','task','open',0,'${now}','${now}',0);`,
			config,
		);
		await driver.exec(
			`INSERT INTO kernel_comments (id,issue_id,body,actor,visibility,created_at) VALUES
				('cm2','k1','second note','bob','public','2026-06-20T00:00:02.000Z'),
				('cm1','k1','first note','alice','public','2026-06-20T00:00:01.000Z');`,
			config,
		);
	});

	afterAll(() => {
		if (driver) driver.close();
		if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	test('show returns the issue comments in created_at order with body and actor', async () => {
		const res = await driver.issueOperation('show', ['k1'], {}, config);
		expect(res.ok).toBe(true);
		expect(Array.isArray(res.data.comments)).toBe(true);
		expect(res.data.comments).toHaveLength(2);
		// Inserted out of order; created_at ASC must put the earlier note first.
		expect(res.data.comments[0]).toMatchObject({ id: 'cm1', body: 'first note', actor: 'alice' });
		expect(res.data.comments[1]).toMatchObject({ id: 'cm2', body: 'second note', actor: 'bob' });
		expect(res.data.comments[0].created_at).toBe('2026-06-20T00:00:01.000Z');
		expect(res.data.comments[1].created_at).toBe('2026-06-20T00:00:02.000Z');
	});

	test('list summaries do NOT carry a comments key', async () => {
		const res = await driver.issueOperation('list', [], {}, config);
		const k1 = res.data.issues.find(issue => issue.id === 'k1');
		expect(k1).toBeDefined();
		expect(k1.comments).toBeUndefined();
	});
});

// KAP-6: server-side `list` filters. The list op accepts --status / --type / --label
// (both `--flag value` and `--flag=value` forms). status/type are exact-match; --label
// keeps issues whose labels[] INCLUDES the value. Multiple filters AND together; an
// absent filter does not constrain that dimension; an unknown value matches nothing.
// Only `list` is filtered — ready/show/search/stats are untouched.
describe('Kernel SQLite driver — list filters (KAP-6)', () => {
	let tmpDir;
	let driver;
	let config;
	const now = '2026-06-20T00:00:00.000Z';

	beforeAll(async () => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kdrv-kap6-'));
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

		// Discriminating fixture so each filter excludes at least one row:
		//   f1 open  task  [backend,api]  → kept by --status open, --type task, --label backend
		//   f2 open  bug   [frontend]     → dropped by --type task and --label backend
		//   f3 done  task  [backend]      → dropped by --status open; has backend label
		//   f4 open  task  []             → dropped by --label backend
		await driver.exec(
			`INSERT INTO kernel_issues (id,title,type,status,priority_rank,labels,created_at,updated_at,entity_revision) VALUES
				('f1','Alpha','task','open',1,'["backend","api"]','${now}','${now}',0),
				('f2','Beta','bug','open',2,'["frontend"]','${now}','${now}',0),
				('f3','Gamma','task','done',3,'["backend"]','${now}','${now}',0),
				('f4','Delta','task','open',4,NULL,'${now}','${now}',0);`,
			config,
		);
	});

	afterAll(() => {
		if (driver) driver.close();
		if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	test('no filters returns every issue', async () => {
		const res = await driver.issueOperation('list', [], {}, config);
		expect(res.data.issues.map(issue => issue.id)).toEqual(['f1', 'f2', 'f3', 'f4']);
		expect(res.data.count).toBe(4);
	});

	test('--status open keeps only open issues', async () => {
		const res = await driver.issueOperation('list', ['--status', 'open'], {}, config);
		expect(res.data.issues.map(issue => issue.id)).toEqual(['f1', 'f2', 'f4']);
		expect(res.data.count).toBe(3);
	});

	test('--type bug keeps only bugs', async () => {
		const res = await driver.issueOperation('list', ['--type', 'bug'], {}, config);
		expect(res.data.issues.map(issue => issue.id)).toEqual(['f2']);
	});

	test('--label backend keeps only issues whose labels include backend', async () => {
		const res = await driver.issueOperation('list', ['--label', 'backend'], {}, config);
		expect(res.data.issues.map(issue => issue.id)).toEqual(['f1', 'f3']);
	});

	test('the --flag=value form is parsed the same as --flag value', async () => {
		const res = await driver.issueOperation('list', ['--status=open'], {}, config);
		expect(res.data.issues.map(issue => issue.id)).toEqual(['f1', 'f2', 'f4']);
	});

	test('an empty --flag= value is treated as missing (no constraint)', async () => {
		const res = await driver.issueOperation('list', ['--status='], {}, config);
		expect(res.data.issues.map(issue => issue.id)).toEqual(['f1', 'f2', 'f3', 'f4']);
		expect(res.data.count).toBe(4);
	});

	test('--status open --type task ANDs both filters', async () => {
		const res = await driver.issueOperation('list', ['--status', 'open', '--type', 'task'], {}, config);
		expect(res.data.issues.map(issue => issue.id)).toEqual(['f1', 'f4']);
	});

	test('an unknown filter value matches nothing', async () => {
		const res = await driver.issueOperation('list', ['--status', 'nonexistent'], {}, config);
		expect(res.data.issues).toEqual([]);
		expect(res.data.count).toBe(0);
	});
});

// KAP-7: derived read query `blocked` — issues whose readiness is blocked
// (index.readinessById[id].blocked === true). Summaries are sorted like `list`
// (rank asc, then id). ready/show/search/stats/list are untouched.
describe('Kernel SQLite driver — blocked query (KAP-7)', () => {
	let tmpDir;
	let driver;
	let config;
	const now = '2026-06-20T00:00:00.000Z';

	beforeAll(async () => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kdrv-kap7-blocked-'));
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

		// b1 (rank 1) depends on b2 (open) → b1 is blocked. b2 and b3 are unblocked.
		await driver.exec(
			`INSERT INTO kernel_issues (id,title,type,status,priority_rank,created_at,updated_at,entity_revision) VALUES
				('b1','Blocked one','task','open',1,'${now}','${now}',0),
				('b2','Open blocker','task','open',2,'${now}','${now}',0),
				('b3','Free task','task','open',3,'${now}','${now}',0);`,
			config,
		);
		await driver.exec(
			`INSERT INTO kernel_dependencies (id,issue_id,blocks_issue_id,dependency_type,created_at) VALUES
				('bd1','b1','b2','blocks','${now}');`,
			config,
		);
	});

	afterAll(() => {
		if (driver) driver.close();
		if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	test('blocked returns only issues whose readiness is blocked', async () => {
		const res = await driver.issueOperation('blocked', [], {}, config);
		expect(res.ok).toBe(true);
		expect(res.schema_version).toBe('forge.issue.v1');
		expect(res.command).toBe('issue.blocked');
		expect(res.data.issues.map(issue => issue.id)).toEqual(['b1']);
		expect(res.data.count).toBe(1);
		expect(res.data.issues[0].blocked).toBe(true);
		expect(Array.isArray(res.next_commands)).toBe(true);
	});
});

// KAP-7: derived read query `stale` — open/in_progress issues whose updated_at is
// strictly older than (now - threshold_days). Default 14 days; --days <n> /
// --days=<n> overrides (NaN/<=0 falls back to 14). now = context.now when present,
// else new Date().toISOString(). Response carries threshold_days.
describe('Kernel SQLite driver — stale query (KAP-7)', () => {
	let tmpDir;
	let driver;
	let config;
	const now = '2026-06-20T00:00:00.000Z';
	// 20 days before now → older than the 14-day default; clearly stale.
	const old = '2026-05-31T00:00:00.000Z';
	// 2 days before now → fresh under the default threshold.
	const fresh = '2026-06-18T00:00:00.000Z';

	beforeAll(async () => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kdrv-kap7-stale-'));
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

		// s1: old + open → stale. s2: old + in_progress → stale. s3: fresh + open →
		// not stale. s4: old + done → excluded (terminal status). s5: old + review →
		// excluded (review is not open/in_progress). s6: old + backlog → excluded
		// (parked ideas must NEVER flag stale, no matter how old).
		await driver.exec(
			`INSERT INTO kernel_issues (id,title,type,status,priority_rank,created_at,updated_at,entity_revision) VALUES
				('s1','Old open','task','open',1,'${old}','${old}',0),
				('s2','Old wip','task','in_progress',2,'${old}','${old}',0),
				('s3','Fresh open','task','open',3,'${fresh}','${fresh}',0),
				('s4','Old done','task','done',4,'${old}','${old}',0),
				('s5','Old review','task','review',5,'${old}','${old}',0),
				('s6','Old parked','task','backlog',6,'${old}','${old}',0);`,
			config,
		);
	});

	afterAll(() => {
		if (driver) driver.close();
		if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	test('stale returns open/in_progress issues older than the 14-day default', async () => {
		const res = await driver.issueOperation('stale', [], { now }, config);
		expect(res.ok).toBe(true);
		expect(res.schema_version).toBe('forge.issue.v1');
		expect(res.command).toBe('issue.stale');
		expect(res.data.issues.map(issue => issue.id)).toEqual(['s1', 's2']);
		// s6 is an old backlog issue — parked work is never stale.
		expect(res.data.issues.map(issue => issue.id)).not.toContain('s6');
		expect(res.data.count).toBe(2);
		expect(res.data.threshold_days).toBe(14);
	});

	test('--days <n> overrides the threshold', async () => {
		// 30-day window → nothing 30+ days old, so the result is empty.
		const res = await driver.issueOperation('stale', ['--days', '30'], { now }, config);
		expect(res.data.issues).toEqual([]);
		expect(res.data.threshold_days).toBe(30);
	});

	test('--days=<n> form is parsed the same as --days <n>', async () => {
		// 1-day window → both old (20d) issues remain stale; the fresh (2d) one too.
		const res = await driver.issueOperation('stale', ['--days=1'], { now }, config);
		expect(res.data.issues.map(issue => issue.id)).toEqual(['s1', 's2', 's3']);
		expect(res.data.threshold_days).toBe(1);
	});

	test('a non-positive/NaN --days value falls back to the 14-day default', async () => {
		const res = await driver.issueOperation('stale', ['--days', 'notanumber'], { now }, config);
		expect(res.data.threshold_days).toBe(14);
		expect(res.data.issues.map(issue => issue.id)).toEqual(['s1', 's2']);
	});
});

// KAP-7: derived read query `orphans` — issues touched by a DANGLING dependency
// edge (a kernel_dependencies row whose issue_id OR blocks_issue_id references an
// id absent from kernel_issues). Returns the affected EXISTING issues, deduped.
// FK is enforced (PRAGMA foreign_keys=ON), so the fixture toggles it OFF to seed
// the malformed edges the op is built to detect, then restores it.
describe('Kernel SQLite driver — orphans query (KAP-7)', () => {
	let tmpDir;
	let driver;
	let config;
	const now = '2026-06-20T00:00:00.000Z';

	beforeAll(async () => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kdrv-kap7-orphans-'));
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
				('o1','Depends on missing','task','open',1,'${now}','${now}',0),
				('o2','Blocked by ghost','task','open',2,'${now}','${now}',0),
				('o3','Clean issue','task','open',3,'${now}','${now}',0),
				('o4','Clean blocker','task','open',4,'${now}','${now}',0);`,
			config,
		);
		// Toggle FK off to seed dangling edges, then restore ON for the assertions:
		//   dd1: o1 (exists) → MISSING (absent)  → o1 is an orphan via issue_id
		//   dd2: GHOST (absent) → o2 (exists)    → o2 is an orphan via blocks_issue_id
		//   dd3: o3 (exists) → o4 (exists)       → clean edge, neither is an orphan
		await driver.exec('PRAGMA foreign_keys=OFF;', config);
		await driver.exec(
			`INSERT INTO kernel_dependencies (id,issue_id,blocks_issue_id,dependency_type,created_at) VALUES
				('dd1','o1','MISSING','blocks','${now}'),
				('dd2','GHOST','o2','blocks','${now}'),
				('dd3','o3','o4','blocks','${now}');`,
			config,
		);
		await driver.exec('PRAGMA foreign_keys=ON;', config);
	});

	afterAll(() => {
		if (driver) driver.close();
		if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	test('orphans returns the existing issues attached to a dangling edge, deduped', async () => {
		const res = await driver.issueOperation('orphans', [], {}, config);
		expect(res.ok).toBe(true);
		expect(res.schema_version).toBe('forge.issue.v1');
		expect(res.command).toBe('issue.orphans');
		// o1 (dangling via issue_id) and o2 (dangling via blocks_issue_id); o3/o4
		// share a clean edge and are excluded. Sorted like list (rank asc).
		expect(res.data.issues.map(issue => issue.id)).toEqual(['o1', 'o2']);
		expect(res.data.count).toBe(2);
	});
});

// KAP-12: read-only `lint` — flags issues missing required content. An issue FAILS
// content lint iff its type is task|bug AND acceptance_criteria is null or
// empty/whitespace-only. epic/decision are exempt. Each failing issue carries a
// `validation: { rules_failed: ['missing_acceptance_criteria'] }`. Results sort like
// list (rank asc). The rule references ONLY base-existing columns.
describe('Kernel SQLite driver — lint query (KAP-12)', () => {
	let tmpDir;
	let driver;
	let config;
	const now = '2026-06-20T00:00:00.000Z';

	beforeAll(async () => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kdrv-kap12-lint-'));
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

		// l1: task, no acceptance_criteria (NULL)        → FAILS.
		// l2: task, has acceptance_criteria               → passes.
		// l3: bug, whitespace-only acceptance_criteria    → FAILS.
		// l4: epic, no acceptance_criteria                → EXEMPT (passes).
		// l5: task, empty-string acceptance_criteria      → FAILS.
		await driver.exec(
			`INSERT INTO kernel_issues (id,title,type,status,priority_rank,acceptance_criteria,created_at,updated_at,entity_revision) VALUES
				('l1','Task missing AC','task','open',1,NULL,'${now}','${now}',0),
				('l2','Task with AC','task','open',2,'Given X, then Y','${now}','${now}',0),
				('l3','Bug whitespace AC','bug','open',3,'   ','${now}','${now}',0),
				('l4','Epic missing AC','epic','open',4,NULL,'${now}','${now}',0),
				('l5','Task empty AC','task','open',5,'','${now}','${now}',0);`,
			config,
		);
	});

	afterAll(() => {
		if (driver) driver.close();
		if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	test('lint returns exactly the task/bug issues missing acceptance_criteria, each with rules_failed', async () => {
		const res = await driver.issueOperation('lint', [], {}, config);
		expect(res.ok).toBe(true);
		expect(res.schema_version).toBe('forge.issue.v1');
		expect(res.command).toBe('issue.lint');
		// l1 (NULL), l3 (whitespace), l5 (empty) fail. l2 has AC; l4 is an epic (exempt).
		// Sorted like list (rank asc).
		expect(res.data.issues.map(issue => issue.id)).toEqual(['l1', 'l3', 'l5']);
		expect(res.data.count).toBe(3);
		for (const issue of res.data.issues) {
			expect(issue.validation).toEqual({ rules_failed: ['missing_acceptance_criteria'] });
		}
	});
});
