'use strict';

const { describe, expect, test } = require('bun:test');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

const exportCommand = require('../../lib/commands/export');
const {
	normalizeProjectionModel,
	writeProjection,
} = require('../../lib/kernel/projection-jsonl-writer');

const NOW = '2026-06-18T00:00:00.000Z';

function tmpRoot() {
	return fs.mkdtempSync(path.join(os.tmpdir(), 'forge-export-'));
}

function makeBroker({ pending = [], model = { issues: [], comments: [], dependencies: [] } } = {}) {
	const calls = { delivered: [], listed: 0 };
	return {
		calls,
		async listProjectionOutbox() { calls.listed += 1; return pending; },
		async loadProjectionModel() { return model; },
		async markProjectionDelivered(ids) { calls.delivered.push(ids); },
		async recordProjectionFailure() {},
		async deadLetterProjection() {},
	};
}

describe('forge export command contract', () => {
	test('has the registry-required shape', () => {
		expect(exportCommand.name).toBe('export');
		expect(typeof exportCommand.description).toBe('string');
		expect(typeof exportCommand.handler).toBe('function');
	});
});

describe('forge export — graceful skip', () => {
	test('skips when no Kernel broker is available', async () => {
		const root = tmpRoot();
		const result = await exportCommand.handler([], {}, root, { _now: NOW });
		expect(result.success).toBe(true);
		expect(result.exported).toBe(false);
		expect(result.skipped).toBe(true);
		expect(result.message).toMatch(/no kernel broker/i);
	});
});

describe('forge export — export path (DI broker)', () => {
	test('drains pending entries and writes the snapshot to .forge/kernel', async () => {
		const root = tmpRoot();
		const model = { issues: [{ id: 'forge-1', title: 'T', created_at: NOW, updated_at: NOW }], comments: [], dependencies: [] };
		const pending = [{ id: 'ob-1', event_id: 'ev-1', target: 'jsonl', status: 'pending', attempts: 0 }];
		const broker = makeBroker({ pending, model });

		const result = await exportCommand.handler([], {}, root, { _broker: broker, _now: NOW });

		expect(result.success).toBe(true);
		expect(result.exported).toBe(true);
		expect(result.drained).toBe(1);
		expect(broker.calls.delivered[0]).toEqual(['ob-1']);
		expect(result.dir).toBe(path.resolve(root, '.forge', 'kernel'));
		expect(fs.existsSync(path.join(root, '.forge', 'kernel', 'manifest.json'))).toBe(true);
	});

	test('honors --dir override (resolved under the project root)', async () => {
		const root = tmpRoot();
		const pending = [{ id: 'ob-1', event_id: 'ev-1', target: 'jsonl', status: 'pending', attempts: 0 }];
		const broker = makeBroker({ pending });

		const result = await exportCommand.handler(['--dir=snapshots/kernel'], {}, root, { _broker: broker, _now: NOW });

		expect(result.dir).toBe(path.resolve(root, 'snapshots', 'kernel'));
		expect(fs.existsSync(path.join(root, 'snapshots', 'kernel', 'manifest.json'))).toBe(true);
	});

	test('--dry-run reports pending count without writing', async () => {
		const root = tmpRoot();
		const pending = [
			{ id: 'ob-1', event_id: 'ev-1', target: 'jsonl', status: 'pending', attempts: 0 },
			{ id: 'ob-2', event_id: 'ev-2', target: 'jsonl', status: 'pending', attempts: 0 },
		];
		const broker = makeBroker({ pending });

		const result = await exportCommand.handler(['--dry-run'], {}, root, { _broker: broker, _now: NOW });

		expect(result.dryRun).toBe(true);
		expect(result.exported).toBe(false);
		expect(result.pending).toBe(2);
		expect(broker.calls.delivered).toEqual([]);
		expect(fs.existsSync(path.join(root, '.forge', 'kernel', 'manifest.json'))).toBe(false);
	});

	test('--json emits a JSON output string', async () => {
		const root = tmpRoot();
		const broker = makeBroker({ pending: [] });

		const result = await exportCommand.handler(['--json'], {}, root, { _broker: broker, _now: NOW });

		expect(result.json).toBe(true);
		expect(() => JSON.parse(result.output)).not.toThrow();
	});
});

describe('forge export — import / bootstrap path', () => {
	test('--import reads a committed snapshot from disk', async () => {
		const root = tmpRoot();
		const dir = path.join(root, '.forge', 'kernel');
		const model = normalizeProjectionModel({
			issues: [{ id: 'forge-1', title: 'T', type: 'task', status: 'open', priority: 'P2', priority_rank: 0, created_at: NOW, updated_at: NOW, entity_revision: 1 }],
			comments: [],
			dependencies: [],
		});
		writeProjection({ model, projectionDir: dir });

		const result = await exportCommand.handler(['--import'], {}, root, { _now: NOW });

		expect(result.success).toBe(true);
		expect(result.imported).toBe(true);
		expect(result.counts).toEqual({ issues: 1, comments: 0, dependencies: 0 });
		expect(result.dir).toBe(path.resolve(dir));
	});

	test('--import is a graceful no-op when no snapshot exists', async () => {
		const root = tmpRoot();
		const result = await exportCommand.handler(['--import'], {}, root, { _now: NOW });

		expect(result.success).toBe(true);
		expect(result.imported).toBe(false);
		expect(result.message).toMatch(/no projection snapshot/i);
	});

	test('--import surfaces an integrity error on a tampered snapshot', async () => {
		const root = tmpRoot();
		const dir = path.join(root, '.forge', 'kernel');
		const model = normalizeProjectionModel({ issues: [], comments: [], dependencies: [] });
		writeProjection({ model, projectionDir: dir });
		const manifestPath = path.join(dir, 'manifest.json');
		const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
		manifest.content_sha256 = 'c'.repeat(64);
		fs.writeFileSync(manifestPath, JSON.stringify(manifest));

		const result = await exportCommand.handler(['--import'], {}, root, { _now: NOW });

		expect(result.success).toBe(false);
		expect(result.error).toMatch(/sha256/i);
	});
});
