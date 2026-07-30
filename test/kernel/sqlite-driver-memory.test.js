'use strict';

// Project-memory read-model driver primitives. Memory rows are written DIRECTLY to
// kernel_memories (NOT through the issue CAS/guarded-event path), so these methods are
// synchronous and self-sufficient: each lazily ensures the table exists, which lets
// project-memory persist without first awaiting the async broker.initialize().
const { afterEach, describe, expect, test } = require('bun:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { performance } = require('node:perf_hooks');

const { createBuiltinSQLiteDriver } = require('../../lib/kernel/sqlite-driver');

const tmpDirs = [];
const drivers = [];
const LOCAL_PROJECT_ID = 'c:/repo/.git';

function scored(driver, query, limit) {
	return driver.searchMemoriesRankedScored(query, limit, {
		projectId: LOCAL_PROJECT_ID,
		now: '2026-07-30T00:00:00.000Z',
	});
}

function makeDriver() {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-kernel-memory-'));
	tmpDirs.push(dir);
	const driver = createBuiltinSQLiteDriver({ databasePath: path.join(dir, 'kernel.sqlite') });
	drivers.push(driver);
	return driver;
}

afterEach(() => {
	while (drivers.length > 0) {
		try {
			drivers.pop().close();
		} catch {
			// best-effort close
		}
	}
	while (tmpDirs.length > 0) {
		fs.rmSync(tmpDirs.pop(), { recursive: true, force: true });
	}
});

describe('Kernel SQLite driver — project-memory read model', () => {
	test('records and loads an entry round-trip without a prior broker.initialize()', () => {
		const driver = makeDriver();
		driver.recordMemory({
			key: 'policy.memory',
			value: 'Use the kernel for durable memory.',
			sourceAgent: 'Codex',
			tags: ['memory'],
			timestamp: '2026-05-16T10:00:00.000Z',
			scope: 'project',
			confidence: 0.9,
			supersedes: ['policy.old'],
			beadsRefs: ['forge-1gry'],
		});

		expect(driver.loadMemory('policy.memory')).toEqual({
			key: 'policy.memory',
			value: 'Use the kernel for durable memory.',
			sourceAgent: 'Codex',
			tags: ['memory'],
			timestamp: '2026-05-16T10:00:00.000Z',
			scope: 'project',
			confidence: 0.9,
			supersedes: ['policy.old'],
			beadsRefs: ['forge-1gry'],
		});
	});

	test('preserves object values and omits absent optional fields', () => {
		const driver = makeDriver();
		driver.recordMemory({
			key: 'decisions:topic',
			value: { category: 'decisions', data: { choice: 'kernel' } },
			sourceAgent: 'forge insights',
			tags: ['decisions'],
		});

		const entry = driver.loadMemory('decisions:topic');
		expect(entry.value).toEqual({ category: 'decisions', data: { choice: 'kernel' } });
		expect(entry.tags).toEqual(['decisions']);
		// Absent optionals are not surfaced (matches the legacy entry shape).
		expect('scope' in entry).toBe(false);
		expect('confidence' in entry).toBe(false);
		expect('supersedes' in entry).toBe(false);
		expect('beadsRefs' in entry).toBe(false);
		// A stored entry always carries a timestamp and a tags array.
		expect(typeof entry.timestamp).toBe('string');
	});

	test('upserts by key (a second record overwrites the value)', () => {
		const driver = makeDriver();
		driver.recordMemory({ key: 'k', value: 'first', sourceAgent: 'Codex', tags: [] });
		driver.recordMemory({ key: 'k', value: 'second', sourceAgent: 'Claude', tags: ['x'] });

		const entry = driver.loadMemory('k');
		expect(entry.value).toBe('second');
		expect(entry.sourceAgent).toBe('Claude');
		expect(entry.tags).toEqual(['x']);
		expect(driver.listMemories()).toHaveLength(1);
	});

	test('loadMemory returns null for a missing key', () => {
		const driver = makeDriver();
		expect(driver.loadMemory('nope')).toBe(null);
	});

	test('a re-write refreshes the surfaced timestamp (as-of), matching legacy behavior', () => {
		const driver = makeDriver();
		driver.recordMemory({ key: 'k', value: 'v1', sourceAgent: 'Codex', tags: [], timestamp: '2026-05-16T10:00:00.000Z' });
		driver.recordMemory({ key: 'k', value: 'v2', sourceAgent: 'Codex', tags: [], timestamp: '2026-06-01T12:00:00.000Z' });
		// The entry timestamp reflects the LATEST write, not the first-seen time.
		expect(driver.loadMemory('k').timestamp).toBe('2026-06-01T12:00:00.000Z');
	});

	test('searchMemories matches all whitespace tokens across key and value', () => {
		const driver = makeDriver();
		driver.recordMemory({ key: 'decisions:one', value: 'pick the kernel store', sourceAgent: 'Codex', tags: [] });
		driver.recordMemory({ key: 'decisions:two', value: 'keep beads export only', sourceAgent: 'Codex', tags: [] });
		driver.recordMemory({ key: 'episodes:three', value: 'kernel migration shipped', sourceAgent: 'Codex', tags: [] });

		// AND semantics: both tokens must be present (in key or value).
		expect(driver.searchMemories('decisions kernel').map(entry => entry.key)).toEqual(['decisions:one']);
		// Whole-prefix substring matches the key.
		expect(driver.searchMemories('decisions').map(entry => entry.key)).toEqual([
			'decisions:one',
			'decisions:two',
		]);
		// An empty query lists everything (ordered by key).
		expect(driver.searchMemories('').map(entry => entry.key)).toEqual([
			'decisions:one',
			'decisions:two',
			'episodes:three',
		]);
	});

	test('listMemories returns every entry ordered by key', () => {
		const driver = makeDriver();
		driver.recordMemory({ key: 'b', value: '2', sourceAgent: 'Codex', tags: [] });
		driver.recordMemory({ key: 'a', value: '1', sourceAgent: 'Codex', tags: [] });
		expect(driver.listMemories().map(entry => entry.key)).toEqual(['a', 'b']);
	});
});

describe('Kernel SQLite driver — FTS5 memory recall (token-efficient read layer)', () => {
	test('keeps 1,000-record scored recall p95 within the prompt budget', () => {
		const driver = makeDriver();
		const projectId = 'c:/repo/.git';
		for (let index = 0; index < 1_000; index += 1) {
			driver.recordMemory({
				key: `performance-${index}`,
				value: `auth token policy record ${index}`,
				sourceAgent: 'forge remember',
				scope: projectId,
				tags: [],
				timestamp: '2026-07-30T00:00:00.000Z',
			});
		}
		const search = () => driver.searchMemoriesRankedScored('auth token', 25, {
			projectId,
			now: '2026-07-30T12:00:00.000Z',
		});
		for (let index = 0; index < 10; index += 1) search();
		const samples = [];
		for (let index = 0; index < 100; index += 1) {
			const startedAt = performance.now();
			const hits = search();
			samples.push(performance.now() - startedAt);
			expect(hits).toHaveLength(25);
		}
		samples.sort((left, right) => left - right);
		const p95 = samples[Math.ceil(samples.length * 0.95) - 1];
		expect(p95).toBeLessThanOrEqual(250);
	}, 20_000);

	test('filters foreign and already-seen rows before the scored candidate limit', () => {
		const driver = makeDriver();
		const projectId = 'c:/repo/.git';
		for (let index = 0; index < 26; index += 1) {
			driver.recordMemory({
				key: `foreign-${index}`,
				value: `auth token ${'auth '.repeat(20)}`,
				sourceAgent: 'forge remember',
				scope: 'c:/other/.git',
				tags: [],
			});
			driver.recordMemory({
				key: `seen-${index}`,
				value: `auth token ${'token '.repeat(20)}`,
				sourceAgent: 'forge remember',
				scope: projectId,
				tags: [],
			});
		}
		driver.recordMemory({
			key: 'eligible-local',
			value: 'auth token local',
			sourceAgent: 'forge remember',
			scope: projectId,
			tags: [],
		});

		const hits = driver.searchMemoriesRankedScored('auth token', 25, {
			projectId,
			excludeKeys: Array.from({ length: 26 }, (_, index) => `seen-${index}`),
			now: '2026-07-30T00:00:00.000Z',
		});

		expect(hits.map(hit => hit.memory_id)).toEqual(['eligible-local']);
	});

	test('only an eligible superseder suppresses and suggested cannot erase confirmed memory', () => {
		const driver = makeDriver();
		const projectId = 'c:/repo/.git';
		const now = '2026-07-30T00:00:00.000Z';
		driver.recordMemory({
			key: 'confirmed-base',
			value: 'auth token confirmed base',
			sourceAgent: 'forge remember',
			scope: projectId,
			tags: [],
		});
		driver.recordMemory({
			key: 'suggested-superseder',
			value: 'auth token suggested replacement',
			sourceAgent: 'forge insights',
			scope: projectId,
			tags: [],
			supersedes: ['confirmed-base'],
			timestamp: now,
		});
		driver.recordMemory({
			key: 'foreign-base',
			value: 'auth token local survives foreign superseder',
			sourceAgent: 'forge remember',
			scope: projectId,
			tags: [],
		});
		driver.recordMemory({
			key: 'foreign-superseder',
			value: 'auth token foreign replacement',
			sourceAgent: 'forge remember',
			scope: 'c:/other/.git',
			tags: [],
			supersedes: ['foreign-base'],
		});
		driver.recordMemory({
			key: 'suggested-old',
			value: 'auth token stale suggestion',
			sourceAgent: 'forge insights',
			scope: projectId,
			tags: [],
			timestamp: '2026-07-01T00:00:00.000Z',
		});

		const ids = driver.searchMemoriesRankedScored('auth token', 25, { projectId, now })
			.map(hit => hit.memory_id);

		expect(ids).toContain('confirmed-base');
		expect(ids).toContain('foreign-base');
		expect(ids).not.toContain('foreign-superseder');
		expect(ids).not.toContain('suggested-old');
	});

	test('returns the normalized hit contract with locked trust and type precedence', () => {
		const driver = makeDriver();
		const projectId = 'c:/repo/.git';
		driver.recordMemory({
			key: 'typed',
			value: { category: 'decision', data: 'auth token policy' },
			sourceAgent: 'forge insights',
			scope: projectId,
			tags: ['type:gotcha', 'trust:confirmed'],
			beadsRefs: ['forge-1'],
			timestamp: '2026-07-30T00:00:00.000Z',
		});

		const [hit] = driver.searchMemoriesRankedScored('auth token', 25, {
			projectId,
			now: '2026-07-30T01:00:00.000Z',
		});

		expect(hit).toMatchObject({
			memory_id: 'typed',
			type: 'gotcha',
			content: '{"category":"decision","data":"auth token policy"}',
			scope: projectId,
			trust_status: 'confirmed',
			provenance: {
				source_agent: 'forge insights',
				source_refs: ['forge-1'],
			},
			updated_at: '2026-07-30T00:00:00.000Z',
		});
		expect(typeof hit.score).toBe('number');
	});

	test('searchMemoriesRanked matches all tokens via FTS BM25 (token-AND, any order)', () => {
		const driver = makeDriver();
		driver.recordMemory({ key: 'm1', value: 'auth bug in the login flow', sourceAgent: 'Codex', tags: [] });
		driver.recordMemory({ key: 'm2', value: 'bug in the export command', sourceAgent: 'Codex', tags: [] });
		driver.recordMemory({ key: 'm3', value: 'auth token refresh', sourceAgent: 'Codex', tags: [] });

		// token-AND, order-independent: only the note containing BOTH auth AND bug.
		expect(driver.searchMemoriesRanked('bug auth', 10).map(entry => entry.key)).toEqual(['m1']);
	});

	test('searchMemoriesRanked honors the top-N limit', () => {
		const driver = makeDriver();
		driver.recordMemory({ key: 'a', value: 'kernel note one', sourceAgent: 'Codex', tags: [] });
		driver.recordMemory({ key: 'b', value: 'kernel note two', sourceAgent: 'Codex', tags: [] });
		driver.recordMemory({ key: 'c', value: 'kernel note three', sourceAgent: 'Codex', tags: [] });

		expect(driver.searchMemoriesRanked('kernel', 2)).toHaveLength(2);
	});

	test('searchMemoriesRanked reflects an upsert (FTS stays in sync with the row)', () => {
		const driver = makeDriver();
		driver.recordMemory({ key: 'k', value: 'original alpha text', sourceAgent: 'Codex', tags: [] });
		expect(driver.searchMemoriesRanked('alpha', 10).map(entry => entry.key)).toEqual(['k']);

		driver.recordMemory({ key: 'k', value: 'replaced beta text', sourceAgent: 'Codex', tags: [] });
		// The stale token no longer matches; the fresh token does.
		expect(driver.searchMemoriesRanked('alpha', 10)).toEqual([]);
		expect(driver.searchMemoriesRanked('beta', 10).map(entry => entry.key)).toEqual(['k']);
	});

	test('searchMemoriesRanked with an empty query returns recent entries (never a bare dump)', () => {
		const driver = makeDriver();
		driver.recordMemory({ key: 'a', value: '1', sourceAgent: 'Codex', tags: [], timestamp: '2026-01-01T00:00:00.000Z' });
		driver.recordMemory({ key: 'b', value: '2', sourceAgent: 'Codex', tags: [], timestamp: '2026-02-01T00:00:00.000Z' });
		expect(driver.searchMemoriesRanked('', 1).map(entry => entry.key)).toEqual(['b']);
	});

	test('recentMemories returns entries newest-first and honors the limit', () => {
		const driver = makeDriver();
		driver.recordMemory({ key: 'a', value: '1', sourceAgent: 'Codex', tags: [], timestamp: '2026-01-01T00:00:00.000Z' });
		driver.recordMemory({ key: 'b', value: '2', sourceAgent: 'Codex', tags: [], timestamp: '2026-02-01T00:00:00.000Z' });
		driver.recordMemory({ key: 'c', value: '3', sourceAgent: 'Codex', tags: [], timestamp: '2026-03-01T00:00:00.000Z' });

		expect(driver.recentMemories(2).map(entry => entry.key)).toEqual(['c', 'b']);
	});

	// The SCORED variant exists for the per-turn auto-recall hook, which needs the raw
	// bm25 score to apply a relevance FLOOR (inject nothing when nothing clears the bar).
	// Ordinal rank alone can't do that — it would always surface top-N even for junk.
	test('searchMemoriesRankedScored attaches a numeric bm25 score, best-first', () => {
		const driver = makeDriver();
		driver.recordMemory({ key: 'm1', value: 'auth bug in the login flow', sourceAgent: 'Codex', tags: [] });
		driver.recordMemory({ key: 'm2', value: 'auth bug bug bug everywhere in auth', sourceAgent: 'Codex', tags: [] });

		const hits = scored(driver, 'auth bug', 10);
		expect(hits.map(h => h.memory_id).sort()).toEqual(['m1', 'm2']);
		for (const hit of hits) {
			expect(typeof hit.score).toBe('number');
		}
		// bm25 returns more-negative for a stronger match; results are ordered best (lowest) first.
		expect(hits[0].score).toBeLessThanOrEqual(hits[1].score);
	});

	// The SCORED read is the ONLY relevance-only read (it feeds the per-turn recall hook), so it
	// uses keyword-OR: a natural-language prompt matches a note that contains ANY of its keywords,
	// not EVERY one. Token-AND on a raw prompt required every word in one note -> 0% recall.
	test('searchMemoriesRankedScored matches when only SOME query tokens appear (keyword-OR)', () => {
		const driver = makeDriver();
		driver.recordMemory({ key: 'm1', value: 'auth bug in the login flow', sourceAgent: 'Codex', tags: [] });
		driver.recordMemory({ key: 'm2', value: 'unrelated kubernetes helm chart', sourceAgent: 'Codex', tags: [] });

		// A natural-language style token set: only 'auth' and 'bug' appear in m1; 'token'/'refresh'
		// do not. Token-AND would find nothing; keyword-OR surfaces m1 (and never m2).
		const hits = scored(driver, 'auth token refresh bug', 10);
		expect(hits.map(h => h.memory_id)).toEqual(['m1']);
	});

	test('searchMemoriesRankedScored quotes a non-Latin token safely (keyword-OR, unicode)', () => {
		const driver = makeDriver();
		driver.recordMemory({ key: 'm1', value: 'привет kernel memory', sourceAgent: 'Codex', tags: [] });
		driver.recordMemory({ key: 'm2', value: 'unrelated english note', sourceAgent: 'Codex', tags: [] });

		// Only the Cyrillic token matches; it must be double-quoted so FTS5 never chokes on it.
		const hits = scored(driver, 'привет qwerty', 10);
		expect(hits.map(h => h.memory_id)).toEqual(['m1']);
	});

	test('the AND path (searchMemoriesRanked) is unchanged — still token-AND, no OR leak', () => {
		const driver = makeDriver();
		driver.recordMemory({ key: 'm1', value: 'auth bug in the login flow', sourceAgent: 'Codex', tags: [] });

		// `forge recall` keeps exact-search: a note lacking one of the tokens must NOT match.
		expect(driver.searchMemoriesRanked('auth kubernetes', 10)).toEqual([]);
		// Both tokens present -> still matches.
		expect(driver.searchMemoriesRanked('auth bug', 10).map(h => h.key)).toEqual(['m1']);
	});

	test('searchMemoriesRankedScored returns [] for a no-match query — never a recency fallback', () => {
		const driver = makeDriver();
		driver.recordMemory({ key: 'm1', value: 'auth bug in the login flow', sourceAgent: 'Codex', tags: [] });

		// Unlike searchMemoriesRanked, the scored variant is relevance-ONLY: a query that
		// matches nothing yields nothing, so the hook injects nothing rather than recent noise.
		expect(scored(driver, 'kubernetes helm chart', 10)).toEqual([]);
		expect(scored(driver, '', 10)).toEqual([]);
	});

	test('searchMemoriesRankedScored honors the top-N limit', () => {
		const driver = makeDriver();
		driver.recordMemory({ key: 'a', value: 'kernel note one', sourceAgent: 'Codex', tags: [] });
		driver.recordMemory({ key: 'b', value: 'kernel note two', sourceAgent: 'Codex', tags: [] });
		driver.recordMemory({ key: 'c', value: 'kernel note three', sourceAgent: 'Codex', tags: [] });

		expect(scored(driver, 'kernel', 2)).toHaveLength(2);
	});

	test('countMemories returns the total row count', () => {
		const driver = makeDriver();
		expect(driver.countMemories()).toBe(0);
		driver.recordMemory({ key: 'a', value: '1', sourceAgent: 'Codex', tags: [] });
		driver.recordMemory({ key: 'b', value: '2', sourceAgent: 'Codex', tags: [] });
		expect(driver.countMemories()).toBe(2);
	});

	test('recentMemories and countMemories scope to a source_agent allow-list', () => {
		const driver = makeDriver();
		driver.recordMemory({ key: 'h1', value: 'human one', sourceAgent: 'forge remember', tags: [] });
		driver.recordMemory({ key: 'm1', value: 'machine one', sourceAgent: 'forge insights', tags: [] });
		driver.recordMemory({ key: 'h2', value: 'human two', sourceAgent: 'forge remember', tags: [] });

		// Unfiltered sees every row.
		expect(driver.countMemories()).toBe(3);
		expect(driver.recentMemories(10).length).toBe(3);
		// Filtered to the human `remember` agent only.
		expect(driver.countMemories({ agents: ['forge remember'] })).toBe(2);
		expect(driver.recentMemories(10, { agents: ['forge remember'] }).map(entry => entry.key).sort()).toEqual(['h1', 'h2']);
	});

	test('searchMemoriesRanked finds a row by its tag (tags_json is indexed)', () => {
		const driver = makeDriver();
		driver.recordMemory({ key: 's1', value: 'rotate the signing key', sourceAgent: 'forge remember', tags: ['security'] });
		driver.recordMemory({ key: 's2', value: 'unrelated note', sourceAgent: 'forge remember', tags: ['chore'] });

		expect(driver.searchMemoriesRanked('security', 10).map(entry => entry.key)).toEqual(['s1']);
	});

	test('backfills the FTS index for rows written before it existed (upgrade path)', async () => {
		const driver = makeDriver();
		// Simulate a pre-FTS DB: create kernel_memories (migration 005) and insert rows
		// DIRECTLY, with NO FTS table/triggers yet — exactly a DB upgraded from before this
		// feature, or one whose rows were written by the insights engine. These rows never
		// pass through the live AFTER-INSERT trigger.
		const { buildMemoryProjectionMigration } = require('../../lib/kernel/migrations');
		for (const statement of buildMemoryProjectionMigration().apply) {
			await driver.exec(statement);
		}
		await driver.exec(
			"INSERT INTO kernel_memories (key, value_json, source_agent, tags_json, created_at, updated_at) "
			+ "VALUES ('pre1', '\"auth bug in login\"', 'forge insights', '[]', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')",
		);
		await driver.exec(
			"INSERT INTO kernel_memories (key, value_json, source_agent, tags_json, created_at, updated_at) "
			+ "VALUES ('pre2', '\"unrelated note\"', 'forge insights', '[]', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')",
		);

		// The first memory read triggers ensureMemorySchema, which must CREATE and BACKFILL
		// the index — otherwise these pre-existing rows are invisible to FTS recall.
		expect(driver.searchMemoriesRanked('auth', 10).map(entry => entry.key)).toEqual(['pre1']);
	});
});
