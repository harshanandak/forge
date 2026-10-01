'use strict';

const { describe, expect, test } = require('bun:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { hashProtectedContent } = require('../lib/protected-state-surfaces');
const {
	PROTECTED_STATE_AUTHORIZATION_ISSUED,
	PROTECTED_STATE_WRITE_COMPLETED,
	authorizationEntityId,
	authorizeAndConsumeProtectedStateWrites,
	evaluateAuthorization,
	issueClaudePointerRemovalAuthorization,
} = require('../lib/protected-state-authority');
const {
	MIN_NATIVE_AGENTS_MD_CLAUDE_VERSION,
	parseClaudeCodeVersion,
	removeClaudePointer,
} = require('../lib/claude-pointer-removal');
const setupCommand = require('../lib/commands/setup');

const SUPPORTED = () => '2.1.285 (Claude Code)';

function git(root, args) {
	return spawnSync('git', args, { cwd: root, encoding: 'utf8' });
}

function createFixture(files) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-claude-pointer-'));
	expect(git(root, ['init']).status).toBe(0);
	expect(git(root, ['config', 'user.email', 'forge-test@example.invalid']).status).toBe(0);
	expect(git(root, ['config', 'user.name', 'Forge Test']).status).toBe(0);
	expect(git(root, ['config', 'core.autocrlf', 'false']).status).toBe(0);
	for (const [filePath, content] of Object.entries(files)) {
		fs.writeFileSync(path.join(root, filePath), content);
	}
	expect(git(root, ['add', '.']).status).toBe(0);
	expect(git(root, ['commit', '-m', 'base']).status).toBe(0);
	const head = git(root, ['rev-parse', 'HEAD']).stdout.trim();
	const rows = [];
	const kernelDeps = {
		kernelBroker: { config: {} },
		kernelDriver: {
			listKernelEvents: async (_type, entityId) => rows.filter(row => row.entity_id === entityId),
			insertKernelEvent: async event => {
				rows.push(event);
				return event;
			},
		},
	};
	return { root, head, rows, kernelDeps };
}

async function withFixture(files, run) {
	const fixture = createFixture(files);
	try {
		await run(fixture);
	} finally {
		fs.rmSync(fixture.root, { recursive: true, force: true });
	}
}

function options(fixture, overrides = {}) {
	return {
		env: {},
		actor: 'pointer-test',
		kernelDeps: fixture.kernelDeps,
		readClaudeVersion: SUPPORTED,
		...overrides,
	};
}

function hook(fixture, requests) {
	return authorizeAndConsumeProtectedStateWrites(fixture.root, requests, {
		deps: fixture.kernelDeps,
		validateCompleteBunPinBatch: () => ({ success: true }),
	});
}

function claudeRequest(fixture, content, operation) {
	return {
		actor: 'pointer-test',
		surface: 'generated_harness',
		path: 'CLAUDE.md',
		content: Buffer.from(content),
		operation,
		sourceHead: fixture.head,
	};
}

const AGENTS = '# Agents\n';

describe('Claude Code version detection', () => {
	test('parses the semver from claude --version output', () => {
		expect(parseClaudeCodeVersion('2.1.285 (Claude Code)\n')).toBe('2.1.285');
		expect(parseClaudeCodeVersion('no version here')).toBeNull();
		expect(MIN_NATIVE_AGENTS_MD_CLAUDE_VERSION).toBe('2.1.277');
	});
});

describe('forge setup --remove-claude-pointer', () => {
	for (const pointer of ['@AGENTS.md\n', '@AGENTS.md\r\n', '@AGENTS.md']) {
		test(`removes a pointer-only CLAUDE.md (${JSON.stringify(pointer)}) and the hook authorizes the staged deletion`, () => withFixture({ 'AGENTS.md': AGENTS, 'CLAUDE.md': pointer }, async fixture => {
			const result = await removeClaudePointer(fixture.root, options(fixture));
			expect(result).toMatchObject({ success: true, removed: true, sourceHead: fixture.head });
			expect(fs.existsSync(path.join(fixture.root, 'CLAUDE.md'))).toBe(false);
			const issued = fixture.rows.find(row => row.event_type === PROTECTED_STATE_AUTHORIZATION_ISSUED);
			expect(issued.payload).toMatchObject({
				writeIntent: 'delete',
				operation: 'remove_claude_import',
				sourceCommand: 'forge setup --remove-claude-pointer',
				surface: 'generated_harness',
				path: 'CLAUDE.md',
			});

			const decision = await hook(fixture, [claudeRequest(fixture, pointer, 'staged_delete')]);
			expect(decision).toMatchObject({ success: true, decisions: [{ allowed: true }] });
		}), 60_000);
	}

	test('refuses to delete a CLAUDE.md with any other content and the hook keeps blocking it', () => withFixture({ 'AGENTS.md': AGENTS, 'CLAUDE.md': '@AGENTS.md\n\nCustom project rules\n' }, async fixture => {
		const result = await removeClaudePointer(fixture.root, options(fixture));
		expect(result.success).toBe(false);
		expect(result.error).toContain('@AGENTS.md');
		expect(fs.existsSync(path.join(fixture.root, 'CLAUDE.md'))).toBe(true);
		expect(fixture.rows).toHaveLength(0);

		const decision = await hook(fixture, [claudeRequest(fixture, '@AGENTS.md\n\nCustom project rules\n', 'staged_delete')]);
		expect(decision.success).toBe(false);
		expect(decision.decisions[0].allowed).toBe(false);
	}), 60_000);

	test('refuses when the worktree CLAUDE.md differs from the pointer at HEAD', () => withFixture({ 'AGENTS.md': AGENTS, 'CLAUDE.md': '@AGENTS.md\n' }, async fixture => {
		fs.writeFileSync(path.join(fixture.root, 'CLAUDE.md'), '@AGENTS.md\nlocal edits\n');
		const result = await removeClaudePointer(fixture.root, options(fixture));
		expect(result.success).toBe(false);
		expect(fs.readFileSync(path.join(fixture.root, 'CLAUDE.md'), 'utf8')).toBe('@AGENTS.md\nlocal edits\n');
		const unconsumed = fixture.rows.filter(row => row.event_type === PROTECTED_STATE_WRITE_COMPLETED);
		expect(unconsumed).toHaveLength(0);
	}), 60_000);

	test('refuses when AGENTS.md does not exist', () => withFixture({ 'CLAUDE.md': '@AGENTS.md\n' }, async fixture => {
		const result = await removeClaudePointer(fixture.root, options(fixture));
		expect(result.success).toBe(false);
		expect(result.error).toContain('AGENTS.md');
		expect(fs.existsSync(path.join(fixture.root, 'CLAUDE.md'))).toBe(true);
		expect(fixture.rows).toHaveLength(0);
	}), 60_000);

	test('refuses below Claude Code 2.1.277 with a clear message', () => withFixture({ 'AGENTS.md': AGENTS, 'CLAUDE.md': '@AGENTS.md\n' }, async fixture => {
		for (const readClaudeVersion of [
			() => '2.1.276 (Claude Code)',
			() => '1.9.999 (Claude Code)',
			() => { throw new Error('spawn claude ENOENT'); },
		]) {
			const result = await removeClaudePointer(fixture.root, options(fixture, { readClaudeVersion }));
			expect(result.success).toBe(false);
			expect(result.error).toContain('2.1.277');
		}
		expect(fs.existsSync(path.join(fixture.root, 'CLAUDE.md'))).toBe(true);
		expect(fixture.rows).toHaveLength(0);
	}), 60_000);

	test('a removal capability never authorizes an edit of CLAUDE.md', () => withFixture({ 'AGENTS.md': AGENTS, 'CLAUDE.md': '@AGENTS.md\n' }, async fixture => {
		const result = await removeClaudePointer(fixture.root, options(fixture));
		expect(result.success).toBe(true);
		for (const content of ['@AGENTS.md\n', 'replacement instructions\n']) {
			const decision = await hook(fixture, [claudeRequest(fixture, content, 'staged_edit')]);
			expect(decision.success).toBe(false);
		}
	}), 60_000);

	test('the issuer refuses non-pointer HEAD bytes even when called directly', () => withFixture({ 'AGENTS.md': AGENTS, 'CLAUDE.md': 'custom\n' }, async fixture => {
		const result = await issueClaudePointerRemovalAuthorization(fixture.root, {
			actor: 'pointer-test',
			sourceHead: fixture.head,
		}, { deps: fixture.kernelDeps });
		expect(result.success).toBe(false);
		expect(fixture.rows).toHaveLength(0);
	}), 60_000);

	test('the setup handler routes the flag and fails closed without touching custom content', () => withFixture({ 'AGENTS.md': AGENTS, 'CLAUDE.md': 'custom\n' }, async fixture => {
		const result = await setupCommand.handler(['--remove-claude-pointer'], {}, fixture.root);
		expect(result.success).toBe(false);
		expect(fs.readFileSync(path.join(fixture.root, 'CLAUDE.md'), 'utf8')).toBe('custom\n');
	}), 60_000);
});

describe('gate-level binding of the removal writer', () => {
	const scope = 'scope-removal';
	const head = 'a'.repeat(40);
	const removalEvent = (eventType, content) => ({
		entity_type: 'protected_state',
		entity_id: authorizationEntityId(scope, 'CLAUDE.md'),
		event_type: eventType,
		actor: 'pointer-test',
		origin: 'cli',
		created_at: '2026-10-01T00:00:00.000Z',
		payload_json: JSON.stringify({
			version: 1,
			capabilityId: 'removal-capability',
			actor: 'pointer-test',
			path: 'CLAUDE.md',
			surface: 'generated_harness',
			contentHash: hashProtectedContent(content),
			worktreeScope: scope,
			writeIntent: 'delete',
			operation: eventType === PROTECTED_STATE_AUTHORIZATION_ISSUED ? 'remove_claude_import' : 'remove_claude_import_completed',
			viaForgeApi: true,
			sourceHead: head,
			sourceCommand: 'forge setup --remove-claude-pointer',
		}),
	});
	const request = content => ({
		actor: 'pointer-test',
		surface: 'generated_harness',
		path: 'CLAUDE.md',
		content,
		operation: 'staged_delete',
		worktreeScope: scope,
		sourceHead: head,
	});

	test('accepts a completed removal capability bound to pointer bytes', () => {
		const rows = [
			removalEvent(PROTECTED_STATE_AUTHORIZATION_ISSUED, '@AGENTS.md\n'),
			removalEvent(PROTECTED_STATE_WRITE_COMPLETED, '@AGENTS.md\n'),
		];
		expect(evaluateAuthorization(request('@AGENTS.md\n'), rows)).toMatchObject({ allowed: true });
	});

	test('blocks a removal capability bound to any non-pointer bytes', () => {
		const custom = '@AGENTS.md\nextra\n';
		const rows = [
			removalEvent(PROTECTED_STATE_AUTHORIZATION_ISSUED, custom),
			removalEvent(PROTECTED_STATE_WRITE_COMPLETED, custom),
		];
		expect(evaluateAuthorization(request(custom), rows).allowed).toBe(false);
	});
});
