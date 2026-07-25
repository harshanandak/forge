const { describe, test, expect } = require('bun:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const { appendCappedJsonlRecord } = require('../lib/capped-jsonl-log');

const LOG_NAME = '.forge/capped-log-test.jsonl';

function readJsonlFile(logPath) {
	return fs
		.readFileSync(logPath, 'utf8')
		.split('\n')
		.filter(Boolean)
		.map(line => JSON.parse(line));
}

function createTempDir() {
	return fs.mkdtempSync(path.join(os.tmpdir(), 'forge-capped-jsonl-'));
}

function seedJsonl(logPath, count) {
	fs.mkdirSync(path.dirname(logPath), { recursive: true });
	const seeded = Array.from({ length: count }, (_, index) => JSON.stringify({ seq: index }));
	fs.writeFileSync(logPath, `${seeded.join('\n')}\n`, 'utf8');
}

const APPEND_WORKER = `
const { appendCappedJsonlRecord } = require(process.argv[2]);
const [logPath, writer, count, maxRecords] = process.argv.slice(3);
for (let index = 0; index < Number(count); index += 1) {
	appendCappedJsonlRecord(logPath, { writer, index }, Number(maxRecords));
}
`;

/**
 * Two real processes appending to one log — the interleaving parallel agents
 * actually hit when their hooks and commands write at the same moment.
 */
function runConcurrentWriters(root, { count, maxRecords }) {
	const workerPath = path.join(root, 'append-worker.js');
	fs.writeFileSync(workerPath, APPEND_WORKER, 'utf8');
	const modulePath = require.resolve('../lib/capped-jsonl-log');
	const logPath = path.join(root, LOG_NAME);

	return Promise.all(
		['alpha', 'beta'].map(
			writer =>
				new Promise((resolve, reject) => {
					const child = spawn(
						process.execPath,
						[workerPath, modulePath, logPath, writer, String(count), String(maxRecords)],
						{ stdio: 'ignore' },
					);
					child.on('error', reject);
					child.on('exit', code =>
						code === 0 ? resolve() : reject(new Error(`writer ${writer} exited with ${code}`)),
					);
				}),
		),
	).then(() => logPath);
}

describe('capped jsonl log', () => {
	test('creates the log directory and appends one line per record', () => {
		const root = createTempDir();
		try {
			const logPath = path.join(root, LOG_NAME);

			expect(appendCappedJsonlRecord(logPath, { seq: 1 }, 10)).toBe(1);
			expect(appendCappedJsonlRecord(logPath, { seq: 2 }, 10)).toBe(2);
			expect(readJsonlFile(logPath)).toEqual([{ seq: 1 }, { seq: 2 }]);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	test('trims the oldest records once the log passes its cap', () => {
		const root = createTempDir();
		try {
			const logPath = path.join(root, LOG_NAME);
			seedJsonl(logPath, 12);

			expect(appendCappedJsonlRecord(logPath, { seq: 'newest' }, 10)).toBe(10);

			const records = readJsonlFile(logPath);
			expect(records).toHaveLength(10);
			expect(records[0].seq).toBe(3);
			expect(records[records.length - 1].seq).toBe('newest');
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	test('concurrent writers do not lose each other appended records', async () => {
		const root = createTempDir();
		try {
			const logPath = await runConcurrentWriters(root, { count: 60, maxRecords: 10000 });

			const records = readJsonlFile(logPath);
			expect(records).toHaveLength(120);
			expect(records.filter(record => record.writer === 'alpha')).toHaveLength(60);
			expect(records.filter(record => record.writer === 'beta')).toHaveLength(60);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	test('a contended trim leaves valid JSONL and still converges to the cap', async () => {
		const root = createTempDir();
		try {
			const logPath = await runConcurrentWriters(root, { count: 60, maxRecords: 25 });

			// Every surviving line parses: the trim rewrites through a temp file and
			// renames, so no writer can observe or leave a half-written log.
			expect(() => readJsonlFile(logPath)).not.toThrow();

			// A writer that loses the lock race skips its trim, so the log can sit
			// above the cap until the next uncontended write brings it back down.
			appendCappedJsonlRecord(logPath, { writer: 'final' }, 25);
			expect(readJsonlFile(logPath)).toHaveLength(25);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	test('preserves a record appended between the trim snapshot and its rename', () => {
		const root = createTempDir();
		const realWriteFileSync = fs.writeFileSync;
		const realAppendFileSync = fs.appendFileSync;
		try {
			const logPath = path.join(root, LOG_NAME);
			seedJsonl(logPath, 12);

			// Land records in the exact window the rename used to destroy: once after
			// the trim writes its temp file, then again while it drains that first
			// record across, so the drain has to loop rather than pass once.
			let racers = 0;
			fs.writeFileSync = (target, ...rest) => {
				realWriteFileSync(target, ...rest);
				if (String(target).endsWith('.tmp') && racers === 0) {
					racers += 1;
					realAppendFileSync(logPath, `${JSON.stringify({ seq: 'racer-1' })}\n`, 'utf8');
				}
			};
			fs.appendFileSync = (target, ...rest) => {
				realAppendFileSync(target, ...rest);
				if (String(target).endsWith('.tmp') && racers === 1) {
					racers += 1;
					realAppendFileSync(logPath, `${JSON.stringify({ seq: 'racer-2' })}\n`, 'utf8');
				}
			};

			appendCappedJsonlRecord(logPath, { seq: 'newest' }, 10);

			expect(racers).toBe(2);
			const seqs = readJsonlFile(logPath).map(record => record.seq);
			expect(seqs).toContain('racer-1');
			expect(seqs).toContain('racer-2');
			// The drained records land after the kept window, in append order.
			expect(seqs.slice(-3)).toEqual(['newest', 'racer-1', 'racer-2']);
		} finally {
			fs.writeFileSync = realWriteFileSync;
			fs.appendFileSync = realAppendFileSync;
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	test('keeps every writer contiguous when trims run under concurrent appends', async () => {
		const root = createTempDir();
		try {
			// The cap sits far below the 100 records the two writers produce, so the
			// trim rewrite runs constantly while the other process is appending.
			const logPath = await runConcurrentWriters(root, { count: 50, maxRecords: 15 });

			const records = readJsonlFile(logPath);
			expect(records.length).toBeGreaterThanOrEqual(15);

			// A trim keeps a suffix of the log, so each writer's surviving indexes must
			// stay contiguous. A hole means a record was appended during a trim and
			// then dropped by the rename.
			for (const writer of ['alpha', 'beta']) {
				const indexes = records.filter(record => record.writer === writer).map(record => record.index);
				const holes = indexes.filter(
					(index, position) => position > 0 && index !== indexes[position - 1] + 1,
				);
				expect({ writer, holes }).toEqual({ writer, holes: [] });
			}
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
		// Two real processes contending over one lock, so give the writers room to
		// finish their retry sleeps on a loaded CI runner.
	}, 60_000);

	test('skips the trim instead of blocking while another writer holds the lock', () => {
		const root = createTempDir();
		try {
			const logPath = path.join(root, LOG_NAME);
			seedJsonl(logPath, 12);
			fs.writeFileSync(`${logPath}.lock`, '', 'utf8');

			// The record is still appended — only the trim is deferred.
			expect(appendCappedJsonlRecord(logPath, { seq: 'held' }, 10)).toBe(13);
			expect(readJsonlFile(logPath)).toHaveLength(13);

			fs.unlinkSync(`${logPath}.lock`);
			expect(appendCappedJsonlRecord(logPath, { seq: 'free' }, 10)).toBe(10);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	test('reclaims a trim lock left behind by a crashed writer', () => {
		const root = createTempDir();
		try {
			const logPath = path.join(root, LOG_NAME);
			const lockPath = `${logPath}.lock`;
			seedJsonl(logPath, 12);
			fs.writeFileSync(lockPath, '', 'utf8');
			const longAgo = new Date(Date.now() - 60 * 60 * 1000);
			fs.utimesSync(lockPath, longAgo, longAgo);

			expect(appendCappedJsonlRecord(logPath, { seq: 'stale' }, 10)).toBe(10);
			expect(fs.existsSync(lockPath)).toBe(false);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});
});
