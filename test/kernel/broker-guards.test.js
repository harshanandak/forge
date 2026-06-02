const { describe, expect, test } = require('bun:test');
const os = require('node:os');
const path = require('node:path');

describe('local Kernel broker guard ordering', () => {
	test('inserts a conflict and skips projection for quarantined writes', async () => {
		const { createLocalBroker } = require('../../lib/kernel/broker');
		const calls = [];
		const broker = createLocalBroker({
			projectRoot: path.join(os.tmpdir(), 'forge-worktree'),
			gitCommonDir: path.join(os.tmpdir(), 'forge-common-dir'),
			driver: {
				async loadKernelEntity() {
					return { entity_revision: 3 };
				},
				async listKernelEvents() {
					return [];
				},
				async loadKernelEventByIdempotencyKey() {
					return null;
				},
				async listKernelDependencies() {
					return [];
				},
				async insertKernelConflict(conflict) {
					calls.push(['conflict', conflict.reason]);
					return { ...conflict, id: 'conflict-1' };
				},
				async insertKernelEvent(event) {
					calls.push(['event', event.event_type]);
					return { ...event, id: 'event-1' };
				},
				async enqueueKernelProjection(outboxEntry) {
					calls.push(['projection', outboxEntry.target]);
					return { ...outboxEntry, id: 'outbox-1' };
				},
			},
		});

		const result = await broker.runGuardedEvent({
			entity_type: 'issue',
			entity_id: 'forge-1',
			event_type: 'issue.update',
			idempotency_key: 'issue-update:forge-1:rev-2',
			expected_revision: 2,
			payload: { title: 'Renamed' },
		});

		expect(result.decision).toBe('quarantine');
		expect(calls).toEqual([['conflict', 'stale_revision']]);
	});

	test('inserts accepted events before projection outbox entries', async () => {
		const { createLocalBroker } = require('../../lib/kernel/broker');
		const calls = [];
		const broker = createLocalBroker({
			projectRoot: path.join(os.tmpdir(), 'forge-worktree'),
			gitCommonDir: path.join(os.tmpdir(), 'forge-common-dir'),
			driver: {
				async loadKernelEntity() {
					return { entity_revision: 2 };
				},
				async listKernelEvents() {
					return [];
				},
				async loadKernelEventByIdempotencyKey() {
					return null;
				},
				async listKernelDependencies() {
					return [];
				},
				async insertKernelConflict(conflict) {
					calls.push(['conflict', conflict.reason]);
					return conflict;
				},
				async insertKernelEvent(event) {
					calls.push(['event', event.event_type]);
					return { ...event, id: 'event-1' };
				},
				async enqueueKernelProjection(outboxEntry) {
					calls.push(['projection', outboxEntry.target]);
					return { ...outboxEntry, id: 'outbox-1' };
				},
			},
		});

		const result = await broker.runGuardedEvent({
			entity_type: 'issue',
			entity_id: 'forge-1',
			event_type: 'issue.update',
			idempotency_key: 'issue-update:forge-1:rev-2',
			expected_revision: 2,
			payload: { title: 'Renamed' },
		}, { projectionTarget: 'beads' });

		expect(result.decision).toBe('accept');
		expect(calls).toEqual([
			['event', 'issue.update'],
			['projection', 'beads'],
		]);
	});

	test('returns idempotency replays accepted for any entity before inserting', async () => {
		const { createLocalBroker } = require('../../lib/kernel/broker');
		const calls = [];
		const originalEvent = {
			id: 'event-original',
			entity_type: 'issue',
			entity_id: 'forge-other',
			event_type: 'issue.close',
			idempotency_key: 'close:shared-key',
			payload_json: '{"status":"closed"}',
		};
		const broker = createLocalBroker({
			projectRoot: path.join(os.tmpdir(), 'forge-worktree'),
			gitCommonDir: path.join(os.tmpdir(), 'forge-common-dir'),
			driver: {
				async loadKernelEntity() {
					return { entity_revision: 2 };
				},
				async listKernelEvents() {
					return [];
				},
				async loadKernelEventByIdempotencyKey(idempotencyKey) {
					calls.push(['idempotency', idempotencyKey]);
					return originalEvent;
				},
				async insertKernelConflict(conflict) {
					calls.push(['conflict', conflict.reason]);
					return conflict;
				},
				async insertKernelEvent(event) {
					calls.push(['event', event.event_type]);
					return event;
				},
				async enqueueKernelProjection(outboxEntry) {
					calls.push(['projection', outboxEntry.target]);
					return outboxEntry;
				},
			},
		});

		const result = await broker.runGuardedEvent({
			entity_type: 'issue',
			entity_id: 'forge-1',
			event_type: 'issue.close',
			idempotency_key: 'close:shared-key',
			expected_revision: 2,
			payload: { status: 'closed' },
		});

		expect(result).toMatchObject({
			decision: 'duplicate',
			originalEvent,
			projection: false,
		});
		expect(calls).toEqual([['idempotency', 'close:shared-key']]);
	});

	test('loads dependencies only for dependency-add events with scoped edge metadata', async () => {
		const { createLocalBroker } = require('../../lib/kernel/broker');
		const scopes = [];
		const broker = createLocalBroker({
			projectRoot: path.join(os.tmpdir(), 'forge-worktree'),
			gitCommonDir: path.join(os.tmpdir(), 'forge-common-dir'),
			driver: {
				async loadKernelEntity() {
					return { entity_revision: 0 };
				},
				async listKernelEvents() {
					return [];
				},
				async loadKernelEventByIdempotencyKey() {
					return null;
				},
				async listKernelDependencies(scope) {
					scopes.push(scope);
					return [];
				},
				async insertKernelConflict(conflict) {
					return conflict;
				},
				async insertKernelEvent(event) {
					return { ...event, id: 'event-1' };
				},
				async enqueueKernelProjection(outboxEntry) {
					return outboxEntry;
				},
			},
		});

		await broker.runGuardedEvent({
			entity_type: 'issue',
			entity_id: 'forge-1',
			event_type: 'issue.update',
			idempotency_key: 'update:forge-1',
			expected_revision: 0,
			payload: { title: 'Renamed' },
		});
		await broker.runGuardedEvent({
			entity_type: 'dependency',
			entity_id: 'dep-1',
			event_type: 'dependency.add',
			idempotency_key: 'dep:forge-a:forge-b',
			expected_revision: 0,
			payload: {
				issue_id: 'forge-a',
				blocks_issue_id: 'forge-b',
				dependency_type: 'blocks',
			},
		});

		expect(scopes).toEqual([{
			issue_id: 'forge-a',
			blocks_issue_id: 'forge-b',
			dependency_type: 'blocks',
			entity_type: 'dependency',
			entity_id: 'dep-1',
		}]);
	});
});
