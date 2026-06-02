const { describe, expect, test } = require('bun:test');

describe('Kernel conflict evaluators', () => {
	test('quarantines stale revision writes before projection', () => {
		const { evaluateKernelEvent } = require('../../lib/kernel/evaluators');

		const result = evaluateKernelEvent({
			event: {
				entity_type: 'issue',
				entity_id: 'forge-1',
				event_type: 'issue.update',
				idempotency_key: 'issue-update:forge-1:rev-2',
				expected_revision: 2,
				payload: { title: 'Renamed' },
			},
			entity: { entity_revision: 3 },
		});

		expect(result.decision).toBe('quarantine');
		expect(result.reason).toBe('stale_revision');
		expect(result.conflict).toMatchObject({
			entity_type: 'issue',
			entity_id: 'forge-1',
			expected_revision: 2,
			actual_revision: 3,
			status: 'quarantined',
		});
		expect(result.projection).toBe(false);
	});

	test('returns the original accepted event for duplicate idempotency keys', () => {
		const { evaluateKernelEvent } = require('../../lib/kernel/evaluators');
		const originalEvent = {
			id: 'evt-1',
			entity_type: 'issue',
			entity_id: 'forge-1',
			event_type: 'issue.close',
			idempotency_key: 'close:forge-1',
			payload_json: '{"status":"closed"}',
		};

		const result = evaluateKernelEvent({
			event: {
				entity_type: 'issue',
				entity_id: 'forge-1',
				event_type: 'issue.close',
				idempotency_key: 'close:forge-1',
				expected_revision: 4,
				payload: { status: 'closed' },
			},
			entity: { entity_revision: 4 },
			priorEvents: [originalEvent],
		});

		expect(result.decision).toBe('duplicate');
		expect(result.originalEvent).toBe(originalEvent);
		expect(result.projection).toBe(false);
	});

	test('dedupes equivalent writes with different idempotency keys', () => {
		const { evaluateKernelEvent } = require('../../lib/kernel/evaluators');
		const originalEvent = {
			id: 'evt-1',
			entity_type: 'issue',
			entity_id: 'forge-1',
			event_type: 'issue.priority',
			idempotency_key: 'priority:forge-1:first',
			payload_json: '{"priority":"P1"}',
		};

		const result = evaluateKernelEvent({
			event: {
				entity_type: 'issue',
				entity_id: 'forge-1',
				event_type: 'issue.priority',
				idempotency_key: 'priority:forge-1:retry',
				expected_revision: 4,
				payload: { priority: 'P1' },
			},
			entity: { entity_revision: 4 },
			priorEvents: [originalEvent],
		});

		expect(result.decision).toBe('dedupe');
		expect(result.originalEvent).toBe(originalEvent);
		expect(result.projection).toBe(false);
	});

	test('quarantines dependency writes that would create a cycle', () => {
		const { evaluateKernelEvent } = require('../../lib/kernel/evaluators');

		const result = evaluateKernelEvent({
			event: {
				entity_type: 'dependency',
				entity_id: 'dep-3',
				event_type: 'dependency.add',
				idempotency_key: 'dep:forge-a:forge-c',
				expected_revision: 0,
				payload: {
					issue_id: 'forge-a',
					blocks_issue_id: 'forge-c',
				},
			},
			entity: { entity_revision: 0 },
			dependencies: [
				{ issue_id: 'forge-b', blocks_issue_id: 'forge-a' },
				{ issue_id: 'forge-c', blocks_issue_id: 'forge-b' },
			],
		});

		expect(result.decision).toBe('quarantine');
		expect(result.reason).toBe('dependency_cycle');
		expect(result.conflict.payload).toMatchObject({
			issue_id: 'forge-a',
			blocks_issue_id: 'forge-c',
		});
		expect(result.projection).toBe(false);
	});
});
