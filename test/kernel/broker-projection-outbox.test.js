'use strict';

const { describe, expect, test } = require('bun:test');
const os = require('node:os');
const path = require('node:path');

function makeBroker(driver) {
	const { createLocalBroker } = require('../../lib/kernel/broker');
	return createLocalBroker({
		projectRoot: path.join(os.tmpdir(), 'forge-worktree'),
		gitCommonDir: path.join(os.tmpdir(), 'forge-common-dir'),
		driver,
	});
}

describe('local Kernel broker projection-outbox methods', () => {
	test('listProjectionOutbox delegates filter, context, and config to the driver', async () => {
		const calls = [];
		const rows = [{ id: 'ob-1' }];
		const broker = makeBroker({
			async listProjectionOutbox(filter, context, config) {
				calls.push({ filter, context, config });
				return rows;
			},
		});

		const result = await broker.listProjectionOutbox(
			{ target: 'jsonl', status: 'pending', now: 'NOW' },
			{ actor: 'consumer' },
		);

		expect(result).toBe(rows);
		expect(calls).toHaveLength(1);
		expect(calls[0].filter).toEqual({ target: 'jsonl', status: 'pending', now: 'NOW' });
		expect(calls[0].context).toEqual({ actor: 'consumer' });
		expect(calls[0].config).toMatchObject({ mode: 'local' });
	});

	test('listProjectionOutbox throws when the driver lacks the method', async () => {
		const broker = makeBroker({});
		await expect(broker.listProjectionOutbox({ target: 'jsonl' })).rejects.toThrow(/listProjectionOutbox/);
	});

	test('loadProjectionModel delegates to the driver with config', async () => {
		const model = { issues: [], comments: [], dependencies: [] };
		const calls = [];
		const broker = makeBroker({
			async loadProjectionModel(context, config) {
				calls.push({ context, config });
				return model;
			},
		});

		const result = await broker.loadProjectionModel({ actor: 'x' });

		expect(result).toBe(model);
		expect(calls[0].context).toEqual({ actor: 'x' });
		expect(calls[0].config).toMatchObject({ mode: 'local' });
	});

	test('markProjectionDelivered delegates ids and meta', async () => {
		const calls = [];
		const broker = makeBroker({
			async markProjectionDelivered(ids, meta, context, config) {
				calls.push({ ids, meta, context, config });
				return { updated: ids.length };
			},
		});

		const result = await broker.markProjectionDelivered(['ob-1', 'ob-2'], { now: 'NOW' });

		expect(result).toEqual({ updated: 2 });
		expect(calls[0].ids).toEqual(['ob-1', 'ob-2']);
		expect(calls[0].meta).toEqual({ now: 'NOW' });
		expect(calls[0].config).toMatchObject({ mode: 'local' });
	});

	test('recordProjectionFailure delegates the failure record', async () => {
		const calls = [];
		const broker = makeBroker({
			async recordProjectionFailure(record, context, config) {
				calls.push({ record, context, config });
			},
		});

		await broker.recordProjectionFailure({
			id: 'ob-1', attempts: 1, next_attempt_at: 'LATER', error: 'boom',
		});

		expect(calls[0].record).toEqual({ id: 'ob-1', attempts: 1, next_attempt_at: 'LATER', error: 'boom' });
		expect(calls[0].config).toMatchObject({ mode: 'local' });
	});

	test('deadLetterProjection delegates the dead-letter record', async () => {
		const calls = [];
		const broker = makeBroker({
			async deadLetterProjection(record, context, config) {
				calls.push({ record, context, config });
				return { id: 'dl-1' };
			},
		});

		const result = await broker.deadLetterProjection({
			outbox_id: 'ob-1', target: 'jsonl', error: 'boom', payload_json: '{}', now: 'NOW',
		});

		expect(result).toEqual({ id: 'dl-1' });
		expect(calls[0].record.outbox_id).toBe('ob-1');
		expect(calls[0].record.target).toBe('jsonl');
		expect(calls[0].config).toMatchObject({ mode: 'local' });
	});

	test('read/update methods never invoke the append/CAS path', async () => {
		const forbidden = [];
		const broker = makeBroker({
			async listProjectionOutbox() { return []; },
			async loadProjectionModel() { return { issues: [], comments: [], dependencies: [] }; },
			async markProjectionDelivered() {},
			async enqueueKernelProjection() { forbidden.push('enqueueKernelProjection'); },
			async insertKernelEvent() { forbidden.push('insertKernelEvent'); },
		});

		await broker.listProjectionOutbox({ target: 'jsonl' });
		await broker.loadProjectionModel();
		await broker.markProjectionDelivered(['ob-1'], { now: 'NOW' });

		expect(forbidden).toEqual([]);
	});
});
