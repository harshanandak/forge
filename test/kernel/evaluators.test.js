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
			expected_revision: 4,
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

	test('does not dedupe intentional returns to an earlier payload at a later revision', () => {
		const { evaluateKernelEvent } = require('../../lib/kernel/evaluators');
		const originalTitleEvent = {
			id: 'evt-title-a',
			entity_type: 'issue',
			entity_id: 'forge-1',
			event_type: 'issue.update',
			idempotency_key: 'title:forge-1:a',
			expected_revision: 1,
			payload_json: '{"title":"A"}',
		};

		const result = evaluateKernelEvent({
			event: {
				entity_type: 'issue',
				entity_id: 'forge-1',
				event_type: 'issue.update',
				idempotency_key: 'title:forge-1:back-to-a',
				expected_revision: 3,
				payload: { title: 'A' },
			},
			entity: { entity_revision: 3 },
			priorEvents: [originalTitleEvent],
		});

		expect(result.decision).toBe('accept');
		expect(result.projection).toBe(true);
	});

	test('suppresses Beads imports that echo a Forge projection', () => {
		const { evaluateKernelEvent } = require('../../lib/kernel/evaluators');

		const result = evaluateKernelEvent({
			event: {
				entity_type: 'issue',
				entity_id: 'forge-1',
				event_type: 'issue.update',
				idempotency_key: 'beads-import:forge-1:projected-rev-4',
				expected_revision: 4,
				origin: 'beads_import',
				payload: {
					title: 'Projected title',
					projection_origin: {
						source: 'forge-kernel',
						target: 'beads',
						entity_type: 'issue',
						entity_id: 'forge-1',
						entity_revision: 4,
					},
				},
			},
			entity: { entity_revision: 4 },
		});

		expect(result).toMatchObject({
			decision: 'projection_echo',
			reason: 'forge_projection_echo',
			projection: false,
		});
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

	test('ignores non-blocking dependency edges when checking cycles', () => {
		const { evaluateKernelEvent } = require('../../lib/kernel/evaluators');

		const result = evaluateKernelEvent({
			event: {
				entity_type: 'dependency',
				entity_id: 'dep-related',
				event_type: 'dependency.add',
				idempotency_key: 'dep:related',
				expected_revision: 0,
				payload: {
					issue_id: 'forge-a',
					blocks_issue_id: 'forge-c',
					dependency_type: 'related',
				},
			},
			entity: { entity_revision: 0 },
			dependencies: [
				{ issue_id: 'forge-b', blocks_issue_id: 'forge-a', dependency_type: 'blocks' },
				{ issue_id: 'forge-c', blocks_issue_id: 'forge-b', dependency_type: 'blocks' },
			],
		});

		expect(result.decision).toBe('accept');
		expect(result.projection).toBe(true);
	});

	test('ignores existing non-blocking edges when checking cycles', () => {
		const { evaluateKernelEvent } = require('../../lib/kernel/evaluators');

		const result = evaluateKernelEvent({
			event: {
				entity_type: 'dependency',
				entity_id: 'dep-blocks',
				event_type: 'dependency.add',
				idempotency_key: 'dep:blocks',
				expected_revision: 0,
				payload: {
					issue_id: 'forge-a',
					blocks_issue_id: 'forge-c',
					dependency_type: 'blocks',
				},
			},
			entity: { entity_revision: 0 },
			dependencies: [
				{ issue_id: 'forge-b', blocks_issue_id: 'forge-a', dependency_type: 'related' },
				{ issue_id: 'forge-c', blocks_issue_id: 'forge-b', dependency_type: 'blocks' },
			],
		});

		expect(result.decision).toBe('accept');
		expect(result.projection).toBe(true);
	});
});
