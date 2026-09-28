'use strict';

const { describe, expect, test } = require('bun:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { authorizeAndConsumeProtectedStateWrites } = require('../lib/protected-state-authority');
const { retireWorkflows, producedRequiredContexts } = require('../lib/workflow-retirement');
const releaseCommand = require('../lib/commands/release');

const WORKFLOWS = {
	'.github/workflows/lint.yml': 'name: Lint\non: [pull_request]\njobs:\n  lint:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo lint\n',
	'.github/workflows/ci.yml': 'name: CI\non: [pull_request]\njobs:\n  gate:\n    name: CI Gate\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo gate\n',
	'.github/workflows/reusable.yml': 'name: Reusable\non:\n  workflow_call: {}\njobs:\n  inner:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo inner\n',
	'.github/workflows/caller.yml': 'name: Caller\non: [push]\njobs:\n  call:\n    uses: ./.github/workflows/reusable.yml\n',
	'.github/workflows/followup.yml': 'name: Followup\non:\n  workflow_run:\n    workflows: [Lint]\n    types: [completed]\njobs:\n  after:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo after\n',
	'.github/workflows/matrix.yml': 'name: Matrix\non: [push]\njobs:\n  test:\n    name: Test ${{ matrix.os }}\n    strategy:\n      matrix:\n        os: [ubuntu, windows]\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo test\n',
};

function git(root, args) {
	return spawnSync('git', args, { cwd: root, encoding: 'utf8' });
}

function createFixture(files = WORKFLOWS) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-retire-workflow-'));
	expect(git(root, ['init']).status).toBe(0);
	expect(git(root, ['config', 'user.email', 'forge-test@example.invalid']).status).toBe(0);
	expect(git(root, ['config', 'user.name', 'Forge Test']).status).toBe(0);
	expect(git(root, ['config', 'core.autocrlf', 'false']).status).toBe(0);
	for (const [filePath, content] of Object.entries(files)) {
		fs.mkdirSync(path.dirname(path.join(root, filePath)), { recursive: true });
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

function options(fixture, overrides = {}) {
	return {
		env: {},
		actor: 'retire-test',
		expectedHead: fixture.head,
		reason: 'Folded into Tests stage 0',
		kernelDeps: fixture.kernelDeps,
		readRequiredContexts: async () => ['CI Gate'],
		recordProtectedStateAuditEvent: () => ({ success: true }),
		...overrides,
	};
}

function hookRequest(fixture, filePath, overrides = {}) {
	return {
		actor: 'retire-test',
		surface: 'workflows',
		path: filePath,
		content: Buffer.from(WORKFLOWS[filePath]),
		operation: 'staged_delete',
		sourceHead: fixture.head,
		...overrides,
	};
}

function hook(fixture, requests) {
	return authorizeAndConsumeProtectedStateWrites(fixture.root, requests, {
		deps: fixture.kernelDeps,
		validateCompleteBunPinBatch: () => ({ success: true }),
	});
}

async function withFixture(run) {
	const fixture = createFixture();
	try {
		await run(fixture);
	} finally {
		fs.rmSync(fixture.root, { recursive: true, force: true });
	}
}

describe('forge release retire-workflow', () => {
	test('retires a non-required workflow and the hook accepts the staged deletion', () => withFixture(async fixture => {
		const result = await retireWorkflows(fixture.root, options(fixture, {
			paths: ['.github/workflows/matrix.yml'],
		}));
		expect(result).toMatchObject({ success: true, sourceHead: fixture.head, paths: ['.github/workflows/matrix.yml'] });
		expect(fs.existsSync(path.join(fixture.root, '.github/workflows/matrix.yml'))).toBe(false);
		const issued = fixture.rows.find(row => row.event_type === 'protected_state.authorization.issued');
		expect(issued.payload).toMatchObject({
			writeIntent: 'delete',
			operation: 'retire_workflow',
			sourceCommand: 'forge release retire-workflow',
			reason: 'Folded into Tests stage 0',
		});

		const decision = await hook(fixture, [hookRequest(fixture, '.github/workflows/matrix.yml', {
			content: Buffer.from(WORKFLOWS['.github/workflows/matrix.yml']),
		})]);
		expect(decision).toMatchObject({ success: true, decisions: [{ allowed: true }] });
	}), 15_000);

	test('refuses a workflow that produces a required status context', () => withFixture(async fixture => {
		const result = await retireWorkflows(fixture.root, options(fixture, { paths: ['.github/workflows/ci.yml'] }));
		expect(result.success).toBe(false);
		expect(result.error).toContain('CI Gate');
		expect(fs.existsSync(path.join(fixture.root, '.github/workflows/ci.yml'))).toBe(true);
		expect(fixture.rows).toHaveLength(0);
	}), 15_000);

	test('treats expression job names as producing matching required contexts', () => {
		const produced = producedRequiredContexts(WORKFLOWS['.github/workflows/matrix.yml'], ['Test ubuntu', 'Test (windows)', 'Lint']);
		expect(produced).toEqual(['Test ubuntu', 'Test (windows)']);
	});

	test('refuses when branch protection is unreadable', () => withFixture(async fixture => {
		for (const readRequiredContexts of [
			async () => { throw new Error('HTTP 404'); },
			async () => null,
			async () => [42],
		]) {
			const result = await retireWorkflows(fixture.root, options(fixture, {
				paths: ['.github/workflows/matrix.yml'],
				readRequiredContexts,
			}));
			expect(result.success).toBe(false);
			expect(result.error).toMatch(/protection/i);
		}
		const missingReader = await retireWorkflows(fixture.root, options(fixture, {
			paths: ['.github/workflows/matrix.yml'],
			readRequiredContexts: undefined,
		}));
		expect(missingReader.success).toBe(false);
		expect(fs.existsSync(path.join(fixture.root, '.github/workflows/matrix.yml'))).toBe(true);
		expect(fixture.rows).toHaveLength(0);
	}), 15_000);

	test('refuses a workflow another workflow depends on unless both retire together', () => withFixture(async fixture => {
		const byRun = await retireWorkflows(fixture.root, options(fixture, { paths: ['.github/workflows/lint.yml'] }));
		expect(byRun.success).toBe(false);
		expect(byRun.error).toContain('.github/workflows/followup.yml');
		const byUses = await retireWorkflows(fixture.root, options(fixture, { paths: ['.github/workflows/reusable.yml'] }));
		expect(byUses.success).toBe(false);
		expect(byUses.error).toContain('.github/workflows/caller.yml');
		expect(fixture.rows).toHaveLength(0);

		const together = await retireWorkflows(fixture.root, options(fixture, {
			paths: ['.github/workflows/reusable.yml', '.github/workflows/caller.yml'],
		}));
		expect(together).toMatchObject({ success: true });
		const decision = await hook(fixture, [
			hookRequest(fixture, '.github/workflows/reusable.yml'),
			hookRequest(fixture, '.github/workflows/caller.yml'),
		]);
		expect(decision.success).toBe(true);
	}), 15_000);

	test('the authorization cannot be reused to edit the file or delete a different file', () => withFixture(async fixture => {
		const result = await retireWorkflows(fixture.root, options(fixture, { paths: ['.github/workflows/matrix.yml'] }));
		expect(result.success).toBe(true);

		const edit = await hook(fixture, [hookRequest(fixture, '.github/workflows/matrix.yml', {
			operation: 'staged_edit',
			content: Buffer.from('name: Matrix\non: [push]\njobs: {}\n'),
		})]);
		expect(edit.success).toBe(false);
		const sameBytesEdit = await hook(fixture, [hookRequest(fixture, '.github/workflows/matrix.yml', {
			operation: 'staged_edit',
		})]);
		expect(sameBytesEdit.success).toBe(false);
		const other = await hook(fixture, [hookRequest(fixture, '.github/workflows/lint.yml')]);
		expect(other.success).toBe(false);

		const consumed = await hook(fixture, [hookRequest(fixture, '.github/workflows/matrix.yml')]);
		expect(consumed.success).toBe(true);
		const replay = await hook(fixture, [hookRequest(fixture, '.github/workflows/matrix.yml')]);
		expect(replay.success).toBe(false);
	}), 15_000);

	test('refuses a head mismatch, a missing reason, and paths outside .github/workflows', () => withFixture(async fixture => {
		const cases = [
			{ expectedHead: 'b'.repeat(40), paths: ['.github/workflows/matrix.yml'] },
			{ expectedHead: undefined, paths: ['.github/workflows/matrix.yml'] },
			{ reason: '  ', paths: ['.github/workflows/matrix.yml'] },
			{ paths: ['package.json'] },
			{ paths: ['.github/workflows/nested/x.yml'] },
			{ paths: ['.github/workflows/absent.yml'] },
			{ paths: [] },
		];
		for (const overrides of cases) {
			const result = await retireWorkflows(fixture.root, options(fixture, overrides));
			expect(result.success).toBe(false);
		}
		expect(fixture.rows).toHaveLength(0);
		expect(fs.existsSync(path.join(fixture.root, '.github/workflows/matrix.yml'))).toBe(true);
	}), 15_000);

	test('refuses when the working-tree file differs from HEAD', () => withFixture(async fixture => {
		fs.appendFileSync(path.join(fixture.root, '.github/workflows/matrix.yml'), '# local edit\n');
		const result = await retireWorkflows(fixture.root, options(fixture, { paths: ['.github/workflows/matrix.yml'] }));
		expect(result.success).toBe(false);
		expect(fs.existsSync(path.join(fixture.root, '.github/workflows/matrix.yml'))).toBe(true);
	}), 15_000);

	test('the release command parses files, --reason, and --expect-head', async () => {
		const head = 'a'.repeat(40);
		let called;
		const result = await releaseCommand.handler([
			'retire-workflow', '.github/workflows/a.yml', '--reason', 'gone', '.github/workflows/b.yml', '--expect-head', head,
		], {}, 'root', {
			retireWorkflows: async (root, params) => {
				called = { root, params };
				return { success: true, paths: params.paths, sourceHead: head };
			},
			readRequiredContexts: async () => [],
		});
		expect(result.success).toBe(true);
		expect(called.root).toBe('root');
		expect(called.params).toMatchObject({
			paths: ['.github/workflows/a.yml', '.github/workflows/b.yml'],
			reason: 'gone',
			expectedHead: head,
		});
		expect(await releaseCommand.githubAuth(['retire-workflow', 'x'])).toBe(true);
		expect(await releaseCommand.githubAuth(['check'])).toBe(false);
	});
});
