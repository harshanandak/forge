'use strict';

// The ignored JSONL audit log is visibility-only. Workflow write authority is
// an append-only Kernel capability scoped to one worktree and consumed once.

const { randomUUID } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { resolveOwnedKernel, closeIfOwned } = require('./kernel/owned-kernel');
const { hashProtectedContent, normalizeRepoPath } = require('./protected-state-surfaces');

const PROTECTED_STATE_ENTITY_TYPE = 'protected_state';
const PROTECTED_STATE_AUTHORIZATION_ISSUED = 'protected_state.authorization.issued';
const PROTECTED_STATE_WRITE_COMPLETED = 'protected_state.write.completed';
const PROTECTED_STATE_AUTHORIZATION_CONSUMED = 'protected_state.authorization.consumed';
const PROTECTED_STATE_AUTHORIZATION_VERSION = 1;
const PROTECTED_STATE_AUTHORIZATION_ORIGIN = 'cli';
const NPM_WORKFLOW_SOURCE_COMMAND = 'forge release generate-npm-workflow';
const SKILL_MIRROR_SOURCE_COMMAND = 'scripts/sync-agent-skills.js';
const CLAUDE_SETUP_SOURCE_COMMAND = 'forge setup';

function owningWriter(pathname, surface) {
	if (surface === 'workflows' && pathname === '.github/workflows/npm-publish.yml') {
		return {
			sourceCommand: NPM_WORKFLOW_SOURCE_COMMAND,
			issueOperation: 'generate_npm_workflow',
			completionOperation: 'generate_npm_workflow_completed',
		};
	}
	if (surface === 'generated_harness' && /^\.agents\/skills\/[^/]+\/.+/.test(pathname)) {
		return {
			sourceCommand: SKILL_MIRROR_SOURCE_COMMAND,
			issueOperation: 'sync_agent_skill',
			completionOperation: 'sync_agent_skill_completed',
		};
	}
	if (surface === 'generated_harness' && pathname === 'CLAUDE.md') {
		return {
			sourceCommand: CLAUDE_SETUP_SOURCE_COMMAND,
			issueOperation: 'generate_claude_import',
			completionOperation: 'generate_claude_import_completed',
		};
	}
	return null;
}

function resolveWorktreeScope(projectRoot, deps = {}) {
	const resolved = path.resolve(projectRoot);
	const realpath = deps.realpathSync || fs.realpathSync.native;
	let canonical;
	try {
		canonical = realpath(resolved);
	} catch {
		canonical = resolved;
	}
	if (process.platform === 'win32') canonical = canonical.toLowerCase();
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
		viaForgeApi: payload.viaForgeApi === true,
		sourceCommand: payload.sourceCommand,
		sourceHead: payload.sourceHead,
		worktreeScope: payload.worktreeScope,
		writeIntent: payload.writeIntent,
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
		sourceHead: request.sourceHead,
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
		sourceHead: request.sourceHead,
		writeIntent: request.operation === 'staged_delete' ? 'delete' : 'update',
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
	const writer = owningWriter(latest.path, latest.surface);

	const structurallyValid =
		writer !== null &&
		latest.version === PROTECTED_STATE_AUTHORIZATION_VERSION &&
		typeof latest.capabilityId === 'string' && latest.capabilityId.length > 0 &&
		latest.origin === PROTECTED_STATE_AUTHORIZATION_ORIGIN &&
		latest.actor === latest.payloadActor &&
		latest.worktreeScope === expected.worktreeScope &&
		latest.entityId === authorizationEntityId(expected.worktreeScope, latest.path) &&
		latest.viaForgeApi === true &&
		latest.sourceCommand === writer?.sourceCommand &&
		latest.operation === writer?.issueOperation &&
		latest.writeIntent === expected.writeIntent &&
		/^[0-9a-f]{40}$/.test(latest.sourceHead || '');
	if (!structurallyValid) {
		return blockedDecision(request, 'The latest Forge-owned authorization is malformed or was not issued by the owning command.');
	}

	if (
		latest.actor !== expected.actor ||
		latest.path !== expected.path ||
		latest.surface !== expected.surface ||
		latest.contentHash !== expected.contentHash ||
		latest.sourceHead !== expected.sourceHead ||
		latest.writeIntent !== expected.writeIntent
	) {
		return blockedDecision(request, 'The latest Forge-owned authorization does not match this actor, surface, path, content hash, and source HEAD.');
	}

	const matchingCompletions = rows
		.filter(row => row?.event_type === PROTECTED_STATE_WRITE_COMPLETED)
		.map(parseAuthorizationEvent)
		.filter(event =>
			event.version === PROTECTED_STATE_AUTHORIZATION_VERSION &&
			event.capabilityId === latest.capabilityId &&
			event.origin === PROTECTED_STATE_AUTHORIZATION_ORIGIN &&
			event.actor === latest.actor &&
			event.payloadActor === latest.payloadActor &&
			event.entityId === latest.entityId &&
			event.path === latest.path &&
			event.surface === latest.surface &&
			event.contentHash === latest.contentHash &&
			event.sourceHead === latest.sourceHead &&
			event.worktreeScope === latest.worktreeScope &&
			event.writeIntent === latest.writeIntent &&
			event.operation === writer.completionOperation &&
			event.viaForgeApi === true &&
			event.sourceCommand === writer.sourceCommand
		);
	if (matchingCompletions.length !== 1) {
		return blockedDecision(request, 'The latest Forge-owned authorization is not completed by its owning writer; failing closed.');
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
		sourceHead: expected.sourceHead,
		viaForgeApi: true,
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
	const worktreeScope = options.worktreeScope || resolveWorktreeScope(projectRoot, options.deps);
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
			viaForgeApi: request.viaForgeApi === true,
			sourceCommand: request.sourceCommand || NPM_WORKFLOW_SOURCE_COMMAND,
			...(request.sourceHead ? { sourceHead: request.sourceHead } : {}),
			writeIntent: request.writeIntent || 'update',
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
					sourceHead: existing.sourceHead,
					worktreeScope,
					operation: 'superseded',
					viaForgeApi: existing.viaForgeApi === true,
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

async function issueNpmPublishWorkflowAuthorization(projectRoot, params = {}, options = {}) {
	if (!/^[0-9a-f]{40}$/.test(params.sourceHead || '')) {
		return {
			success: false,
			error: 'Protected npm workflow authorization requires a full 40-character lowercase source HEAD.',
		};
	}
	const {
		NPM_PUBLISH_WORKFLOW_PATH,
		renderNpmPublishWorkflow,
	} = require('./npm-publish-workflow');
	return issueProtectedStateAuthorization(projectRoot, {
		actor: params.actor,
		surface: 'workflows',
		path: NPM_PUBLISH_WORKFLOW_PATH,
		content: renderNpmPublishWorkflow(),
		operation: 'generate_npm_workflow',
		viaForgeApi: true,
		sourceCommand: NPM_WORKFLOW_SOURCE_COMMAND,
		sourceHead: params.sourceHead,
	}, options);
}

async function completeNpmPublishWorkflowAuthorization(projectRoot, params = {}, options = {}) {
	if (!/^[0-9a-f]{40}$/.test(params.sourceHead || '')) {
		return {
			success: false,
			error: 'Protected npm workflow completion requires a full 40-character lowercase source HEAD.',
		};
	}
	if (typeof params.capabilityId !== 'string' || params.capabilityId.length === 0) {
		return { success: false, error: 'Protected npm workflow completion requires a capability id.' };
	}

	const {
		NPM_PUBLISH_WORKFLOW_PATH,
		renderNpmPublishWorkflow,
	} = require('./npm-publish-workflow');
	const actor = params.actor;
	const normalizedPath = normalizeRepoPath(NPM_PUBLISH_WORKFLOW_PATH);
	const contentHash = hashProtectedContent(renderNpmPublishWorkflow());
	const worktreeScope = options.worktreeScope || resolveWorktreeScope(projectRoot, options.deps);
	const entityId = authorizationEntityId(worktreeScope, normalizedPath);
	const createdAt = options.now || new Date().toISOString();
	const kernel = await resolveOwnedKernel(projectRoot, options.deps);
	try {
		const rows = await kernel.driver.listKernelEvents(
			PROTECTED_STATE_ENTITY_TYPE,
			entityId,
			{},
			kernel.config,
		);
		const issued = (rows || [])
			.filter(row => row?.event_type === PROTECTED_STATE_AUTHORIZATION_ISSUED)
			.map(parseAuthorizationEvent)
			.find(event => event.capabilityId === params.capabilityId);
		const consumed = (rows || [])
			.filter(row => row?.event_type === PROTECTED_STATE_AUTHORIZATION_CONSUMED)
			.map(parseAuthorizationEvent)
			.some(event => event.capabilityId === params.capabilityId);
		const exactIssued = issued?.version === PROTECTED_STATE_AUTHORIZATION_VERSION &&
			issued.origin === PROTECTED_STATE_AUTHORIZATION_ORIGIN &&
			issued.actor === actor &&
			issued.payloadActor === actor &&
			issued.entityId === entityId &&
			issued.path === normalizedPath &&
			issued.surface === 'workflows' &&
			issued.contentHash === contentHash &&
			issued.sourceHead === params.sourceHead &&
			issued.worktreeScope === worktreeScope &&
			issued.viaForgeApi === true &&
			issued.sourceCommand === NPM_WORKFLOW_SOURCE_COMMAND;
		if (!exactIssued || consumed) {
			return {
				success: false,
				error: 'Protected npm workflow completion does not match one active exact authorization.',
			};
		}

		const event = {
			entity_type: PROTECTED_STATE_ENTITY_TYPE,
			entity_id: entityId,
			event_type: PROTECTED_STATE_WRITE_COMPLETED,
			idempotency_key: `${PROTECTED_STATE_WRITE_COMPLETED}:${params.capabilityId}`,
			expected_revision: 0,
			actor,
			origin: PROTECTED_STATE_AUTHORIZATION_ORIGIN,
			payload: {
				version: PROTECTED_STATE_AUTHORIZATION_VERSION,
				capabilityId: params.capabilityId,
				actor,
				path: normalizedPath,
				surface: 'workflows',
				contentHash,
				sourceHead: params.sourceHead,
				worktreeScope,
				writeIntent: 'update',
				operation: 'generate_npm_workflow_completed',
				viaForgeApi: true,
				sourceCommand: NPM_WORKFLOW_SOURCE_COMMAND,
			},
			created_at: createdAt,
		};
		const inserted = await kernel.driver.insertKernelEvent(event, {}, kernel.config);
		return { success: true, capabilityId: params.capabilityId, event: parseAuthorizationEvent(inserted) };
	} finally {
		closeIfOwned(kernel);
	}
}

const CLAUDE_POINTER_CONTENT = Buffer.from('@AGENTS.md\n');

function isExactClaudePointer(content) {
	return Buffer.from(content || '').equals(CLAUDE_POINTER_CONTENT);
}

async function issueGeneratedHarnessClaudeAuthorization(projectRoot, params = {}, options = {}) {
	if (!/^[0-9a-f]{40}$/.test(params.sourceHead || '') || !isExactClaudePointer(params.content)) {
		return {
			success: false,
			error: 'Root CLAUDE.md authorization requires exact @AGENTS.md pointer bytes and a full source HEAD.',
		};
	}
	return issueProtectedStateAuthorization(projectRoot, {
		actor: params.actor,
		surface: 'generated_harness',
		path: 'CLAUDE.md',
		content: CLAUDE_POINTER_CONTENT,
		operation: 'generate_claude_import',
		viaForgeApi: true,
		sourceCommand: CLAUDE_SETUP_SOURCE_COMMAND,
		sourceHead: params.sourceHead,
	}, options);
}

async function completeGeneratedHarnessClaudeAuthorization(projectRoot, params = {}, options = {}) {
	if (!/^[0-9a-f]{40}$/.test(params.sourceHead || '') || !params.capabilityId) {
		return { success: false, error: 'Root CLAUDE.md completion requires a capability id and full source HEAD.' };
	}
	const actor = params.actor;
	const normalizedPath = 'CLAUDE.md';
	const contentHash = hashProtectedContent(CLAUDE_POINTER_CONTENT);
	const worktreeScope = options.worktreeScope || resolveWorktreeScope(projectRoot, options.deps);
	const entityId = authorizationEntityId(worktreeScope, normalizedPath);
	const kernel = await resolveOwnedKernel(projectRoot, options.deps);
	try {
		const rows = await kernel.driver.listKernelEvents(PROTECTED_STATE_ENTITY_TYPE, entityId, {}, kernel.config);
		const issued = (rows || [])
			.filter(row => row?.event_type === PROTECTED_STATE_AUTHORIZATION_ISSUED)
			.map(parseAuthorizationEvent)
			.find(event => event.capabilityId === params.capabilityId);
		const consumed = (rows || [])
			.filter(row => row?.event_type === PROTECTED_STATE_AUTHORIZATION_CONSUMED)
			.map(parseAuthorizationEvent)
			.some(event => event.capabilityId === params.capabilityId);
		const exactIssued = issued?.version === PROTECTED_STATE_AUTHORIZATION_VERSION &&
			issued.origin === PROTECTED_STATE_AUTHORIZATION_ORIGIN &&
			issued.actor === actor && issued.payloadActor === actor &&
			issued.entityId === entityId && issued.path === normalizedPath &&
			issued.surface === 'generated_harness' && issued.contentHash === contentHash &&
			issued.sourceHead === params.sourceHead && issued.worktreeScope === worktreeScope &&
			issued.operation === 'generate_claude_import' && issued.viaForgeApi === true &&
			issued.sourceCommand === CLAUDE_SETUP_SOURCE_COMMAND;
		if (!exactIssued || consumed) {
			return { success: false, error: 'Root CLAUDE.md completion does not match one active exact authorization.' };
		}
		const inserted = await kernel.driver.insertKernelEvent({
			entity_type: PROTECTED_STATE_ENTITY_TYPE,
			entity_id: entityId,
			event_type: PROTECTED_STATE_WRITE_COMPLETED,
			idempotency_key: `${PROTECTED_STATE_WRITE_COMPLETED}:${params.capabilityId}`,
			expected_revision: 0,
			actor,
			origin: PROTECTED_STATE_AUTHORIZATION_ORIGIN,
			payload: {
				version: PROTECTED_STATE_AUTHORIZATION_VERSION,
				capabilityId: params.capabilityId,
				actor,
				path: normalizedPath,
				surface: 'generated_harness',
				contentHash,
				sourceHead: params.sourceHead,
				worktreeScope,
				writeIntent: 'update',
				operation: 'generate_claude_import_completed',
				viaForgeApi: true,
				sourceCommand: CLAUDE_SETUP_SOURCE_COMMAND,
			},
			created_at: options.now || new Date().toISOString(),
		}, {}, kernel.config);
		return { success: true, capabilityId: params.capabilityId, event: parseAuthorizationEvent(inserted) };
	} finally {
		closeIfOwned(kernel);
	}
}

function resolveCanonicalSkillMirror(projectRoot, mirrorPath, options = {}) {
	const normalizedPath = normalizeRepoPath(mirrorPath);
	const match = /^\.agents\/skills\/([^/]+)\/(.+)$/.exec(normalizedPath);
	if (!match || match[1] === '.' || match[1] === '..') return null;
	const segments = match[2].split('/');
	if (segments.some(segment => !segment || segment === '.' || segment === '..')) return null;
	const skillRoot = path.resolve(projectRoot, 'skills', match[1]);
	const canonicalPath = path.resolve(skillRoot, match[2]);
	if (canonicalPath !== skillRoot && !canonicalPath.startsWith(`${skillRoot}${path.sep}`)) return null;
	try {
		const skillsRoot = path.resolve(projectRoot, 'skills');
		const skillsStat = fs.lstatSync(skillsRoot);
		if (!skillsStat.isDirectory() || skillsStat.isSymbolicLink()) return null;
		const rootStat = fs.lstatSync(skillRoot);
		if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) return null;
		let ancestor = skillRoot;
		for (const segment of segments.slice(0, -1)) {
			ancestor = path.join(ancestor, segment);
			const ancestorStat = fs.lstatSync(ancestor);
			if (!ancestorStat.isDirectory() || ancestorStat.isSymbolicLink()) return null;
		}
		const stat = fs.lstatSync(canonicalPath);
		if (!stat.isFile() || stat.isSymbolicLink()) return null;
		return { normalizedPath, content: fs.readFileSync(canonicalPath) };
	} catch (error) {
		if (options.allowMissing === true && error.code === 'ENOENT' && Buffer.isBuffer(options.priorContent)) {
			return { normalizedPath, content: options.priorContent, missing: true };
		}
		return null;
	}
}

async function issueGeneratedHarnessSkillAuthorization(projectRoot, params = {}, options = {}) {
	if (!/^[0-9a-f]{40}$/.test(params.sourceHead || '')) {
		return { success: false, error: 'Protected skill mirror authorization requires a full 40-character lowercase source HEAD.' };
	}
	const writeIntent = params.writeIntent === 'delete' ? 'delete' : 'update';
	const canonical = resolveCanonicalSkillMirror(projectRoot, params.path, {
		allowMissing: writeIntent === 'delete',
		priorContent: params.priorContent,
	});
	if (!canonical) {
		return { success: false, error: 'Protected skill mirror authorization requires a canonical .agents/skills/<name>/<file> path.' };
	}
	if (writeIntent === 'delete' && canonical.missing !== true) {
		return { success: false, error: 'Protected skill mirror deletion authorization requires the canonical source to be absent.' };
	}
	return issueProtectedStateAuthorization(projectRoot, {
		actor: params.actor,
		surface: 'generated_harness',
		path: canonical.normalizedPath,
		content: canonical.content,
		operation: 'sync_agent_skill',
		viaForgeApi: true,
		sourceCommand: SKILL_MIRROR_SOURCE_COMMAND,
		sourceHead: params.sourceHead,
		writeIntent,
	}, options);
}

async function completeGeneratedHarnessSkillAuthorization(projectRoot, params = {}, options = {}) {
	if (!/^[0-9a-f]{40}$/.test(params.sourceHead || '') || !params.capabilityId) {
		return { success: false, error: 'Protected skill mirror completion requires a capability id and full source HEAD.' };
	}
	const writeIntent = params.writeIntent === 'delete' ? 'delete' : 'update';
	const canonical = resolveCanonicalSkillMirror(projectRoot, params.path, {
		allowMissing: writeIntent === 'delete',
		priorContent: params.priorContent,
	});
	if (!canonical) {
		return { success: false, error: 'Protected skill mirror completion requires a canonical .agents/skills/<name>/<file> path.' };
	}
	if (writeIntent === 'delete' && canonical.missing !== true) {
		return { success: false, error: 'Protected skill mirror deletion completion requires the canonical source to be absent.' };
	}
	const actor = params.actor;
	const contentHash = hashProtectedContent(canonical.content);
	const mirrorTarget = path.resolve(projectRoot, canonical.normalizedPath);
	if (writeIntent === 'delete' && fs.existsSync(mirrorTarget)) {
		return { success: false, error: 'Protected skill mirror deletion completion requires the exact mirror path to be absent.' };
	}
	const worktreeScope = options.worktreeScope || resolveWorktreeScope(projectRoot, options.deps);
	const entityId = authorizationEntityId(worktreeScope, canonical.normalizedPath);
	const kernel = await resolveOwnedKernel(projectRoot, options.deps);
	try {
		const rows = await kernel.driver.listKernelEvents(PROTECTED_STATE_ENTITY_TYPE, entityId, {}, kernel.config);
		const issued = (rows || [])
			.filter(row => row?.event_type === PROTECTED_STATE_AUTHORIZATION_ISSUED)
			.map(parseAuthorizationEvent)
			.find(event => event.capabilityId === params.capabilityId);
		const consumed = (rows || [])
			.filter(row => row?.event_type === PROTECTED_STATE_AUTHORIZATION_CONSUMED)
			.map(parseAuthorizationEvent)
			.some(event => event.capabilityId === params.capabilityId);
		const exactIssued = issued?.version === PROTECTED_STATE_AUTHORIZATION_VERSION &&
			issued.origin === PROTECTED_STATE_AUTHORIZATION_ORIGIN &&
			issued.actor === actor && issued.payloadActor === actor &&
			issued.entityId === entityId && issued.path === canonical.normalizedPath &&
			issued.surface === 'generated_harness' && issued.contentHash === contentHash &&
			issued.sourceHead === params.sourceHead && issued.worktreeScope === worktreeScope &&
			issued.operation === 'sync_agent_skill' && issued.viaForgeApi === true &&
			issued.writeIntent === writeIntent &&
			issued.sourceCommand === SKILL_MIRROR_SOURCE_COMMAND;
		if (!exactIssued || consumed) {
			return { success: false, error: 'Protected skill mirror completion does not match one active exact authorization.' };
		}
		const inserted = await kernel.driver.insertKernelEvent({
			entity_type: PROTECTED_STATE_ENTITY_TYPE,
			entity_id: entityId,
			event_type: PROTECTED_STATE_WRITE_COMPLETED,
			idempotency_key: `${PROTECTED_STATE_WRITE_COMPLETED}:${params.capabilityId}`,
			expected_revision: 0,
			actor,
			origin: PROTECTED_STATE_AUTHORIZATION_ORIGIN,
			payload: {
				version: PROTECTED_STATE_AUTHORIZATION_VERSION,
				capabilityId: params.capabilityId,
				actor,
				path: canonical.normalizedPath,
				surface: 'generated_harness',
				contentHash,
				sourceHead: params.sourceHead,
				worktreeScope,
				writeIntent,
				operation: 'sync_agent_skill_completed',
				viaForgeApi: true,
				sourceCommand: SKILL_MIRROR_SOURCE_COMMAND,
			},
			created_at: options.now || new Date().toISOString(),
		}, {}, kernel.config);
		return { success: true, capabilityId: params.capabilityId, event: parseAuthorizationEvent(inserted) };
	} finally {
		closeIfOwned(kernel);
	}
}

async function authorizeAndConsumeProtectedStateWrites(projectRoot, requests = [], options = {}) {
	if (requests.length === 0) return { success: true, decisions: [] };
	const worktreeScope = options.worktreeScope || resolveWorktreeScope(projectRoot, options.deps);
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
					sourceHead: decision.sourceHead,
					worktreeScope: decision.worktreeScope,
					writeIntent: decision.operation === 'staged_delete' ? 'delete' : 'update',
					operation: 'staged_edit',
					viaForgeApi: decision.viaForgeApi === true,
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
	PROTECTED_STATE_WRITE_COMPLETED,
	PROTECTED_STATE_AUTHORIZATION_CONSUMED,
	resolveWorktreeScope,
	authorizationEntityId,
	parseAuthorizationEvent,
	evaluateAuthorization,
	issueNpmPublishWorkflowAuthorization,
	completeNpmPublishWorkflowAuthorization,
	issueGeneratedHarnessClaudeAuthorization,
	completeGeneratedHarnessClaudeAuthorization,
	issueGeneratedHarnessSkillAuthorization,
	completeGeneratedHarnessSkillAuthorization,
	authorizeAndConsumeProtectedStateWrites,
};
