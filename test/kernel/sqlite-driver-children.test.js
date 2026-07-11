'use strict';

const { describe, test, expect, beforeAll, afterAll } = require('bun:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createLocalBroker } = require('../../lib/kernel/broker');
const { createBuiltinSQLiteDriver } = require('../../lib/kernel/sqlite-driver');

// Epic support: the `children` read op returns an epic's DIRECT children (membership
// is the first-class parent_id field, one level — `WHERE parent_id = ?`) plus a
// kernel-computed rollup. The kernel owns the status vocabulary
// (open|in_progress|review|done|cancelled), so the rollup emits the counts and a
// done-only percentage rather than making consumers hard-code status names. Children
// carry the full summary, including the new reverse-dependency `dependents` and the
// readiness `blocked_by` arrays.
describe('Kernel SQLite driver — children query + rollup (epic support)', () => {
	let tmpDir;
	let driver;
	let config;
	const now = '2026-06-27T00:00:00.000Z';

	beforeAll(async () => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kdrv-children-'));
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

		// e1 epic with five DIRECT children (c1..c5). g1 is a grandchild (parent_id=c1)
		// to prove only ONE level is returned. solo is unrelated (no parent). np is a
		// non-epic parent with one child (npc) to prove the op is not gated on type.
		//   c1 open  rank 2 — depends on c2 (open) → c1 is blocked, blocked_by=[c2]
		//   c2 open  rank 1 — blocks c1            → c2.dependents=[c1]
		//   c3 done  rank 3 — the only completed child
		//   c4 cancelled rank 4
		//   c5 in_progress rank 5
		await driver.exec(
			`INSERT INTO kernel_issues (id,title,type,status,priority,priority_rank,parent_id,assignee,created_at,updated_at,entity_revision) VALUES
				('e1','Launch epic','epic','open','P1',0,NULL,NULL,'${now}','${now}',0),
				('c1','Child one','task','open','P2',2,'e1','alice','${now}','${now}',0),
				('c2','Child two','task','open','P2',1,'e1','bob','${now}','${now}',0),
				('c3','Child three','task','done','P2',3,'e1','alice','${now}','${now}',0),
				('c4','Child four','task','cancelled','P2',4,'e1',NULL,'${now}','${now}',0),
				('c5','Child five','task','in_progress','P2',5,'e1','bob','${now}','${now}',0),
				('g1','Grandchild','task','open','P2',6,'c1',NULL,'${now}','${now}',0),
				('solo','No children','task','open','P2',7,NULL,NULL,'${now}','${now}',0),
				('np','Non-epic parent','task','open','P2',8,NULL,NULL,'${now}','${now}',0),
				('npc','Child of a task','task','open','P2',9,'np',NULL,'${now}','${now}',0),
				('e2','Backlog epic','epic','open','P1',0,NULL,NULL,'${now}','${now}',0),
				('eb1','Parked idea','task','backlog','P2',1,'e2',NULL,'${now}','${now}',0);`,
			config,
		);
		// c1 depends on c2 (c2 blocks c1): c1.dependencies=[c2], c1.blocked_by=[c2],
		// c2.dependents=[c1].
		await driver.exec(
			`INSERT INTO kernel_dependencies (id,issue_id,blocks_issue_id,dependency_type,created_at) VALUES
				('dep1','c1','c2','blocks','${now}');`,
			config,
		);
	});

	afterAll(() => {
		if (driver) driver.close();
		if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	test('children returns the epic header + direct children ranked, with a count', async () => {
		const res = await driver.issueOperation('children', ['e1'], {}, config);
		expect(res.ok).toBe(true);
		expect(res.schema_version).toBe('forge.issue.v1');
		expect(res.command).toBe('issue.children');
		expect(res.data.epic).toEqual({ id: 'e1', title: 'Launch epic', type: 'epic', status: 'open' });
		// Direct children only, sorted by rank (then id): c2(1) c1(2) c3(3) c4(4) c5(5).
		expect(res.data.children.map(child => child.id)).toEqual(['c2', 'c1', 'c3', 'c4', 'c5']);
		expect(res.data.count).toBe(5);
		expect(Array.isArray(res.next_commands)).toBe(true);
	});

	test('rollup is done-only percentage with a per-status histogram and blocked count', async () => {
		const res = await driver.issueOperation('children', ['e1'], {}, config);
		expect(res.data.rollup).toMatchObject({
			total: 5,
			done: 1,
			in_progress: 1,
			open: 2,
			review: 0,
			cancelled: 1,
			backlog: 0,
			// cancelled does NOT count toward complete — done-only percentage: 1/5 = 20%.
			percentage: 20,
			// c1 is blocked by the still-open c2.
			blocked: 1,
		});
		expect(res.data.rollup.by_status).toEqual({
			open: 2, in_progress: 1, review: 0, done: 1, cancelled: 1, backlog: 0,
		});
	});

	test('rollup counts backlog children — parked work is first-class', async () => {
		const res = await driver.issueOperation('children', ['e2'], {}, config);
		expect(res.data.rollup.total).toBe(1);
		expect(res.data.rollup.backlog).toBe(1);
		expect(res.data.rollup.by_status.backlog).toBe(1);
		// parked work is not done, so it never counts toward completion.
		expect(res.data.rollup.done).toBe(0);
		expect(res.data.rollup.percentage).toBe(0);
	});

	test('children carry the reverse-dependency dependents + readiness blocked_by', async () => {
		const res = await driver.issueOperation('children', ['e1'], {}, config);
		const c1 = res.data.children.find(child => child.id === 'c1');
		const c2 = res.data.children.find(child => child.id === 'c2');
		// c1 is blocked by c2: full declared dependencies + the live blocker subset.
		expect(c1).toMatchObject({
			dependencies: ['c2'],
			blocked_by: ['c2'],
			blocked: true,
			dependents: [],
			assignee: 'alice',
		});
		// c2 is the blocker: nothing blocks it, and c1 depends on it (reverse edge).
		expect(c2).toMatchObject({
			dependencies: [],
			blocked_by: [],
			blocked: false,
			dependents: ['c1'],
		});
	});

	test('only DIRECT children are returned — grandchildren are excluded', async () => {
		const res = await driver.issueOperation('children', ['e1'], {}, config);
		expect(res.data.children.map(child => child.id)).not.toContain('g1');
	});

	test('children accepts any id (not gated on type === epic)', async () => {
		// c1 is a task whose only child is the grandchild g1.
		const viaTask = await driver.issueOperation('children', ['c1'], {}, config);
		expect(viaTask.ok).toBe(true);
		expect(viaTask.data.children.map(child => child.id)).toEqual(['g1']);
		expect(viaTask.data.count).toBe(1);
		// np is a non-epic parent with one child.
		const viaNonEpic = await driver.issueOperation('children', ['np'], {}, config);
		expect(viaNonEpic.data.children.map(child => child.id)).toEqual(['npc']);
	});

	test('a leaf issue returns empty children and a zeroed rollup', async () => {
		const res = await driver.issueOperation('children', ['solo'], {}, config);
		expect(res.ok).toBe(true);
		expect(res.data.children).toEqual([]);
		expect(res.data.count).toBe(0);
		expect(res.data.rollup).toMatchObject({
			total: 0, done: 0, in_progress: 0, open: 0, review: 0, cancelled: 0, backlog: 0, blocked: 0, percentage: 0,
		});
	});

	test('children on a missing id returns the notFound error shape (mirrors show)', async () => {
		const res = await driver.issueOperation('children', ['ghost'], {}, config);
		expect(res.ok).toBe(false);
		expect(res.error.code).toBe('FORGE_ISSUE_NOT_FOUND');
		expect(res.error.exit_code).toBe(3);
		expect(res.error.retryable).toBe(false);
	});

	// §2b: the reverse-dependency exposure is a strict superset on EVERY read op, not
	// just children — show now carries dependents + blocked_by too.
	test('show surfaces the new dependents + blocked_by on a normal read', async () => {
		const blocker = await driver.issueOperation('show', ['c2'], {}, config);
		expect(blocker.data.dependents).toEqual(['c1']);
		expect(blocker.data.blocked_by).toEqual([]);
		const blocked = await driver.issueOperation('show', ['c1'], {}, config);
		expect(blocked.data.blocked_by).toEqual(['c2']);
		expect(blocked.data.dependents).toEqual([]);
	});
});
