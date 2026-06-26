'use strict';

// Project-memory read-model driver primitives. Memory rows are written DIRECTLY to
// kernel_memories (NOT through the issue CAS/guarded-event path), so these methods are
// synchronous and self-sufficient: each lazily ensures the table exists, which lets
// project-memory persist without first awaiting the async broker.initialize().
const { afterEach, describe, expect, test } = require('bun:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createBuiltinSQLiteDriver } = require('../../lib/kernel/sqlite-driver');

const tmpDirs = [];
const drivers = [];

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
