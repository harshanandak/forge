'use strict';

const { describe, expect, test } = require('bun:test');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const {
	normalizeProjectionModel,
	buildProjectionSnapshot,
	serializeProjection,
	importProjection,
	writeProjection,
	readProjection,
	runJsonlProjectionConsumer,
	computeBackoff,
	SCHEMA_VERSION,
	DEFAULT_BASE_BACKOFF_MS,
} = require('../../lib/kernel/projection-jsonl-writer');

// Minimal fixtures
const ISSUE_RAW = {
	id: 'forge-1',
	title: 'First issue',
	body: 'Body text',
	type: 'task',
	status: 'open',
	priority: 'P2',
	priority_rank: 0,
	created_at: '2026-01-01T00:00:00.000Z',
	updated_at: '2026-01-01T00:00:00.000Z',
	entity_revision: 1,
	extra_field: 'should be stripped',
};

const ISSUE_RAW_2 = {
	id: 'forge-2',
	title: 'Second issue',
	body: null,
	type: 'bug',
	status: 'closed',
	priority: 'P1',
	priority_rank: 10,
	created_at: '2026-01-02T00:00:00.000Z',
	updated_at: '2026-01-02T00:00:00.000Z',
	entity_revision: 2,
};

const COMMENT_RAW = {
	id: 'c-1',
	issue_id: 'forge-1',
	body: 'A comment',
	actor: 'tester',
	visibility: 'public',
	created_at: '2026-01-01T01:00:00.000Z',
	noise: 'stripped',
};

const DEP_RAW = {
	id: 'dep-1',
	issue_id: 'forge-2',
	blocks_issue_id: 'forge-1',
	dependency_type: 'blocks',
	created_at: '2026-01-01T00:00:00.000Z',
	extra: 'stripped',
};

describe('normalizeProjectionModel', () => {
	test('strips extra fields and adds kind to issues', () => {
		const { issues } = normalizeProjectionModel({ issues: [ISSUE_RAW], comments: [], dependencies: [] });
		expect(issues).toHaveLength(1);
		const issue = issues[0];
		expect(issue.kind).toBe('issue');
		expect(issue.id).toBe('forge-1');
		expect(issue.extra_field).toBeUndefined();
		expect(Object.keys(issue)).toEqual([
			'kind', 'id', 'title', 'body', 'type', 'status',
			'priority', 'priority_rank', 'created_at', 'updated_at', 'entity_revision',
		]);
	});

	test('strips extra fields and adds kind to comments', () => {
		const { comments } = normalizeProjectionModel({ issues: [], comments: [COMMENT_RAW], dependencies: [] });
		expect(comments).toHaveLength(1);
		const comment = comments[0];
		expect(comment.kind).toBe('comment');
		expect(comment.noise).toBeUndefined();
		expect(Object.keys(comment)).toEqual([
			'kind', 'id', 'issue_id', 'body', 'actor', 'visibility', 'created_at',
		]);
	});

	test('strips extra fields and adds kind to dependencies', () => {
		const { dependencies } = normalizeProjectionModel({ issues: [], comments: [], dependencies: [DEP_RAW] });
		expect(dependencies).toHaveLength(1);
		const dep = dependencies[0];
		expect(dep.kind).toBe('dependency');
		expect(dep.extra).toBeUndefined();
		expect(Object.keys(dep)).toEqual([
			'kind', 'id', 'issue_id', 'blocks_issue_id', 'dependency_type', 'created_at',
		]);
	});

	test('handles empty model', () => {
		const result = normalizeProjectionModel({ issues: [], comments: [], dependencies: [] });
		expect(result).toEqual({ issues: [], comments: [], dependencies: [] });
	});

	test('defaults body to null when missing', () => {
		const raw = { ...ISSUE_RAW };
		delete raw.body;
		const { issues } = normalizeProjectionModel({ issues: [raw], comments: [], dependencies: [] });
		expect(issues[0].body).toBeNull();
	});
});

describe('buildProjectionSnapshot', () => {
	test('sorts issues by id', () => {
		const model = normalizeProjectionModel({
			issues: [ISSUE_RAW_2, ISSUE_RAW],
			comments: [],
			dependencies: [],
		});
		const snap = buildProjectionSnapshot(model);
		expect(snap.issues.map(i => i.id)).toEqual(['forge-1', 'forge-2']);
	});

	test('sorts comments by (issue_id, created_at, id)', () => {
		const c1 = { ...COMMENT_RAW, id: 'c-1', issue_id: 'forge-2', created_at: '2026-01-01T01:00:00.000Z' };
		const c2 = { ...COMMENT_RAW, id: 'c-2', issue_id: 'forge-1', created_at: '2026-01-01T02:00:00.000Z' };
		const c3 = { ...COMMENT_RAW, id: 'c-3', issue_id: 'forge-1', created_at: '2026-01-01T01:00:00.000Z' };
		const model = normalizeProjectionModel({ issues: [], comments: [c1, c2, c3], dependencies: [] });
		const snap = buildProjectionSnapshot(model);
		expect(snap.comments.map(c => c.id)).toEqual(['c-3', 'c-2', 'c-1']);
	});

	test('sorts dependencies by (issue_id, blocks_issue_id, dependency_type, id)', () => {
		const d1 = { ...DEP_RAW, id: 'd-1', issue_id: 'forge-2', blocks_issue_id: 'forge-1', dependency_type: 'blocks' };
		const d2 = { ...DEP_RAW, id: 'd-2', issue_id: 'forge-1', blocks_issue_id: 'forge-3', dependency_type: 'blocks' };
		const model = normalizeProjectionModel({ issues: [], comments: [], dependencies: [d1, d2] });
		const snap = buildProjectionSnapshot(model);
		expect(snap.dependencies.map(d => d.id)).toEqual(['d-2', 'd-1']);
	});

	test('produces same result regardless of input order (determinism)', () => {
		const model1 = normalizeProjectionModel({ issues: [ISSUE_RAW, ISSUE_RAW_2], comments: [COMMENT_RAW], dependencies: [DEP_RAW] });
		const model2 = normalizeProjectionModel({ issues: [ISSUE_RAW_2, ISSUE_RAW], comments: [COMMENT_RAW], dependencies: [DEP_RAW] });
		expect(buildProjectionSnapshot(model1)).toEqual(buildProjectionSnapshot(model2));
	});
});

describe('serializeProjection', () => {
	test('produces exactly four file keys', () => {
		const model = normalizeProjectionModel({ issues: [ISSUE_RAW], comments: [COMMENT_RAW], dependencies: [DEP_RAW] });
		const { files } = serializeProjection(model);
		expect(Object.keys(files).sort()).toEqual(['comments.jsonl', 'dependencies.jsonl', 'issues.jsonl', 'manifest.json']);
	});

	test('manifest has schema_version, source, counts, content_sha256 — no timestamp', () => {
		const model = normalizeProjectionModel({ issues: [ISSUE_RAW], comments: [], dependencies: [] });
		const { files } = serializeProjection(model);
		const manifest = JSON.parse(files['manifest.json']);
		expect(manifest.schema_version).toBe(1);
		expect(manifest.source).toBe('kernel');
		expect(manifest.counts).toEqual({ issues: 1, comments: 0, dependencies: 0 });
		expect(typeof manifest.content_sha256).toBe('string');
		expect(manifest.content_sha256).toHaveLength(64);
		expect(manifest.exported_at).toBeUndefined();
	});

	test('byte-identical output for same logical state regardless of input order', () => {
		const m1 = normalizeProjectionModel({ issues: [ISSUE_RAW, ISSUE_RAW_2], comments: [COMMENT_RAW], dependencies: [DEP_RAW] });
		const m2 = normalizeProjectionModel({ issues: [ISSUE_RAW_2, ISSUE_RAW], comments: [COMMENT_RAW], dependencies: [DEP_RAW] });
		const s1 = serializeProjection(m1);
		const s2 = serializeProjection(m2);
		expect(s1.files['issues.jsonl']).toBe(s2.files['issues.jsonl']);
		expect(s1.files['manifest.json']).toBe(s2.files['manifest.json']);
	});

	test('sha256 changes when content changes', () => {
		const m1 = normalizeProjectionModel({ issues: [ISSUE_RAW], comments: [], dependencies: [] });
		const m2 = normalizeProjectionModel({ issues: [ISSUE_RAW_2], comments: [], dependencies: [] });
		const s1 = serializeProjection(m1);
		const s2 = serializeProjection(m2);
		const manifest1 = JSON.parse(s1.files['manifest.json']);
		const manifest2 = JSON.parse(s2.files['manifest.json']);
		expect(manifest1.content_sha256).not.toBe(manifest2.content_sha256);
	});

	test('JSONL files end with newline', () => {
		const model = normalizeProjectionModel({ issues: [ISSUE_RAW], comments: [], dependencies: [] });
		const { files } = serializeProjection(model);
		expect(files['issues.jsonl'].endsWith('\n')).toBe(true);
	});

	test('empty collections produce empty JSONL string', () => {
		const model = normalizeProjectionModel({ issues: [], comments: [], dependencies: [] });
		const { files } = serializeProjection(model);
		expect(files['issues.jsonl']).toBe('');
		expect(files['comments.jsonl']).toBe('');
		expect(files['dependencies.jsonl']).toBe('');
	});
});

describe('importProjection', () => {
	test('round-trip: importProjection(serializeProjection(model)) deep-equals normalized model', () => {
		const model = normalizeProjectionModel({
			issues: [ISSUE_RAW, ISSUE_RAW_2],
			comments: [COMMENT_RAW],
			dependencies: [DEP_RAW],
		});
		const snap = buildProjectionSnapshot(model);
		const { files } = serializeProjection(snap);
		const imported = importProjection(files);
		expect(imported).toEqual(snap);
	});

	test('throws on tampered manifest hash', () => {
		const model = normalizeProjectionModel({ issues: [ISSUE_RAW], comments: [], dependencies: [] });
		const { files } = serializeProjection(model);
		const manifest = JSON.parse(files['manifest.json']);
		manifest.content_sha256 = 'a'.repeat(64);
		const tampered = { ...files, 'manifest.json': JSON.stringify(manifest) };
		expect(() => importProjection(tampered)).toThrow(/sha256/i);
	});

	test('throws on missing manifest', () => {
		const { 'manifest.json': _removed, ...noManifest } = {
			'issues.jsonl': '',
			'comments.jsonl': '',
			'dependencies.jsonl': '',
			'manifest.json': '',
		};
		expect(() => importProjection(noManifest)).toThrow(/manifest/i);
	});
});

describe('writeProjection', () => {
	function tmpDir() {
		return fs.mkdtempSync(path.join(os.tmpdir(), 'forge-proj-'));
	}

	test('writes four files to projectionDir and returns stats', () => {
		const root = tmpDir();
		const dir = path.join(root, '.forge', 'kernel');
		const model = normalizeProjectionModel({ issues: [ISSUE_RAW], comments: [COMMENT_RAW], dependencies: [DEP_RAW] });

		const result = writeProjection({ model, projectionDir: dir });

		expect(result.writes).toBe(4);
		expect(result.bytes).toBeGreaterThan(0);
		expect(result.dir).toBe(path.resolve(dir));
		expect(result.files.slice().sort()).toEqual([
			'comments.jsonl', 'dependencies.jsonl', 'issues.jsonl', 'manifest.json',
		]);
		expect(fs.existsSync(path.join(dir, 'issues.jsonl'))).toBe(true);
		expect(fs.existsSync(path.join(dir, 'manifest.json'))).toBe(true);
	});

	test('creates nested projectionDir when missing', () => {
		const dir = path.join(tmpDir(), 'a', 'b', 'c');
		const model = normalizeProjectionModel({ issues: [], comments: [], dependencies: [] });

		writeProjection({ model, projectionDir: dir });

		expect(fs.existsSync(path.join(dir, 'manifest.json'))).toBe(true);
	});

	test('written files re-import to the same snapshot (on-disk round-trip)', () => {
		const dir = path.join(tmpDir(), '.forge', 'kernel');
		const model = normalizeProjectionModel({
			issues: [ISSUE_RAW, ISSUE_RAW_2],
			comments: [COMMENT_RAW],
			dependencies: [DEP_RAW],
		});
		const snap = buildProjectionSnapshot(model);

		writeProjection({ model, projectionDir: dir });

		const files = {};
		for (const name of ['issues.jsonl', 'comments.jsonl', 'dependencies.jsonl', 'manifest.json']) {
			files[name] = fs.readFileSync(path.join(dir, name), 'utf8');
		}
		expect(importProjection(files)).toEqual(snap);
	});

	test('rolls back prior file contents when a rename fails mid-write', () => {
		const dir = path.join(tmpDir(), '.forge', 'kernel');
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(path.join(dir, 'issues.jsonl'), 'OLD-ISSUES\n');

		const model = normalizeProjectionModel({ issues: [ISSUE_RAW], comments: [], dependencies: [] });
		const failingFs = {
			...fs,
			renameSync(src, dest) {
				if (String(dest).includes('manifest.json')) {
					throw new Error('simulated rename failure');
				}
				return fs.renameSync(src, dest);
			},
		};

		expect(() => writeProjection({ model, projectionDir: dir, fsImpl: failingFs })).toThrow(/rename/i);
		// issues.jsonl had already been renamed; rollback must restore old content.
		expect(fs.readFileSync(path.join(dir, 'issues.jsonl'), 'utf8')).toBe('OLD-ISSUES\n');
		// no stray temp files left behind
		const stray = fs.readdirSync(dir).filter(name => name.includes('.tmp-'));
		expect(stray).toEqual([]);
	});

	test('uses per-write unique temp filenames to avoid concurrent collisions', () => {
		const dir = path.join(tmpDir(), '.forge', 'kernel');
		const model = normalizeProjectionModel({ issues: [ISSUE_RAW], comments: [], dependencies: [] });

		function capturingFs() {
			const temps = [];
			const io = {
				...fs,
				writeFileSync(target, data) {
					if (String(target).includes('.tmp-')) temps.push(path.basename(target));
					return fs.writeFileSync(target, data);
				},
			};
			return { io, temps };
		}

		const first = capturingFs();
		const second = capturingFs();
		writeProjection({ model, projectionDir: dir, fsImpl: first.io });
		writeProjection({ model, projectionDir: dir, fsImpl: second.io });

		// no predictable static name that two concurrent writers would share
		expect(first.temps).not.toContain('.tmp-issues.jsonl');
		// the two writes must not reuse the same temp basenames
		const shared = first.temps.filter(name => second.temps.includes(name));
		expect(shared).toEqual([]);
	});

	test('rejects a projectionDir outside projectRoot', () => {
		const root = tmpDir();
		const outside = path.join(os.tmpdir(), `evil-${path.basename(root)}`);
		const model = normalizeProjectionModel({ issues: [], comments: [], dependencies: [] });

		expect(() => writeProjection({ model, projectionDir: outside, projectRoot: root }))
			.toThrow(/project root/i);
	});
});

describe('committed fixtures (byte-match + round-trip)', () => {
	const FIXTURE_DIR = path.join(__dirname, '..', 'fixtures', 'kernel-projection');

	function readFixture(name) {
		return fs.readFileSync(path.join(FIXTURE_DIR, name), 'utf8');
	}

	test('serializing the fixture model reproduces the committed JSONL byte-for-byte', () => {
		const raw = JSON.parse(readFixture('model.json'));
		const model = normalizeProjectionModel(raw);
		const { files } = serializeProjection(model);

		for (const name of ['issues.jsonl', 'comments.jsonl', 'dependencies.jsonl', 'manifest.json']) {
			// fixtures are stored with LF (enforced via .gitattributes eol=lf); compare
			// raw bytes so a CRLF regression on checkout is actually caught here.
			expect(files[name]).toBe(readFixture(name));
		}
	});

	test('importing the committed fixtures reconstructs the sorted snapshot', () => {
		const files = {};
		for (const name of ['issues.jsonl', 'comments.jsonl', 'dependencies.jsonl', 'manifest.json']) {
			files[name] = readFixture(name);
		}
		const imported = importProjection(files);
		const expected = buildProjectionSnapshot(normalizeProjectionModel(JSON.parse(readFixture('model.json'))));
		expect(imported).toEqual(expected);
	});
});

describe('projection integrity hardening', () => {
	test('serializeProjection canonicalizes raw (un-normalized) rows defensively', () => {
		// Raw rows as a DB driver would return them: extra columns, no `kind`,
		// shuffled order. serializeProjection must still produce canonical,
		// deterministic bytes identical to pre-normalized input.
		const rawModel = { issues: [ISSUE_RAW_2, ISSUE_RAW], comments: [COMMENT_RAW], dependencies: [DEP_RAW] };
		const fromRaw = serializeProjection(rawModel);
		const fromNormalized = serializeProjection(normalizeProjectionModel(rawModel));

		expect(fromRaw.files).toEqual(fromNormalized.files);

		const firstIssue = JSON.parse(fromRaw.files['issues.jsonl'].split('\n')[0]);
		expect(firstIssue.kind).toBe('issue');
		expect(firstIssue.extra_field).toBeUndefined();
	});

	test('importProjection rejects a record whose kind does not match its file', () => {
		// Move a comment line into issues.jsonl. Concatenation is byte-identical,
		// so the sha256 still matches — only the per-file kind check catches this.
		const model = normalizeProjectionModel({ issues: [ISSUE_RAW], comments: [COMMENT_RAW], dependencies: [] });
		const { files } = serializeProjection(model);
		const tampered = {
			...files,
			'issues.jsonl': files['issues.jsonl'] + files['comments.jsonl'],
			'comments.jsonl': '',
		};

		expect(() => importProjection(tampered)).toThrow(/kind|issues\.jsonl/i);
	});

	test('importProjection rejects per-file counts that disagree with the manifest', () => {
		const model = normalizeProjectionModel({ issues: [ISSUE_RAW, ISSUE_RAW_2], comments: [], dependencies: [] });
		const { files } = serializeProjection(model);
		// drop one issue line but keep the manifest counts/hash inconsistent by
		// recomputing the hash so we isolate the count check, not the hash check.
		const oneIssue = files['issues.jsonl'].split('\n').filter(Boolean)[0] + '\n';
		const manifest = JSON.parse(files['manifest.json']);
		manifest.content_sha256 = crypto.createHash('sha256')
			.update(oneIssue).update('').update('').digest('hex');
		const tampered = {
			'issues.jsonl': oneIssue,
			'comments.jsonl': '',
			'dependencies.jsonl': '',
			'manifest.json': JSON.stringify(manifest),
		};

		expect(() => importProjection(tampered)).toThrow(/count/i);
	});
});

describe('readProjection', () => {
	function tmpDir() {
		return fs.mkdtempSync(path.join(os.tmpdir(), 'forge-proj-'));
	}

	test('returns null when no manifest is present', () => {
		const dir = path.join(tmpDir(), '.forge', 'kernel');
		expect(readProjection({ projectionDir: dir })).toBeNull();
	});

	test('reads a written snapshot back to the same model', () => {
		const dir = path.join(tmpDir(), '.forge', 'kernel');
		const model = normalizeProjectionModel({
			issues: [ISSUE_RAW, ISSUE_RAW_2],
			comments: [COMMENT_RAW],
			dependencies: [DEP_RAW],
		});
		const snap = buildProjectionSnapshot(model);

		writeProjection({ model, projectionDir: dir });
		const result = readProjection({ projectionDir: dir });

		expect(result.dir).toBe(path.resolve(dir));
		expect(result.model).toEqual(snap);
	});

	test('throws when the on-disk manifest hash is tampered', () => {
		const dir = path.join(tmpDir(), '.forge', 'kernel');
		const model = normalizeProjectionModel({ issues: [ISSUE_RAW], comments: [], dependencies: [] });
		writeProjection({ model, projectionDir: dir });

		const manifestPath = path.join(dir, 'manifest.json');
		const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
		manifest.content_sha256 = 'b'.repeat(64);
		fs.writeFileSync(manifestPath, JSON.stringify(manifest));

		expect(() => readProjection({ projectionDir: dir })).toThrow(/sha256/i);
	});
});

describe('runJsonlProjectionConsumer', () => {
	const NOW = '2026-06-18T00:00:00.000Z';

	function makeBroker(overrides = {}) {
		const calls = {
			listProjectionOutbox: [],
			loadProjectionModel: 0,
			markProjectionDelivered: [],
			recordProjectionFailure: [],
			deadLetterProjection: [],
		};
		const broker = {
			async listProjectionOutbox(args) {
				calls.listProjectionOutbox.push(args);
				return overrides.pending || [];
			},
			async loadProjectionModel() {
				calls.loadProjectionModel += 1;
				return overrides.model || { issues: [], comments: [], dependencies: [] };
			},
			async markProjectionDelivered(ids, meta) {
				calls.markProjectionDelivered.push({ ids, meta });
			},
			async recordProjectionFailure(args) {
				calls.recordProjectionFailure.push(args);
			},
			async deadLetterProjection(args) {
				calls.deadLetterProjection.push(args);
			},
		};
		return { broker, calls };
	}

	test('drains pending entries, writes once, and marks delivered', async () => {
		const pending = [
			{ id: 'ob-1', event_id: 'ev-1', target: 'jsonl', status: 'pending', attempts: 0 },
			{ id: 'ob-2', event_id: 'ev-2', target: 'jsonl', status: 'pending', attempts: 0 },
		];
		const model = { issues: [ISSUE_RAW], comments: [], dependencies: [] };
		const { broker, calls } = makeBroker({ pending, model });
		const writes = [];
		const writer = args => {
			writes.push(args);
			return { dir: args.projectionDir, writes: 4, bytes: 10, files: ['issues.jsonl'] };
		};

		const result = await runJsonlProjectionConsumer({
			broker, projectionDir: '.forge/kernel', projectRoot: '/repo', now: NOW, writer,
		});

		expect(writes).toHaveLength(1);
		expect(writes[0].model).toBe(model);
		expect(writes[0].projectionDir).toBe('.forge/kernel');
		expect(writes[0].projectRoot).toBe('/repo');
		expect(calls.loadProjectionModel).toBe(1);
		expect(calls.markProjectionDelivered).toHaveLength(1);
		expect(calls.markProjectionDelivered[0].ids).toEqual(['ob-1', 'ob-2']);
		expect(result.written).toBe(true);
		expect(result.drained).toBe(2);
		expect(result.delivered).toEqual(['ob-1', 'ob-2']);
	});

	test('does nothing when there are no pending entries', async () => {
		const { broker, calls } = makeBroker({ pending: [] });
		let writerCalled = false;
		const writer = () => { writerCalled = true; };

		const result = await runJsonlProjectionConsumer({ broker, now: NOW, writer });

		expect(writerCalled).toBe(false);
		expect(calls.loadProjectionModel).toBe(0);
		expect(calls.markProjectionDelivered).toEqual([]);
		expect(result).toMatchObject({ drained: 0, written: false });
	});

	test('on write failure below maxAttempts increments attempts with backoff', async () => {
		const pending = [{ id: 'ob-1', event_id: 'ev-1', target: 'jsonl', status: 'pending', attempts: 0 }];
		const { broker, calls } = makeBroker({ pending });
		const writer = () => { throw new Error('disk full'); };

		const result = await runJsonlProjectionConsumer({
			broker, now: NOW, maxAttempts: 5, baseBackoffMs: 5000, writer,
		});

		expect(calls.recordProjectionFailure).toHaveLength(1);
		const failure = calls.recordProjectionFailure[0];
		expect(failure.id).toBe('ob-1');
		expect(failure.attempts).toBe(1);
		expect(failure.error).toMatch(/disk full/);
		// backoff = now + base * 2^(attempts-1) = now + 5000ms
		expect(Date.parse(failure.next_attempt_at)).toBe(Date.parse(NOW) + 5000);
		expect(calls.deadLetterProjection).toEqual([]);
		expect(result).toMatchObject({ written: false, retried: ['ob-1'], dead: [] });
	});

	test('dead-letters an entry once attempts reach maxAttempts', async () => {
		const pending = [{ id: 'ob-1', event_id: 'ev-1', target: 'jsonl', status: 'pending', attempts: 4 }];
		const { broker, calls } = makeBroker({ pending });
		const writer = () => { throw new Error('still failing'); };

		const result = await runJsonlProjectionConsumer({
			broker, now: NOW, maxAttempts: 5, writer,
		});

		expect(calls.deadLetterProjection).toHaveLength(1);
		const dead = calls.deadLetterProjection[0];
		expect(dead.outbox_id).toBe('ob-1');
		expect(dead.target).toBe('jsonl');
		expect(dead.error).toMatch(/still failing/);
		expect(calls.recordProjectionFailure).toEqual([]);
		expect(result).toMatchObject({ written: false, dead: ['ob-1'], retried: [] });
	});
});

describe('PR #218 review hardening', () => {
	function tmpDir() {
		return fs.mkdtempSync(path.join(os.tmpdir(), 'forge-proj-'));
	}

	test('exposes SCHEMA_VERSION and DEFAULT_BASE_BACKOFF_MS', () => {
		expect(SCHEMA_VERSION).toBe(1);
		expect(DEFAULT_BASE_BACKOFF_MS).toBe(5000);
	});

	test('computeBackoff throws a clear, attributable error for an invalid now', () => {
		// must name `now` (not a bare RangeError "Invalid time value" that masks the
		// real write error inside the consumer's catch block)
		expect(() => computeBackoff('not-a-timestamp', 1, 5000)).toThrow(/now/i);
	});

	test('importProjection rejects a manifest with no counts field', () => {
		const model = normalizeProjectionModel({ issues: [ISSUE_RAW], comments: [], dependencies: [] });
		const { files } = serializeProjection(model);
		const manifest = JSON.parse(files['manifest.json']);
		delete manifest.counts; // hash is over the JSONL bytes, so it still matches
		const tampered = { ...files, 'manifest.json': JSON.stringify(manifest) };

		expect(() => importProjection(tampered)).toThrow(/count/i);
	});

	test('writeProjection canonicalizes raw rows before persistence', () => {
		const dir = path.join(tmpDir(), '.forge', 'kernel');
		const rawModel = { issues: [ISSUE_RAW], comments: [COMMENT_RAW], dependencies: [DEP_RAW] };

		writeProjection({ model: rawModel, projectionDir: dir });
		const result = readProjection({ projectionDir: dir });

		expect(result.model.issues[0].kind).toBe('issue');
		expect(result.model.issues[0].extra_field).toBeUndefined();
		expect(Object.keys(result.model.issues[0])).toEqual([
			'kind', 'id', 'title', 'body', 'type', 'status',
			'priority', 'priority_rank', 'created_at', 'updated_at', 'entity_revision',
		]);
	});

	test('rolls back cleanly when the first rename fails (nothing committed yet)', () => {
		const dir = path.join(tmpDir(), '.forge', 'kernel');
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(path.join(dir, 'issues.jsonl'), 'OLD-ISSUES\n');
		const model = normalizeProjectionModel({ issues: [ISSUE_RAW], comments: [], dependencies: [] });
		const failingFs = {
			...fs,
			renameSync(src, dest) {
				if (String(dest).endsWith(`${path.sep}issues.jsonl`)) throw new Error('first rename failed');
				return fs.renameSync(src, dest);
			},
		};

		expect(() => writeProjection({ model, projectionDir: dir, fsImpl: failingFs })).toThrow(/first rename/);
		// first rename failed → nothing committed → old content intact
		expect(fs.readFileSync(path.join(dir, 'issues.jsonl'), 'utf8')).toBe('OLD-ISSUES\n');
		expect(fs.readdirSync(dir).filter(name => name.includes('.tmp-'))).toEqual([]);
		expect(fs.existsSync(path.join(dir, '.export.lock'))).toBe(false);
	});

	test('refuses to publish when another export holds the directory lock', () => {
		const dir = path.join(tmpDir(), '.forge', 'kernel');
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(path.join(dir, '.export.lock'), 'held-by-other-pid');
		const model = normalizeProjectionModel({ issues: [ISSUE_RAW], comments: [], dependencies: [] });

		expect(() => writeProjection({ model, projectionDir: dir })).toThrow(/export.*(progress|lock)|lock/i);
		// a pre-existing (foreign) lock must NOT be deleted by the loser
		expect(fs.existsSync(path.join(dir, '.export.lock'))).toBe(true);
		// and the loser must not leave its temp files behind
		expect(fs.readdirSync(dir).filter(name => name.includes('.tmp-'))).toEqual([]);
	});

	test('releases the directory lock after a successful publish', () => {
		const dir = path.join(tmpDir(), '.forge', 'kernel');
		const model = normalizeProjectionModel({ issues: [ISSUE_RAW], comments: [], dependencies: [] });

		writeProjection({ model, projectionDir: dir });

		expect(fs.existsSync(path.join(dir, '.export.lock'))).toBe(false);
	});
});
