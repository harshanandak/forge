'use strict';

function stableStringify(value) {
	if (value === undefined) return '{}';
	if (value === null || typeof value !== 'object') {
		return JSON.stringify(value);
	}
	if (Array.isArray(value)) {
		return `[${value.map(stableStringify).join(',')}]`;
	}

	return `{${Object.keys(value).sort((left, right) => left.localeCompare(right))
		.map(key => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
		.join(',')}}`;
}

function normalizePayload(event) {
	if (event.payload_json) {
		try {
			return JSON.parse(event.payload_json);
		} catch {
			return event.payload_json;
		}
	}
	return event.payload || {};
}

function payloadJsonFor(event) {
	return stableStringify(normalizePayload(event));
}

function isForgeProjectionEcho(event, entity = {}) {
	if (event.origin !== 'beads_import') return false;

	const payload = normalizePayload(event);
	const projectionOrigin = payload.projection_origin;
	if (!projectionOrigin || typeof projectionOrigin !== 'object') return false;
	if (projectionOrigin.source !== 'forge-kernel' || projectionOrigin.target !== 'beads') return false;
	if (projectionOrigin.entity_type !== event.entity_type || projectionOrigin.entity_id !== event.entity_id) return false;
	if (!projectionOrigin.payload_hash || projectionOrigin.payload_hash !== projectionOrigin.imported_payload_hash) return false;
	if (!entity || entity.entity_revision === undefined || entity.entity_revision === null) return false;

	const actualRevision = Number(entity.entity_revision || 0);
	const projectedRevision = Number(projectionOrigin.entity_revision);
	return Number.isFinite(projectedRevision) && projectedRevision === actualRevision;
}

function findOriginalIdempotencyEvent(event, priorEvents = []) {
	return priorEvents.find(priorEvent => priorEvent.idempotency_key === event.idempotency_key);
}

function findEquivalentEvent(event, priorEvents = []) {
	const payloadJson = payloadJsonFor(event);
	return priorEvents.find(priorEvent => (
		priorEvent.idempotency_key !== event.idempotency_key
		&& priorEvent.expected_revision !== undefined
		&& Number(priorEvent.expected_revision) === Number(event.expected_revision || 0)
		&& priorEvent.entity_type === event.entity_type
		&& priorEvent.entity_id === event.entity_id
		&& priorEvent.event_type === event.event_type
		&& payloadJsonFor(priorEvent) === payloadJson
	));
}

function isBlockingDependency(dependency = {}) {
	return !dependency.dependency_type || dependency.dependency_type === 'blocks';
}

function dependencyCreatesCycle(payload, dependencies = []) {
	const issueId = payload.issue_id;
	const blocksIssueId = payload.blocks_issue_id;
	if (!issueId || !blocksIssueId) return false;
	if (!isBlockingDependency(payload)) return false;

	const edges = new Map();
	for (const dependency of [...dependencies, { issue_id: issueId, blocks_issue_id: blocksIssueId }].filter(isBlockingDependency)) {
		if (!edges.has(dependency.issue_id)) edges.set(dependency.issue_id, []);
		edges.get(dependency.issue_id).push(dependency.blocks_issue_id);
	}

	const seen = new Set();
	const stack = [blocksIssueId];
	while (stack.length > 0) {
		const candidate = stack.pop();
		if (candidate === issueId) return true;
		if (seen.has(candidate)) continue;
		seen.add(candidate);
		for (const next of edges.get(candidate) || []) {
			stack.push(next);
		}
	}

	return false;
}

function buildConflict(event, reason, actualRevision) {
	const payload = normalizePayload(event);
	return {
		entity_type: event.entity_type,
		entity_id: event.entity_id,
		expected_revision: Number(event.expected_revision || 0),
		actual_revision: Number(actualRevision || 0),
		status: 'quarantined',
		reason,
		payload,
		payload_json: stableStringify({
			reason,
			event: {
				entity_type: event.entity_type,
				entity_id: event.entity_id,
				event_type: event.event_type,
				idempotency_key: event.idempotency_key,
				payload,
			},
		}),
		created_at: event.created_at,
	};
}

function evaluateKernelEvent(input = {}) {
	const event = input.event || {};
	if (!event.entity_type) throw new Error('Kernel event entity_type is required');
	if (!event.entity_id) throw new Error('Kernel event entity_id is required');
	if (!event.event_type) throw new Error('Kernel event event_type is required');
	if (!event.idempotency_key) throw new Error('Kernel event idempotency_key is required');

	const priorEvents = input.priorEvents || [];
	const originalEvent = findOriginalIdempotencyEvent(event, priorEvents);
	if (originalEvent) {
		return {
			decision: 'duplicate',
			reason: 'idempotency_replay',
			originalEvent,
			projection: false,
		};
	}

	const equivalentEvent = findEquivalentEvent(event, priorEvents);
	if (equivalentEvent) {
		return {
			decision: 'dedupe',
			reason: 'equivalent_write',
			originalEvent: equivalentEvent,
			projection: false,
		};
	}

	if (isForgeProjectionEcho(event, input.entity)) {
		return {
			decision: 'projection_echo',
			reason: 'forge_projection_echo',
			projection: false,
		};
	}

	const actualRevision = Number(input.entity?.entity_revision || 0);
	const expectedRevision = Number(event.expected_revision || 0);
	if (expectedRevision !== actualRevision) {
		return {
			decision: 'quarantine',
			reason: 'stale_revision',
			conflict: buildConflict(event, 'stale_revision', actualRevision),
			projection: false,
		};
	}

	const payload = normalizePayload(event);
	if (event.event_type === 'dependency.add' && dependencyCreatesCycle(payload, input.dependencies || [])) {
		return {
			decision: 'quarantine',
			reason: 'dependency_cycle',
			conflict: buildConflict(event, 'dependency_cycle', actualRevision),
			projection: false,
		};
	}

	return {
		decision: 'accept',
		reason: 'accepted',
		event: {
			...event,
			expected_revision: Number(event.expected_revision || 0),
			payload_json: payloadJsonFor(event),
		},
		projection: true,
	};
}

module.exports = {
	dependencyCreatesCycle,
	evaluateKernelEvent,
	stableStringify,
};
