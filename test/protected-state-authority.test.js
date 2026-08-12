'use strict';

const { describe, expect, test } = require('bun:test');
const { hashProtectedContent } = require('../lib/protected-state-surfaces');
const {
	PROTECTED_STATE_AUTHORIZATION_CONSUMED,
	PROTECTED_STATE_AUTHORIZATION_ISSUED,
	authorizationEntityId,
	evaluateAuthorization,
	resolveWorktreeScope,
} = require('../lib/protected-state-authority');

const NPM_WORKFLOW_SOURCE_COMMAND = 'forge release generate-npm-workflow';
const SKILL_MIRROR_SOURCE_COMMAND = 'scripts/sync-agent-skills.js';
const PROTECTED_STATE_WRITE_COMPLETED = 'protected_state.write.completed';
const TEST_HEAD = 'a'.repeat(40);

const target = {
	actor: 'forge-release',
	surface: 'workflows',
	path: '.github/workflows/npm-publish.yml',
	content: 'generated: true\n',
	worktreeScope: 'scope-a',
	sourceHead: TEST_HEAD,
};

function eventRow(eventType, capabilityId, overrides = {}) {
	const actor = overrides.actor || target.actor;
	const filePath = overrides.path || target.path;
	const surface = overrides.surface || target.surface;
	const content = overrides.content || target.content;
	return {
		entity_type: 'protected_state',
		entity_id: overrides.entityId || authorizationEntityId(
			overrides.worktreeScope || target.worktreeScope,
			filePath,
		),
		event_type: eventType,
		actor,
		origin: overrides.origin || 'cli',
		created_at: overrides.createdAt || '2026-08-08T00:00:00.000Z',
		payload_json: JSON.stringify({
			version: 1,
			capabilityId,
			actor: overrides.payloadActor || actor,
			path: filePath,
			surface,
			contentHash: hashProtectedContent(content),
			worktreeScope: overrides.worktreeScope || target.worktreeScope,
			operation: eventType === PROTECTED_STATE_AUTHORIZATION_ISSUED
				? 'generate_npm_workflow'
				: (eventType === PROTECTED_STATE_WRITE_COMPLETED ? 'generate_npm_workflow_completed' : 'staged_edit'),
			viaForgeApi: overrides.viaForgeApi !== false,
			sourceHead: Object.prototype.hasOwnProperty.call(overrides, 'sourceHead')
				? overrides.sourceHead
				: target.sourceHead,
			sourceCommand: overrides.sourceCommand || (
				eventType === PROTECTED_STATE_AUTHORIZATION_ISSUED || eventType === PROTECTED_STATE_WRITE_COMPLETED
					? NPM_WORKFLOW_SOURCE_COMMAND
					: 'scripts/protected-state-check.js'
			),
		}),
	};
}

describe('protected-state Kernel authority', () => {
	test('canonicalizes filesystem aliases before binding a worktree scope', () => {
		const aliased = resolveWorktreeScope('/var/folders/repo', {
			realpathSync: () => '/private/var/folders/repo',
		});
		const canonical = resolveWorktreeScope('/private/var/folders/repo', {
			realpathSync: () => '/private/var/folders/repo',
		});

		expect(aliased).toBe(canonical);
	});

	test('accepts one exact unconsumed command-issued capability', () => {
		const decision = evaluateAuthorization(target, [
			eventRow(PROTECTED_STATE_AUTHORIZATION_ISSUED, 'capability-1'),
			eventRow(PROTECTED_STATE_WRITE_COMPLETED, 'capability-1'),
		]);

		expect(decision).toMatchObject({
			allowed: true,
			actor: target.actor,
			path: target.path,
			requiredSurface: target.surface,
			capabilityId: 'capability-1',
		});
	});

	test('accepts only an exact command-owned canonical skill mirror capability', () => {
		const skillTarget = {
			actor: 'forge-skill-sync',
			surface: 'generated_harness',
			path: '.agents/skills/review/SKILL.md',
			content: 'canonical review skill\n',
			worktreeScope: 'scope-skills',
			sourceHead: TEST_HEAD,
		};
		const skillEvent = (eventType, overrides = {}) => ({
			entity_type: 'protected_state',
			entity_id: authorizationEntityId(
				overrides.worktreeScope || skillTarget.worktreeScope,
				overrides.path || skillTarget.path,
			),
			event_type: eventType,
			actor: overrides.actor || skillTarget.actor,
			origin: 'cli',
			created_at: '2026-08-12T00:00:00.000Z',
			payload_json: JSON.stringify({
				version: 1,
				capabilityId: 'skill-capability',
				actor: overrides.payloadActor || overrides.actor || skillTarget.actor,
				path: overrides.path || skillTarget.path,
				surface: overrides.surface || skillTarget.surface,
				contentHash: hashProtectedContent(overrides.content || skillTarget.content),
				worktreeScope: overrides.worktreeScope || skillTarget.worktreeScope,
				operation: eventType === PROTECTED_STATE_AUTHORIZATION_ISSUED
					? 'sync_agent_skill'
					: 'sync_agent_skill_completed',
				viaForgeApi: true,
				sourceHead: overrides.sourceHead || skillTarget.sourceHead,
				sourceCommand: overrides.sourceCommand || SKILL_MIRROR_SOURCE_COMMAND,
			}),
		});
		const exactRows = [
			skillEvent(PROTECTED_STATE_AUTHORIZATION_ISSUED),
			skillEvent(PROTECTED_STATE_WRITE_COMPLETED),
		];

		expect(evaluateAuthorization(skillTarget, exactRows)).toMatchObject({
			allowed: true,
			capabilityId: 'skill-capability',
		});
		for (const request of [
			{ ...skillTarget, actor: 'foreign-actor' },
			{ ...skillTarget, path: '.agents/skills/ship/SKILL.md' },
			{ ...skillTarget, content: 'foreign bytes\n' },
			{ ...skillTarget, sourceHead: 'b'.repeat(40) },
		]) {
			expect(evaluateAuthorization(request, exactRows).allowed).toBe(false);
		}
		expect(evaluateAuthorization(skillTarget, [
			skillEvent(PROTECTED_STATE_AUTHORIZATION_ISSUED, { sourceCommand: 'raw node script' }),
			skillEvent(PROTECTED_STATE_WRITE_COMPLETED, { sourceCommand: 'raw node script' }),
		]).allowed).toBe(false);
		expect(evaluateAuthorization(skillTarget, [
			...exactRows,
			skillEvent(PROTECTED_STATE_AUTHORIZATION_CONSUMED),
		]).allowed).toBe(false);
	});

	test('denies a pre-write authorization until the owning writer records completion', () => {
		const decision = evaluateAuthorization(target, [
			eventRow(PROTECTED_STATE_AUTHORIZATION_ISSUED, 'capability-pre-write'),
		]);

		expect(decision).toMatchObject({ allowed: false, decision: 'blocked' });
		expect(decision.reason).toContain('not completed');
	});

	test('fails closed when the staged HEAD differs from or is absent on the capability', () => {
		const mismatched = evaluateAuthorization(
			{ ...target, sourceHead: 'b'.repeat(40) },
			[
				eventRow(PROTECTED_STATE_AUTHORIZATION_ISSUED, 'capability-head'),
				eventRow(PROTECTED_STATE_WRITE_COMPLETED, 'capability-head'),
			],
		);
		const missing = evaluateAuthorization(
			target,
			[
				eventRow(PROTECTED_STATE_AUTHORIZATION_ISSUED, 'capability-missing-head', { sourceHead: undefined }),
				eventRow(PROTECTED_STATE_WRITE_COMPLETED, 'capability-missing-head', { sourceHead: undefined }),
			],
		);

		expect(mismatched).toMatchObject({ allowed: false, decision: 'blocked' });
		expect(mismatched.reason).toContain('source HEAD');
		expect(missing).toMatchObject({ allowed: false, decision: 'blocked' });
		expect(missing.reason).toContain('malformed');
		expect(missing.reason).toContain('owning command');
	});

	test('fails closed on cross-actor, cross-surface, and malformed issuer records', () => {
		const crossActor = evaluateAuthorization(
			{ ...target, actor: 'other-actor' },
			[eventRow(PROTECTED_STATE_AUTHORIZATION_ISSUED, 'capability-actor')],
		);
		const crossSurface = evaluateAuthorization(
			{ ...target, surface: 'forge_config' },
			[eventRow(PROTECTED_STATE_AUTHORIZATION_ISSUED, 'capability-surface')],
		);
		const malformedIssuer = evaluateAuthorization(target, [
			eventRow(PROTECTED_STATE_AUTHORIZATION_ISSUED, 'capability-malformed', {
				sourceCommand: 'raw sqlite write',
			}),
		]);
		const nonApiIssuer = evaluateAuthorization(target, [
			eventRow(PROTECTED_STATE_AUTHORIZATION_ISSUED, 'capability-non-api', { viaForgeApi: false }),
		]);

		expect(crossActor.allowed).toBe(false);
		expect(crossSurface.allowed).toBe(false);
		expect(malformedIssuer.allowed).toBe(false);
		expect(nonApiIssuer.allowed).toBe(false);
	});

	test('denies a capability issued from a different worktree scope', () => {
		const row = eventRow(PROTECTED_STATE_AUTHORIZATION_ISSUED, 'capability-worktree');
		const payload = JSON.parse(row.payload_json);
		row.payload_json = JSON.stringify({ ...payload, worktreeScope: 'scope-a' });

		const decision = evaluateAuthorization(
			{ ...target, worktreeScope: 'scope-b' },
			[row],
		);

		expect(decision.allowed).toBe(false);
	});

	test('denies consumed replays and ambiguous concurrent issuances', () => {
		const issued = eventRow(PROTECTED_STATE_AUTHORIZATION_ISSUED, 'capability-consumed');
		const consumed = eventRow(PROTECTED_STATE_AUTHORIZATION_CONSUMED, 'capability-consumed');
		const replay = evaluateAuthorization(target, [issued, consumed]);
		const ambiguous = evaluateAuthorization(target, [
			eventRow(PROTECTED_STATE_AUTHORIZATION_ISSUED, 'capability-a'),
			eventRow(PROTECTED_STATE_AUTHORIZATION_ISSUED, 'capability-b'),
		]);

		expect(replay.allowed).toBe(false);
		expect(replay.reason).toContain('already consumed');
		expect(ambiguous.allowed).toBe(false);
		expect(ambiguous.reason).toContain('multiple unconsumed');
	});
});
