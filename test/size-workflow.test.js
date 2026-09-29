// forge-test-resource: exclusive
'use strict';

const { describe, expect, test } = require('bun:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const yaml = require('js-yaml');
const { hashProtectedContent } = require('../lib/protected-state-surfaces');
const protectedStateAuthority = require('../lib/protected-state-authority');
const { renderBunWorkflowPin } = require('../lib/bun-workflow-pins');
const releaseCommand = require('../lib/commands/release');
const {
	SIZE_WORKFLOW_PATH,
	BUDGET_MANIFEST_PATH,
	derivePathFilters,
	renderSizeWorkflow,
	generateSizeWorkflow,
} = require('../lib/size-workflow');

const repoRoot = path.resolve(__dirname, '..');
const pinnedVersion = () => /^bun@(\d+\.\d+\.\d+)$/.exec(require('../package.json').packageManager)[1];
const committedManifest = () => fs.readFileSync(path.join(repoRoot, BUDGET_MANIFEST_PATH));

function git(root, args) {
	return spawnSync('git', args, { cwd: root, encoding: 'utf8' });
}

function write(root, filePath, content) {
	const fullPath = path.join(root, filePath);
	fs.mkdirSync(path.dirname(fullPath), { recursive: true });
	fs.writeFileSync(fullPath, content);
}

function writer(projectRoot, filePath, content, options) {
	const fullPath = path.join(projectRoot, filePath);
	if (!fs.readFileSync(fullPath).equals(Buffer.from(options.expectedContent))) {
		return { allowed: false, reason: 'compare-and-swap mismatch' };
	}
	fs.writeFileSync(fullPath, content);
	return { allowed: true, contentHash: hashProtectedContent(content) };
}

function remover(projectRoot, filePath) {
	fs.rmSync(path.join(projectRoot, filePath));
	return { allowed: true };
}

function fakeKernel() {
	const rows = [];
	return {
		rows,
		deps: {
			kernelBroker: { config: {} },
			kernelDriver: {
				listKernelEvents: async () => rows,
				insertKernelEvent: async (event) => { rows.push(event); return event; },
			},
		},
	};
}

function createFixture() {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-size-workflow-'));
	expect(git(root, ['init']).status).toBe(0);
	expect(git(root, ['config', 'user.email', 'forge-test@example.invalid']).status).toBe(0);
	expect(git(root, ['config', 'user.name', 'Forge Test']).status).toBe(0);
	write(root, 'package.json', '{"packageManager":"bun@1.4.2"}\n');
	write(root, BUDGET_MANIFEST_PATH, committedManifest());
	write(root, SIZE_WORKFLOW_PATH, 'name: Package Size Monitor\n# hand-written legacy workflow\n');
	expect(git(root, ['add', '.']).status).toBe(0);
	expect(git(root, ['commit', '-m', 'base']).status).toBe(0);
	return { root, head: git(root, ['rev-parse', 'HEAD']).stdout.trim() };
}

function generate(fixture, kernel, overrides = {}) {
	return generateSizeWorkflow(fixture.root, {
		env: {},
		expectedHead: fixture.head,
		kernelDeps: kernel.deps,
		createCapabilityId: () => 'size-workflow-capability',
		writeProtectedFile: writer,
		removeProtectedFile: remover,
		recordProtectedStateAuditEvent: () => ({ success: true }),
		...overrides,
	});
}

function authorize(fixture, kernel, content) {
	return protectedStateAuthority.authorizeAndConsumeProtectedStateWrites(fixture.root, [{
		actor: 'unknown',
		path: SIZE_WORKFLOW_PATH,
		surface: 'workflows',
		content,
		sourceHead: fixture.head,
	}], { deps: kernel.deps, validateCompleteBunPinBatch: () => ({ success: true }) });
}

describe('size workflow renderer', () => {
	test('is byte-stable: same inputs give the same bytes, regardless of env or time', () => {
		const first = renderSizeWorkflow(committedManifest(), '1.4.2');
		process.env.FORGE_SIZE_RENDER_PROBE = String(Date.now());
		try {
			expect(renderSizeWorkflow(committedManifest(), '1.4.2').equals(first)).toBe(true);
		} finally {
			delete process.env.FORGE_SIZE_RENDER_PROBE;
		}
		expect(first.toString('utf8')).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
		expect(() => yaml.load(first.toString('utf8'))).not.toThrow();
	});

	test('the committed workflow equals the render of the committed manifest (drift test)', () => {
		const committed = fs.readFileSync(path.join(repoRoot, SIZE_WORKFLOW_PATH));
		expect(renderSizeWorkflow(committedManifest(), pinnedVersion()).toString('utf8')).toBe(committed.toString('utf8'));
	});

	test('path filters come from the block manifest plus the check inputs', () => {
		const manifest = { blocks: { a: { paths: ['lib/', 'lib/kernel/', 'node_modules/@forge/x/', 'README.md'] }, b: { paths: ['packages/flow/node_modules/'] } } };
		expect(derivePathFilters(manifest)).toEqual([
			'.github/workflows/size-check.yml',
			'.npmignore',
			'README.md',
			'bun.lock',
			'lib/**',
			'package.json',
			'scripts/package-budgets.json',
			'scripts/package-size-baseline.json',
			'scripts/package-size-check.js',
		]);
	});

	test('adding a block to the manifest adds its path filter', () => {
		const manifest = JSON.parse(committedManifest().toString('utf8'));
		manifest.blocks.widgets = { paths: ['widgets/'] };
		const rendered = renderSizeWorkflow(Buffer.from(JSON.stringify(manifest)), '1.4.2').toString('utf8');
		expect(yaml.load(rendered).on.pull_request.paths).toContain('widgets/**');
	});

	test('rejects manifest paths that could inject YAML, and inexact Bun versions', () => {
		const bad = { blocks: { a: { paths: ["lib/'\n  evil: true"] } } };
		expect(() => renderSizeWorkflow(Buffer.from(JSON.stringify(bad)), '1.4.2')).toThrow(/unsupported characters/);
		expect(() => renderSizeWorkflow(committedManifest(), 'latest')).toThrow(/exact stable Bun/);
	});

	test('the Bun pin updater renders the same bytes as the generator at a new version', () => {
		const current = renderSizeWorkflow(committedManifest(), '1.4.2');
		const pinned = renderBunWorkflowPin(SIZE_WORKFLOW_PATH, current, '1.5.0');
		expect(Buffer.from(pinned).equals(renderSizeWorkflow(committedManifest(), '1.5.0'))).toBe(true);
	});
});

describe('Forge-owned size workflow writer', () => {
	test('requires an exact expected HEAD before touching authority', async () => {
		let calls = 0;
		const result = await generateSizeWorkflow('C:/repo', {
			expectedHead: undefined,
			issueAuthorization: async () => { calls += 1; return { success: true }; },
		});
		expect(result.success).toBe(false);
		expect(result.error).toContain('--expect-head is required');
		expect(calls).toBe(0);
	});

	test('authority accepts the generated bytes through the real issue/complete/consume lifecycle', async () => {
		const fixture = createFixture();
		const kernel = fakeKernel();
		try {
			const generated = await generate(fixture, kernel);
			expect(generated).toMatchObject({ success: true, path: SIZE_WORKFLOW_PATH });
			const content = fs.readFileSync(path.join(fixture.root, SIZE_WORKFLOW_PATH));
			expect(content.equals(renderSizeWorkflow(committedManifest(), '1.4.2'))).toBe(true);
			const committed = await authorize(fixture, kernel, content);
			expect(committed).toMatchObject({
				success: true,
				decisions: [{ allowed: true, capabilityId: 'size-workflow-capability' }],
			});
			const operations = kernel.rows.map((row) => row.payload && row.payload.operation);
			expect(operations).toEqual(['generate_size_workflow', 'generate_size_workflow_completed', 'staged_edit']);
		} finally {
			fs.rmSync(fixture.root, { recursive: true, force: true });
		}
	}, 20_000);

	test('authority rejects a hand edit of the generated file', async () => {
		const fixture = createFixture();
		const kernel = fakeKernel();
		try {
			expect((await generate(fixture, kernel)).success).toBe(true);
			const edited = Buffer.concat([fs.readFileSync(path.join(fixture.root, SIZE_WORKFLOW_PATH)), Buffer.from('# hand edit\n')]);
			const result = await authorize(fixture, kernel, edited);
			expect(result.success).toBe(false);
			expect(result.decisions[0].allowed).toBe(false);
		} finally {
			fs.rmSync(fixture.root, { recursive: true, force: true });
		}
	}, 20_000);

	test('refuses to overwrite unrelated local edits, and never issues authority for them', async () => {
		const fixture = createFixture();
		const kernel = fakeKernel();
		let calls = 0;
		try {
			fs.appendFileSync(path.join(fixture.root, SIZE_WORKFLOW_PATH), '# local hand edit\n');
			const result = await generate(fixture, kernel, {
				issueAuthorization: async () => { calls += 1; return { success: true }; },
			});
			expect(result.success).toBe(false);
			expect(result.error).toContain('unrelated local edits');
			expect(calls).toBe(0);
		} finally {
			fs.rmSync(fixture.root, { recursive: true, force: true });
		}
	}, 20_000);

	test('refuses an unstaged manifest edit so the render is bound to staged bytes', async () => {
		const fixture = createFixture();
		const kernel = fakeKernel();
		try {
			fs.appendFileSync(path.join(fixture.root, BUDGET_MANIFEST_PATH), '\n');
			const result = await generate(fixture, kernel);
			expect(result.success).toBe(false);
			expect(result.error).toContain('differs from the Git index');
		} finally {
			fs.rmSync(fixture.root, { recursive: true, force: true });
		}
	}, 20_000);
});

describe('forge release generate-size-workflow', () => {
	test('dispatches to the size workflow generator with the expected HEAD', async () => {
		const head = 'a'.repeat(40);
		let called;
		const result = await releaseCommand.handler(['generate-size-workflow', '--expect-head', head], {}, 'C:/repo', {
			generateSizeWorkflow: async (root, options) => {
				called = { root, options };
				return { success: true, path: SIZE_WORKFLOW_PATH, contentHash: 'sha256:size' };
			},
		});
		expect(result.success).toBe(true);
		expect(called).toMatchObject({ root: 'C:/repo', options: { expectedHead: head } });
		expect(result.output).toContain(SIZE_WORKFLOW_PATH);
		expect(releaseCommand.usage).toContain('generate-size-workflow --expect-head <full-sha>');
	});
});
