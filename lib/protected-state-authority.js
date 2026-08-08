'use strict';

// The ignored JSONL audit log is visibility-only. Workflow write authority is
// an append-only Kernel capability scoped to one worktree and consumed once.

const { randomUUID } = require('node:crypto');
const path = require('node:path');
const { resolveOwnedKernel, closeIfOwned } = require('./kernel/owned-kernel');
const { hashProtectedContent, normalizeRepoPath } = require('./protected-state-surfaces');

const PROTECTED_STATE_ENTITY_TYPE = 'protected_state';
const PROTECTED_STATE_AUTHORIZATION_ISSUED = 'protected_state.authorization.issued';
const PROTECTED_STATE_AUTHORIZATION_CONSUMED = 'protected_state.authorization.consumed';
const PROTECTED_STATE_AUTHORIZATION_VERSION = 1;
const PROTECTED_STATE_AUTHORIZATION_ORIGIN = 'cli';
const NPM_WORKFLOW_SOURCE_COMMAND = 'forge release generate-npm-workflow';

function resolveWorktreeScope(projectRoot) {
	const resolved = path.resolve(projectRoot);
	const canonical = process.platform === 'win32' ? resolved.toLowerCase() : resolved;
	return hashProtectedContent(canonical);
}

function authorizationEntityId(worktreeScope, filePath) {
	return `${worktreeScope}:${normalizeRepoPath(filePath)}`;
}

function parsePayload(row) {
	try {
		return row?.payload_json ? JSON.parse(row.payload_json) : (row?.payload || {});
	} catch {
		return {};
	}
}

function parseAuthorizationEvent(row) {
	const payload = parsePayload(row);
	return {
		eventType: row?.event_type,
		actor: row?.actor,
		payloadActor: payload.actor,
		origin: row?.origin,
		entityId: row?.entity_id,
		createdAt: row?.created_at,
		version: payload.version,
		capabilityId: payload.capabilityId,
		path: normalizeRepoPath(payload.path),
		surface: payload.surface,
		contentHash: payload.contentHash,
		operation: payload.operation,
		sourceCommand: payload.sourceCommand,
		worktreeScope: payload.worktreeScope,
	};
}

function blockedDecision(request, reason) {
	return {
		allowed: false,
		decision: 'blocked',
		actor: request.actor,
		path: normalizeRepoPath(request.path),
		operation: request.operation || 'staged_edit',
		requiredSurface: request.surface,
		declaredSurface: request.surface,
		contentHash: hashProtectedContent(request.content),
		reason,
		repairHint: 'Regenerate the protected file through its owning Forge command, then stage that exact output.',
	};
}

function evaluateAuthorization(request, rows = []) {
	const expected = {
		actor: request.actor,
		path: normalizeRepoPath(request.path),
		surface: request.surface,
		contentHash: hashProtectedContent(request.content),
		worktreeScope: request.worktreeScope,
	};
	const issued = rows
		.filter(row => row?.event_type === PROTECTED_STATE_AUTHORIZATION_ISSUED)
		.map(parseAuthorizationEvent);
	const consumedCapabilities = new Set(rows
		.filter(row => row?.event_type === PROTECTED_STATE_AUTHORIZATION_CONSUMED)
		.map(row => parseAuthorizationEvent(row).capabilityId)
		.filter(Boolean));
	const active = issued.filter(event => !consumedCapabilities.has(event.capabilityId));

	if (issued.length === 0) {
		return blockedDecision(request, 'No Forge-owned authorization exists for this protected path and content-bound write.');
	}
	if (active.length === 0) {
		return blockedDecision(request, 'The latest Forge-owned authorization was already consumed; stale and same-content replays are denied.');
	}
	if (active.length !== 1) {
		return blockedDecision(request, 'Protected-state authority is ambiguous because multiple unconsumed authorizations exist; failing closed.');
	}
	const latest = active[0];

	const structurallyValid =
		latest.version === PROTECTED_STATE_AUTHORIZATION_VERSION &&
		typeof latest.capabilityId === 'string' && latest.capabilityId.length > 0 &&
		latest.origin === PROTECTED_STATE_AUTHORIZATION_ORIGIN &&
		latest.actor === latest.payloadActor &&
		latest.worktreeScope === expected.worktreeScope &&
		latest.entityId === authorizationEntityId(expected.worktreeScope, latest.path) &&
		latest.sourceCommand === NPM_WORKFLOW_SOURCE_COMMAND;
	if (!structurallyValid) {
		return blockedDecision(request, 'The latest Forge-owned authorization is malformed or was not issued by the owning command.');
	}

	if (
		latest.actor !== expected.actor ||
		latest.path !== expected.path ||
		latest.surface !== expected.surface ||
		latest.contentHash !== expected.contentHash
	) {
		return blockedDecision(request, 'The latest Forge-owned content-bound authorization does not match this actor, surface, path, and content hash.');
	}

	return {
		allowed: true,
		decision: 'allowed',
		actor: expected.actor,
		path: expected.path,
		operation: request.operation || 'staged_edit',
		requiredSurface: expected.surface,
		declaredSurface: expected.surface,
		contentHash: expected.contentHash,
		capabilityId: latest.capabilityId,
		worktreeScope: latest.worktreeScope,
		reason: 'Staged content matches the latest unconsumed Forge-owned authorization.',
		repairHint: null,
	};
}

async function issueProtectedStateAuthorization(projectRoot, request = {}, options = {}) {
	const actor = request.actor;
	const normalizedPath = normalizeRepoPath(request.path);
	if (!actor || !request.surface || !normalizedPath || request.content === undefined) {
		throw new TypeError('Protected state authorization requires actor, surface, path, and content');
	}

	const capabilityId = options.capabilityId || randomUUID();
	const createdAt = options.now || new Date().toISOString();
	const worktreeScope = options.worktreeScope || resolveWorktreeScope(projectRoot);
	const entityId = authorizationEntityId(worktreeScope, normalizedPath);
	const event = {
		entity_type: PROTECTED_STATE_ENTITY_TYPE,
		entity_id: entityId,
		event_type: PROTECTED_STATE_AUTHORIZATION_ISSUED,
		idempotency_key: `${PROTECTED_STATE_AUTHORIZATION_ISSUED}:${capabilityId}`,
		expected_revision: 0,
		actor,
		origin: PROTECTED_STATE_AUTHORIZATION_ORIGIN,
		payload: {
			version: PROTECTED_STATE_AUTHORIZATION_VERSION,
			capabilityId,
			actor,
			path: normalizedPath,
			surface: request.surface,
			contentHash: hashProtectedContent(request.content),
			worktreeScope,
			operation: request.operation || 'generate',
			sourceCommand: request.sourceCommand || NPM_WORKFLOW_SOURCE_COMMAND,
		},
		created_at: createdAt,
	};

	const kernel = await resolveOwnedKernel(projectRoot, options.deps);
	try {
		const existingRows = await kernel.driver.listKernelEvents(
			PROTECTED_STATE_ENTITY_TYPE,
			entityId,
			{},
			kernel.config,
		);
		const consumedCapabilities = new Set((existingRows || [])
			.filter(row => row?.event_type === PROTECTED_STATE_AUTHORIZATION_CONSUMED)
			.map(row => parseAuthorizationEvent(row).capabilityId)
			.filter(Boolean));
		const activeCapabilities = (existingRows || [])
			.filter(row => row?.event_type === PROTECTED_STATE_AUTHORIZATION_ISSUED)
			.map(parseAuthorizationEvent)
			.filter(existing => existing.capabilityId && !consumedCapabilities.has(existing.capabilityId));
		for (const existing of activeCapabilities) {
			await kernel.driver.insertKernelEvent({
				entity_type: PROTECTED_STATE_ENTITY_TYPE,
				entity_id: entityId,
				event_type: PROTECTED_STATE_AUTHORIZATION_CONSUMED,
				idempotency_key: `${PROTECTED_STATE_AUTHORIZATION_CONSUMED}:${existing.capabilityId}`,
				expected_revision: 0,
				actor,
				origin: PROTECTED_STATE_AUTHORIZATION_ORIGIN,
				payload: {
					version: PROTECTED_STATE_AUTHORIZATION_VERSION,
					capabilityId: existing.capabilityId,
					actor,
					path: normalizedPath,
					surface: existing.surface,
					contentHash: existing.contentHash,
					worktreeScope,
					operation: 'superseded',
					sourceCommand: request.sourceCommand || NPM_WORKFLOW_SOURCE_COMMAND,
				},
				created_at: createdAt,
			}, {}, kernel.config);
		}
		const inserted = await kernel.driver.insertKernelEvent(event, {}, kernel.config);
		return { success: true, capabilityId, event: parseAuthorizationEvent(inserted) };
	} finally {
		closeIfOwned(kernel);
	}
}

async function authorizeAndConsumeProtectedStateWrites(projectRoot, requests = [], options = {}) {
	if (requests.length === 0) return { success: true, decisions: [] };
	const worktreeScope = options.worktreeScope || resolveWorktreeScope(projectRoot);
	const kernel = await resolveOwnedKernel(projectRoot, options.deps);
	try {
		const decisions = [];
		for (const request of requests) {
			const normalizedPath = normalizeRepoPath(request.path);
			const entityId = authorizationEntityId(worktreeScope, normalizedPath);
			const rows = await kernel.driver.listKernelEvents(
				PROTECTED_STATE_ENTITY_TYPE,
				entityId,
				{},
				kernel.config,
			);
			decisions.push(evaluateAuthorization({
				...request,
				path: normalizedPath,
				worktreeScope,
			}, rows || []));
		}

		if (decisions.some(decision => !decision.allowed)) {
			return { success: false, decisions };
		}

		for (const decision of decisions) {
			const createdAt = options.now || new Date().toISOString();
			await kernel.driver.insertKernelEvent({
				entity_type: PROTECTED_STATE_ENTITY_TYPE,
				entity_id: authorizationEntityId(decision.worktreeScope, decision.path),
				event_type: PROTECTED_STATE_AUTHORIZATION_CONSUMED,
				idempotency_key: `${PROTECTED_STATE_AUTHORIZATION_CONSUMED}:${decision.capabilityId}`,
				expected_revision: 0,
				actor: decision.actor,
				origin: PROTECTED_STATE_AUTHORIZATION_ORIGIN,
				payload: {
					version: PROTECTED_STATE_AUTHORIZATION_VERSION,
					capabilityId: decision.capabilityId,
					actor: decision.actor,
					path: decision.path,
					surface: decision.requiredSurface,
					contentHash: decision.contentHash,
					worktreeScope: decision.worktreeScope,
					operation: 'staged_edit',
					sourceCommand: 'scripts/protected-state-check.js',
				},
				created_at: createdAt,
			}, {}, kernel.config);
		}

		return { success: true, decisions };
	} finally {
		closeIfOwned(kernel);
	}
}

module.exports = {
	PROTECTED_STATE_ENTITY_TYPE,
	PROTECTED_STATE_AUTHORIZATION_ISSUED,
	PROTECTED_STATE_AUTHORIZATION_CONSUMED,
	NPM_WORKFLOW_SOURCE_COMMAND,
	resolveWorktreeScope,
	authorizationEntityId,
	parseAuthorizationEvent,
	evaluateAuthorization,
	issueProtectedStateAuthorization,
	authorizeAndConsumeProtectedStateWrites,
};
