// forge-test-resource: exclusive
'use strict';

const { describe, expect, test } = require('bun:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const YAML = require('yaml');
const { hashProtectedContent } = require('../lib/protected-state-surfaces');
const protectedStateAuthority = require('../lib/protected-state-authority');
const { BUN_WORKFLOW_SPECS } = require('../lib/bun-workflow-pins');
const releaseCommand = require('../lib/commands/release');
const {
	SIZE_WORKFLOW_PATH,
	renderSizeWorkflow,
	generateSizeWorkflow,
} = require('../lib/size-workflow');

const repoRoot = path.resolve(__dirname, '..');
const BUDGET_MANIFEST_PATH = 'scripts/package-budgets.json';
const pinnedVersion = () => /^bun@(\d+\.\d+\.\d+)$/.exec(require('../package.json').packageManager)[1];

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

function createFixture({ bunVersion = '1.4.2', workflow = 'name: Package Size Monitor\n# hand-written legacy workflow\n' } = {}) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-size-workflow-'));
	expect(git(root, ['init']).status).toBe(0);
	expect(git(root, ['config', 'user.email', 'forge-test@example.invalid']).status).toBe(0);
	expect(git(root, ['config', 'user.name', 'Forge Test']).status).toBe(0);
	write(root, 'package.json', `{"packageManager":"bun@${bunVersion}"}\n`);
	write(root, BUDGET_MANIFEST_PATH, '{"blocks":{"lib":{"paths":["lib/"]}}}\n');
	write(root, SIZE_WORKFLOW_PATH, workflow);
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

function authorize(fixture, kernel, content, options = { validateCompleteBunPinBatch: () => ({ success: true }) }) {
	return protectedStateAuthority.authorizeAndConsumeProtectedStateWrites(fixture.root, [{
		actor: 'unknown',
		path: SIZE_WORKFLOW_PATH,
		surface: 'workflows',
		content,
		sourceHead: fixture.head,
	}], { deps: kernel.deps, ...options });
}

describe('size workflow renderer', () => {
	test('is byte-stable: its only input is the Bun version, never env or time', () => {
		const first = renderSizeWorkflow('1.4.2');
		process.env.FORGE_SIZE_RENDER_PROBE = String(Date.now());
		try {
			expect(renderSizeWorkflow('1.4.2').equals(first)).toBe(true);
		} finally {
			delete process.env.FORGE_SIZE_RENDER_PROBE;
		}
		expect(renderSizeWorkflow.length).toBe(1);
		expect(first.toString('utf8')).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
		expect(() => YAML.parse(first.toString('utf8'))).not.toThrow();
	});

	test('the committed workflow equals the render of the pinned Bun version (drift test)', () => {
		const committed = fs.readFileSync(path.join(repoRoot, SIZE_WORKFLOW_PATH));
		expect(renderSizeWorkflow(pinnedVersion()).toString('utf8')).toBe(committed.toString('utf8'));
	});

	test('has no path filters, so no new publishable path can escape the check', () => {
		const workflow = YAML.parse(renderSizeWorkflow('1.4.2').toString('utf8'));
		expect(workflow.on.push).toEqual({ branches: ['main', 'master'] });
		expect(workflow.on.pull_request).toEqual({ branches: ['main', 'master'] });
	});

	test('rejects inexact Bun versions', () => {
		expect(() => renderSizeWorkflow('latest')).toThrow(/exact stable Bun/);
	});

	test('has exactly one owner: it is no longer a pin-only Bun workflow', () => {
		expect(BUN_WORKFLOW_SPECS.map((spec) => spec.path)).not.toContain(SIZE_WORKFLOW_PATH);
	});

	test('pins Node from the same source as npm-publish.yml before measuring the package', () => {
		const { WORKFLOW_NODE_VERSION, renderNpmPublishWorkflow } = require('../lib/npm-publish-workflow');
		expect(Number.isInteger(WORKFLOW_NODE_VERSION)).toBe(true);
		const steps = YAML.parse(renderSizeWorkflow('1.4.2').toString('utf8')).jobs['size-check'].steps;
		const setupIndex = steps.findIndex((s) => (s.uses || '').startsWith('actions/setup-node'));
		const checkIndex = steps.findIndex((s) => (s.run || '').includes('node scripts/package-size-check.js'));
		expect(setupIndex).toBeGreaterThanOrEqual(0);
		expect(setupIndex).toBeLessThan(checkIndex);
		expect(steps[setupIndex].with['node-version']).toBe(WORKFLOW_NODE_VERSION);
		// Same action ref style as the other generated workflows, and npm-publish.yml pins the same version.
		const publishJobs = Object.values(YAML.parse(renderNpmPublishWorkflow('1.4.2')).jobs);
		const publishSetups = publishJobs.flatMap((job) => job.steps || []).filter((s) => (s.uses || '').startsWith('actions/setup-node'));
		expect(publishSetups.length).toBeGreaterThan(0);
		for (const step of publishSetups) {
			expect(step.uses).toBe(steps[setupIndex].uses);
			expect(step.with['node-version']).toBe(WORKFLOW_NODE_VERSION);
		}
	});
});

describe('size workflow base-baseline step', () => {
	const { resolveBashCommand } = require('./helpers/bash');
	const BASELINE = 'scripts/package-size-baseline.json';

	function baselineStep() {
		const steps = YAML.parse(renderSizeWorkflow('1.4.2').toString('utf8')).jobs['size-check'].steps;
		return steps.find((s) => s.if === "github.event_name == 'pull_request'" && (s.run || '').includes('base-baseline.json'));
	}

	// Builds a repo whose HEAD^1 is `parent` (a list of files) and runs the rendered step in bash.
	function runStep(parentFiles, { withParent = true } = {}) {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), 'size-base-step-'));
		const runnerTemp = path.join(root, '.runner-temp');
		fs.mkdirSync(runnerTemp);
		try {
			git(root, ['init', '-q']);
			git(root, ['config', 'user.email', 'test@example.com']);
			git(root, ['config', 'user.name', 'Test']);
			git(root, ['config', 'commit.gpgsign', 'false']);
			write(root, 'fixture.txt', 'base\n');
			for (const [file, content] of Object.entries(parentFiles)) write(root, file, content);
			git(root, ['add', '-A']);
			git(root, ['commit', '-q', '-m', 'base']);
			if (withParent) {
				write(root, 'fixture.txt', 'head\n');
				git(root, ['commit', '-q', '-am', 'head']);
			}
			const result = spawnSync(resolveBashCommand(), ['-c', baselineStep().run], {
				cwd: root,
				encoding: 'utf8',
				env: { ...process.env, RUNNER_TEMP: runnerTemp },
			});
			const out = path.join(runnerTemp, 'base-baseline.json');
			return { status: result.status, stderr: result.stderr, written: fs.existsSync(out) ? fs.readFileSync(out, 'utf8') : null };
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	}

	test('never swallows git errors with an "|| rm -f" fallback', () => {
		const run = baselineStep().run;
		expect(run).toContain('set -euo pipefail');
		expect(run).toContain(`git ls-tree --name-only HEAD^1 -- ${BASELINE}`);
		expect(run).not.toMatch(/\|\|/);
	});

	test('copies the base baseline when HEAD^1 has one', () => {
		const result = runStep({ [BASELINE]: '{"total":{}}\n' });
		expect(result.status).toBe(0);
		expect(result.written).toBe('{"total":{}}\n');
	}, 30000);

	test('falls back (no file, exit 0) only when HEAD^1 genuinely has no baseline', () => {
		const result = runStep({});
		expect(result.status).toBe(0);
		expect(result.written).toBeNull();
	}, 30000);

	test('fails the step when git cannot read HEAD^1', () => {
		const result = runStep({ [BASELINE]: '{}\n' }, { withParent: false });
		expect(result.status).not.toBe(0);
		expect(result.written).toBeNull();
	}, 30000);
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
			expect(content.equals(renderSizeWorkflow('1.4.2'))).toBe(true);
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

	// Regression for the dual-owner deadlock: a staged manifest change and a staged
	// Bun bump, in either order, must yield one committable, hook-accepted file.
	test.each([
		['manifest first, then Bun bump', ['manifest', 'bun']],
		['Bun bump first, then manifest', ['bun', 'manifest']],
	])('a manifest change and a Bun bump staged together: %s', async (_label, order) => {
		const fixture = createFixture({ bunVersion: '1.3.12', workflow: renderSizeWorkflow('1.3.12') });
		const kernel = fakeKernel();
		const steps = {
			manifest: () => write(fixture.root, BUDGET_MANIFEST_PATH, '{"blocks":{"lib":{"paths":["lib/"]},"widgets":{"paths":["widgets/"]}}}\n'),
			bun: () => write(fixture.root, 'package.json', '{"packageManager":"bun@1.4.2"}\n'),
		};
		try {
			for (const step of order) {
				steps[step]();
				expect(git(fixture.root, ['add', 'package.json', BUDGET_MANIFEST_PATH]).status).toBe(0);
			}
			const generated = await generate(fixture, kernel);
			expect(generated).toMatchObject({ success: true });
			const content = fs.readFileSync(path.join(fixture.root, SIZE_WORKFLOW_PATH));
			expect(content.equals(renderSizeWorkflow('1.4.2'))).toBe(true);
			expect(git(fixture.root, ['add', SIZE_WORKFLOW_PATH]).status).toBe(0);
			const committed = await authorize(fixture, kernel, content, {});
			expect(committed).toMatchObject({ success: true, decisions: [{ allowed: true }] });
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
