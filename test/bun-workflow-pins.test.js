'use strict';

const { describe, expect, test } = require('bun:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const releaseCommand = require('../lib/commands/release');
const protectedStateAuthority = require('../lib/protected-state-authority');
const { hashProtectedContent } = require('../lib/protected-state-surfaces');
const {
	NPM_PUBLISH_WORKFLOW_PATH,
	generateNpmPublishWorkflow,
	renderNpmPublishWorkflow,
} = require('../lib/npm-publish-workflow');
const {
	BUN_WORKFLOW_SPECS,
	readPinnedBunVersion,
	renderBunWorkflowPin,
	updateBunWorkflowPins,
} = require('../lib/bun-workflow-pins');

const TEST_HEAD = 'a'.repeat(40);

function fixtureContent(spec, version = '1.3.12') {
	if (spec.path.endsWith('build-binary.yml')) {
		return `name: Build\n\nenv:\n  BUN_VERSION: ${version}\n`;
	}
	return Array.from({ length: spec.count }, (_, index) => (
		`      - name: Setup ${index + 1}\n        with:\n          bun-version: ${version}\n`
	)).join('');
}

function createFixture() {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-bun-pins-'));
	fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ packageManager: 'bun@1.4.2' }));
	for (const spec of BUN_WORKFLOW_SPECS) {
		const fullPath = path.join(root, spec.path);
		fs.mkdirSync(path.dirname(fullPath), { recursive: true });
		fs.writeFileSync(fullPath, fixtureContent(spec));
	}
	return root;
}

describe('Forge-owned Bun workflow pins', () => {
	test('derives one exact stable Bun version and rewrites only allowlisted pin fields', () => {
		expect(readPinnedBunVersion('{"packageManager":"bun@1.4.2"}')).toBe('1.4.2');
		expect(() => readPinnedBunVersion('{"packageManager":"bun@latest"}')).toThrow('exact stable');
		expect(BUN_WORKFLOW_SPECS).toHaveLength(8);
		expect(BUN_WORKFLOW_SPECS.every(Object.isFrozen)).toBe(true);
		expect(BUN_WORKFLOW_SPECS.some(spec => spec.path.endsWith('npm-publish.yml'))).toBe(false);

		for (const spec of BUN_WORKFLOW_SPECS) {
			const source = fixtureContent(spec);
			const rendered = renderBunWorkflowPin(spec.path, source, '1.4.2');
			expect(rendered.replaceAll('1.4.2', '1.3.12')).toBe(source);
			expect(rendered.match(/1\.4\.2/g)).toHaveLength(spec.count);
		}

		expect(() => renderBunWorkflowPin('.github/workflows/other.yml', 'bun-version: 1.3.12\n', '1.4.2'))
			.toThrow('allowlisted');
		expect(() => renderBunWorkflowPin(BUN_WORKFLOW_SPECS[0].path, 'name: no pin\n', '1.4.2'))
			.toThrow('exactly 1');
	});

	test('updates all owned workflow pins and delegates npm-publish to its existing generator', async () => {
		const root = createFixture();
		const issued = [];
		const completed = [];
		let npmCalls = 0;
		try {
			const result = await updateBunWorkflowPins(root, {
				actor: 'bun-pin-test',
				expectedHead: TEST_HEAD,
				resolveHead: () => TEST_HEAD,
				readIndexedPackageManifest: () => fs.readFileSync(path.join(root, 'package.json')),
				readSourceWorkflow: (_root, _head, workflowPath) => Buffer.from(fixtureContent(
					BUN_WORKFLOW_SPECS.find(spec => spec.path === workflowPath),
				)),
				readIndexedWorkflow: (_root, workflowPath) => Buffer.from(fixtureContent(
					BUN_WORKFLOW_SPECS.find(spec => spec.path === workflowPath),
				)),
				issueAuthorization: async (_root, params, authorizationOptions) => {
					issued.push(params.path);
					return { success: true, capabilityId: authorizationOptions.capabilityId };
				},
				completeAuthorization: async (_root, params) => {
					completed.push(params.path);
					return { success: true };
				},
				writeProtectedFile: (projectRoot, workflowPath, content, options) => {
					const fullPath = path.join(projectRoot, workflowPath);
					expect(fs.readFileSync(fullPath)).toEqual(options.expectedContent);
					fs.writeFileSync(fullPath, content);
					return { allowed: true, contentHash: `hash-${workflowPath}` };
				},
				recordProtectedStateAuditEvent: () => ({ success: true }),
				generateNpmPublishWorkflow: async (_root, options) => {
					npmCalls += 1;
					expect(options.expectedHead).toBe(TEST_HEAD);
					return { success: true, path: '.github/workflows/npm-publish.yml' };
				},
			});

			expect(result.success).toBe(true);
			expect(issued).toEqual(BUN_WORKFLOW_SPECS.map(spec => spec.path));
			expect(completed).toEqual(issued);
			expect(npmCalls).toBe(1);
			for (const spec of BUN_WORKFLOW_SPECS) {
				expect(fs.readFileSync(path.join(root, spec.path), 'utf8')).toContain('1.4.2');
			}
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	test('fails before authority or writes when a workflow has unrelated local edits', async () => {
		const root = createFixture();
		let authorityCalls = 0;
		try {
			fs.appendFileSync(path.join(root, BUN_WORKFLOW_SPECS[0].path), '# unrelated\n');
			const result = await updateBunWorkflowPins(root, {
				expectedHead: TEST_HEAD,
				resolveHead: () => TEST_HEAD,
				readIndexedPackageManifest: () => fs.readFileSync(path.join(root, 'package.json')),
				readSourceWorkflow: (_root, _head, workflowPath) => Buffer.from(fixtureContent(
					BUN_WORKFLOW_SPECS.find(spec => spec.path === workflowPath),
				)),
				readIndexedWorkflow: (_root, workflowPath) => Buffer.from(fixtureContent(
					BUN_WORKFLOW_SPECS.find(spec => spec.path === workflowPath),
				)),
				issueAuthorization: async () => {
					authorityCalls += 1;
					return { success: true };
				},
			});

			expect(result.success).toBe(false);
			expect(result.error).toContain('unrelated local edits');
			expect(authorityCalls).toBe(0);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	test('fails before authority or writes when the working Bun pin differs from the index', async () => {
		const root = createFixture();
		let authorityCalls = 0;
		try {
			const result = await updateBunWorkflowPins(root, {
				expectedHead: TEST_HEAD,
				resolveHead: () => TEST_HEAD,
				readIndexedPackageManifest: () => Buffer.from('{"packageManager":"bun@1.3.12"}'),
				issueAuthorization: async () => {
					authorityCalls += 1;
					return { success: true };
				},
			});

			expect(result).toMatchObject({ success: false });
			expect(result.error).toContain('differs from the Git index');
			expect(authorityCalls).toBe(0);
			for (const spec of BUN_WORKFLOW_SPECS) {
				expect(fs.readFileSync(path.join(root, spec.path), 'utf8')).toBe(fixtureContent(spec));
			}
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	test('restores the compare-and-swap snapshot when completion fails', async () => {
		const root = createFixture();
		const first = BUN_WORKFLOW_SPECS[0];
		try {
			const result = await updateBunWorkflowPins(root, {
				expectedHead: TEST_HEAD,
				resolveHead: () => TEST_HEAD,
				readIndexedPackageManifest: () => fs.readFileSync(path.join(root, 'package.json')),
				readSourceWorkflow: (_root, _head, workflowPath) => Buffer.from(fixtureContent(
					BUN_WORKFLOW_SPECS.find(spec => spec.path === workflowPath),
				)),
				readIndexedWorkflow: (_root, workflowPath) => Buffer.from(fixtureContent(
					BUN_WORKFLOW_SPECS.find(spec => spec.path === workflowPath),
				)),
				issueAuthorization: async (_root, _params, authorizationOptions) => ({ success: true, capabilityId: authorizationOptions.capabilityId }),
				completeAuthorization: async () => ({ success: false, error: 'injected completion failure' }),
				cancelAuthorizations: async (_root, records) => ({ success: true, results: records.map(record => ({ ...record, success: true })) }),
				writeProtectedFile: (projectRoot, workflowPath, content, options) => {
					const fullPath = path.join(projectRoot, workflowPath);
					if (!fs.readFileSync(fullPath).equals(Buffer.from(options.expectedContent))) {
						return { allowed: false, reason: 'compare-and-swap mismatch' };
					}
					fs.writeFileSync(fullPath, content);
					return { allowed: true, contentHash: 'hash' };
				},
				recordProtectedStateAuditEvent: () => ({ success: true }),
			});

			expect(result).toMatchObject({ success: false, recovery: { allowed: true } });
			expect(fs.readFileSync(path.join(root, first.path), 'utf8')).toBe(fixtureContent(first));
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	test('restores every earlier workflow for each post-preflight failure path', async () => {
		const scenarios = [
			'authorization failure',
			'authorization throw',
			'write denied',
			'write throw after mutation',
			'audit failure',
			'audit throw',
			'completion failure',
			'completion throw',
			'npm failure',
			'npm throw',
		];

		for (const scenario of scenarios) {
			const root = createFixture();
			let authorizationCalls = 0;
			let writeCalls = 0;
			let auditCalls = 0;
			let completionCalls = 0;
			try {
				const result = await updateBunWorkflowPins(root, {
					expectedHead: TEST_HEAD,
					resolveHead: () => TEST_HEAD,
					readIndexedPackageManifest: () => fs.readFileSync(path.join(root, 'package.json')),
					readSourceWorkflow: (_root, _head, workflowPath) => Buffer.from(fixtureContent(
						BUN_WORKFLOW_SPECS.find(spec => spec.path === workflowPath),
					)),
					readIndexedWorkflow: (_root, workflowPath) => Buffer.from(fixtureContent(
						BUN_WORKFLOW_SPECS.find(spec => spec.path === workflowPath),
					)),
					issueAuthorization: async (_root, _params, authorizationOptions) => {
						const call = authorizationCalls++;
						if (call === 1 && scenario === 'authorization throw') throw new Error('authorization throw');
						if (call === 1 && scenario === 'authorization failure') return { success: false, error: 'authorization failure' };
						return { success: true, capabilityId: authorizationOptions.capabilityId };
					},
					completeAuthorization: async () => {
						const call = completionCalls++;
						if (call === 1 && scenario === 'completion throw') throw new Error('completion throw');
						if (call === 1 && scenario === 'completion failure') return { success: false, error: 'completion failure' };
						return { success: true };
					},
					writeProtectedFile: (projectRoot, workflowPath, content, options) => {
						const fullPath = path.join(projectRoot, workflowPath);
						if (!fs.readFileSync(fullPath).equals(Buffer.from(options.expectedContent))) {
							return { allowed: false, reason: 'compare-and-swap mismatch' };
						}
						if (options.operation === 'update_bun_workflow_pin') {
							const call = writeCalls++;
							if (call === 1 && scenario === 'write denied') return { allowed: false, reason: 'write denied' };
							fs.writeFileSync(fullPath, content);
							if (call === 1 && scenario === 'write throw after mutation') throw new Error('write throw after mutation');
						} else {
							fs.writeFileSync(fullPath, content);
						}
						return { allowed: true, contentHash: 'hash' };
					},
					removeProtectedFile: (projectRoot, workflowPath, options) => {
						const fullPath = path.join(projectRoot, workflowPath);
						if (!fs.readFileSync(fullPath).equals(Buffer.from(options.expectedContent))) {
							return { allowed: false, reason: 'compare-and-swap mismatch' };
						}
						fs.rmSync(fullPath);
						return { allowed: true };
					},
					recordProtectedStateAuditEvent: () => {
						const call = auditCalls++;
						if (call === 1 && scenario === 'audit throw') throw new Error('audit throw');
						if (call === 1 && scenario === 'audit failure') return { success: false, error: 'audit failure' };
						return { success: true };
					},
					cancelAuthorizations: async (_root, records) => ({ success: true, results: records.map(record => ({ ...record, success: true })) }),
					generateNpmPublishWorkflow: async () => {
						if (scenario === 'npm throw') throw new Error('npm throw');
						if (scenario === 'npm failure') return { success: false, error: 'npm failure' };
						return { success: true, path: NPM_PUBLISH_WORKFLOW_PATH };
					},
				});

				expect(result.success, scenario).toBe(false);
				expect(result.recovery.allowed, scenario).toBe(true);
				for (const spec of BUN_WORKFLOW_SPECS) {
					expect(fs.readFileSync(path.join(root, spec.path), 'utf8'), scenario).toBe(fixtureContent(spec));
				}
			} finally {
				fs.rmSync(root, { recursive: true, force: true });
			}
		}
	});

	test('removes a partially generated npm workflow and continues after a recovery failure', async () => {
		const root = createFixture();
		const first = BUN_WORKFLOW_SPECS[0];
		const second = BUN_WORKFLOW_SPECS[1];
		try {
			const result = await updateBunWorkflowPins(root, {
				expectedHead: TEST_HEAD,
				resolveHead: () => TEST_HEAD,
				readIndexedPackageManifest: () => fs.readFileSync(path.join(root, 'package.json')),
				readSourceWorkflow: (_root, _head, workflowPath) => Buffer.from(fixtureContent(
					BUN_WORKFLOW_SPECS.find(spec => spec.path === workflowPath),
				)),
				readIndexedWorkflow: (_root, workflowPath) => Buffer.from(fixtureContent(
					BUN_WORKFLOW_SPECS.find(spec => spec.path === workflowPath),
				)),
				issueAuthorization: async (_root, _params, authorizationOptions) => ({ success: true, capabilityId: authorizationOptions.capabilityId }),
				completeAuthorization: async () => ({ success: true }),
				cancelAuthorizations: async (_root, records) => ({ success: true, results: records.map(record => ({ ...record, success: true })) }),
				writeProtectedFile: (projectRoot, workflowPath, content, options) => {
					const fullPath = path.join(projectRoot, workflowPath);
					if (options.operation === 'recover_bun_workflow_pin' && workflowPath === second.path) {
						throw new Error('injected recovery failure');
					}
					if (!fs.readFileSync(fullPath).equals(Buffer.from(options.expectedContent))) {
						return { allowed: false, reason: 'compare-and-swap mismatch' };
					}
					fs.writeFileSync(fullPath, content);
					return { allowed: true, contentHash: 'hash' };
				},
				removeProtectedFile: (projectRoot, workflowPath, options) => {
					const fullPath = path.join(projectRoot, workflowPath);
					expect(fs.readFileSync(fullPath)).toEqual(Buffer.from(options.expectedContent));
					fs.rmSync(fullPath);
					return { allowed: true };
				},
				recordProtectedStateAuditEvent: () => ({ success: true }),
				generateNpmPublishWorkflow: async projectRoot => {
					const npmPath = path.join(projectRoot, NPM_PUBLISH_WORKFLOW_PATH);
					fs.mkdirSync(path.dirname(npmPath), { recursive: true });
					fs.writeFileSync(npmPath, renderNpmPublishWorkflow('1.4.2'));
					throw new Error('npm failed after write');
				},
			});

			expect(result).toMatchObject({ success: false, error: 'npm failed after write', recovery: { allowed: false } });
			expect(fs.existsSync(path.join(root, NPM_PUBLISH_WORKFLOW_PATH))).toBe(false);
			expect(fs.readFileSync(path.join(root, first.path), 'utf8')).toBe(fixtureContent(first));
			expect(fs.readFileSync(path.join(root, second.path), 'utf8')).toContain('1.4.2');
			expect(result.recovery.files.find(file => file.path === second.path).reason).toBe('injected recovery failure');
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	test('preserves an npm workflow changed after batch preflight and restores earlier writes', async () => {
		const root = createFixture();
		const npmPath = path.join(root, NPM_PUBLISH_WORKFLOW_PATH);
		const originalNpm = Buffer.from('name: original npm workflow\n');
		const concurrentNpm = Buffer.from('name: concurrent npm workflow\n');
		fs.mkdirSync(path.dirname(npmPath), { recursive: true });
		fs.writeFileSync(npmPath, originalNpm);
		try {
			const result = await updateBunWorkflowPins(root, {
				expectedHead: TEST_HEAD,
				resolveHead: () => TEST_HEAD,
				readIndexedPackageManifest: () => fs.readFileSync(path.join(root, 'package.json')),
				readSourceWorkflow: (_root, _head, workflowPath) => Buffer.from(fixtureContent(
					BUN_WORKFLOW_SPECS.find(spec => spec.path === workflowPath),
				)),
				readIndexedWorkflow: (_root, workflowPath) => Buffer.from(fixtureContent(
					BUN_WORKFLOW_SPECS.find(spec => spec.path === workflowPath),
				)),
				issueAuthorization: async (_root, _params, authorizationOptions) => ({ success: true, capabilityId: authorizationOptions.capabilityId }),
				completeAuthorization: async () => ({ success: true }),
				cancelAuthorizations: async (_root, records) => ({ success: true, results: records.map(record => ({ ...record, success: true })) }),
				writeProtectedFile: (projectRoot, workflowPath, content, options) => {
					const fullPath = path.join(projectRoot, workflowPath);
					if (!fs.readFileSync(fullPath).equals(Buffer.from(options.expectedContent))) {
						return { allowed: false, reason: 'compare-and-swap mismatch' };
					}
					fs.writeFileSync(fullPath, content);
					return { allowed: true, contentHash: 'hash' };
				},
				recordProtectedStateAuditEvent: () => ({ success: true }),
				generateNpmPublishWorkflow: async (projectRoot, options) => {
					fs.writeFileSync(npmPath, concurrentNpm);
					return generateNpmPublishWorkflow(projectRoot, {
						...options,
						prepareNpmPublishWorkflowAuthorization: async () => {
							throw new Error('authority must not run after snapshot drift');
						},
					});
				},
			});

			expect(result.success).toBe(false);
			expect(result.error).toContain('changed after Bun pin batch preflight');
			expect(result.recovery.allowed).toBe(false);
			expect(fs.readFileSync(npmPath)).toEqual(concurrentNpm);
			for (const spec of BUN_WORKFLOW_SPECS) {
				expect(fs.readFileSync(path.join(root, spec.path), 'utf8')).toBe(fixtureContent(spec));
			}
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	test('release exposes the single-shot command without replacing issue release behavior', async () => {
		let called;
		const result = await releaseCommand.handler(
			['update-bun-pins', '--expect-head', TEST_HEAD],
			{},
			'C:/repo',
			{
				updateBunWorkflowPins: async (root, options) => {
					called = { root, options };
					return { success: true, version: '1.4.2', paths: BUN_WORKFLOW_SPECS.map(spec => spec.path) };
				},
			},
		);

		expect(result.success).toBe(true);
		expect(called.root).toBe('C:/repo');
		expect(called.options.expectedHead).toBe(TEST_HEAD);
		expect(result.output).toContain('Bun 1.4.2');
	});

	test('the hook authority accepts only exact command-owned Bun workflow evidence', async () => {
		const workflowPath = BUN_WORKFLOW_SPECS[0].path;
		const content = renderBunWorkflowPin(workflowPath, fixtureContent(BUN_WORKFLOW_SPECS[0]), '1.4.2');
		const worktreeScope = 'bun-pin-scope';
		const capabilityId = 'bun-pin-capability';
		const event = (eventType, operation) => ({
			entity_type: 'protected_state',
			entity_id: protectedStateAuthority.authorizationEntityId(worktreeScope, workflowPath),
			event_type: eventType,
			actor: 'bun-pin-test',
			origin: 'cli',
			created_at: '2026-09-09T00:00:00.000Z',
			payload_json: JSON.stringify({
				version: 1,
				capabilityId,
				actor: 'bun-pin-test',
				path: workflowPath,
				surface: 'workflows',
				contentHash: hashProtectedContent(content),
				sourceHead: TEST_HEAD,
				worktreeScope,
				writeIntent: 'update',
				targetBunVersion: '1.4.2',
				operation,
				viaForgeApi: true,
				sourceCommand: 'forge release update-bun-pins',
			}),
		});
		const rows = [
			event(protectedStateAuthority.PROTECTED_STATE_AUTHORIZATION_ISSUED, 'update_bun_workflow_pin'),
			event(protectedStateAuthority.PROTECTED_STATE_WRITE_COMPLETED, 'update_bun_workflow_pin_completed'),
		];

		expect(protectedStateAuthority.evaluateAuthorization({
			actor: 'bun-pin-test',
			path: workflowPath,
			surface: 'workflows',
			content,
			sourceHead: TEST_HEAD,
			worktreeScope,
		}, rows)).toMatchObject({ allowed: true, capabilityId });
		const stagedRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-bun-hook-target-'));
		try {
			const run = args => spawnSync('git', args, { cwd: stagedRoot, encoding: 'utf8' });
			expect(run(['init']).status).toBe(0);
			fs.writeFileSync(path.join(stagedRoot, 'package.json'), '{"packageManager":"bun@1.4.3"}');
			expect(run(['add', 'package.json']).status).toBe(0);
			const hook = await protectedStateAuthority.authorizeAndConsumeProtectedStateWrites(stagedRoot, [{
				actor: 'bun-pin-test',
				path: workflowPath,
				surface: 'workflows',
				content,
				sourceHead: TEST_HEAD,
			}], {
				worktreeScope,
				deps: {
					kernelBroker: { config: {} },
					kernelDriver: {
						listKernelEvents: async () => rows,
						insertKernelEvent: async () => {
							throw new Error('changed target must be rejected before consumption');
						},
					},
				},
			});
			expect(hook).toMatchObject({ success: false });
			expect(hook.decisions[0].reason).toContain('changed after workflow generation');
		} finally {
			fs.rmSync(stagedRoot, { recursive: true, force: true });
		}
		const kernelRows = [...rows];
		const cancellation = await protectedStateAuthority.cancelBunWorkflowBatchAuthorizations('C:/repo', [{
			actor: 'bun-pin-test',
			path: workflowPath,
			sourceHead: TEST_HEAD,
			capabilityId,
		}], {
			worktreeScope,
			deps: {
				kernelBroker: { config: {} },
				kernelDriver: {
					listKernelEvents: async () => kernelRows,
					insertKernelEvent: async event => {
						kernelRows.push(event);
						return event;
					},
				},
			},
		});
		expect(cancellation).toMatchObject({ success: true });
		expect(protectedStateAuthority.evaluateAuthorization({
			actor: 'bun-pin-test',
			path: workflowPath,
			surface: 'workflows',
			content,
			sourceHead: TEST_HEAD,
			worktreeScope,
		}, kernelRows)).toMatchObject({ allowed: false });
		expect(protectedStateAuthority.evaluateAuthorization({
			actor: 'bun-pin-test',
			path: '.github/workflows/npm-publish.yml',
			surface: 'workflows',
			content,
			sourceHead: TEST_HEAD,
			worktreeScope,
		}, rows).allowed).toBe(false);

		const rejected = await protectedStateAuthority.issueBunWorkflowAuthorization('C:/repo', {
			actor: 'bun-pin-test',
			path: '.github/workflows/other.yml',
			sourceHead: TEST_HEAD,
		});
		expect(rejected).toMatchObject({ success: false });
	});

	test('public authority cannot replace the immutable Git baseline through test seams', async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-bun-authority-'));
		try {
			const run = (args) => spawnSync('git', args, { cwd: root, encoding: 'utf8' });
			expect(run(['init']).status).toBe(0);
			expect(run(['config', 'user.email', 'forge-test@example.invalid']).status).toBe(0);
			expect(run(['config', 'user.name', 'Forge Test']).status).toBe(0);
			fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ packageManager: 'bun@1.4.2' }));
			expect(run(['add', 'package.json']).status).toBe(0);
			expect(run(['commit', '-m', 'base']).status).toBe(0);
			const head = run(['rev-parse', 'HEAD']).stdout.trim();
			const mismatchedNpmIssue = await protectedStateAuthority.issueNpmPublishWorkflowAuthorization(root, {
				actor: 'bun-pin-test',
				sourceHead: head,
				bunVersion: '1.3.12',
				targetBunVersion: '1.4.2',
			});
			const mismatchedNpmCompletion = await protectedStateAuthority.completeNpmPublishWorkflowAuthorization(root, {
				actor: 'bun-pin-test',
				sourceHead: head,
				capabilityId: 'mismatched-npm-capability',
				bunVersion: '1.3.12',
				targetBunVersion: '1.4.2',
			});
			expect(mismatchedNpmIssue).toMatchObject({ success: false });
			expect(mismatchedNpmCompletion).toMatchObject({ success: false });

			const result = await protectedStateAuthority.issueBunWorkflowAuthorization(root, {
				actor: 'bun-pin-test',
				path: BUN_WORKFLOW_SPECS[0].path,
				sourceHead: head,
				targetBunVersion: '1.4.2',
			}, {
				readSourceWorkflow: () => Buffer.from('run: attacker-controlled\nenv:\n  BUN_VERSION: 1.3.12\n'),
			});

			expect(result).toMatchObject({ success: false });
			expect(result.error).toContain('not a regular workflow file');
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	test('authority rechecks live HEAD and the manifest after awaited Kernel reads', async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-bun-race-'));
		try {
			const run = (args) => spawnSync('git', args, { cwd: root, encoding: 'utf8' });
			const spec = BUN_WORKFLOW_SPECS[0];
			const fullPath = path.join(root, spec.path);
			expect(run(['init']).status).toBe(0);
			expect(run(['config', 'user.email', 'forge-test@example.invalid']).status).toBe(0);
			expect(run(['config', 'user.name', 'Forge Test']).status).toBe(0);
			fs.mkdirSync(path.dirname(fullPath), { recursive: true });
			fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ packageManager: 'bun@1.4.2' }));
			fs.writeFileSync(fullPath, fixtureContent(spec));
			expect(run(['add', '.']).status).toBe(0);
			expect(run(['commit', '-m', 'base']).status).toBe(0);
			const sourceHead = run(['rev-parse', 'HEAD']).stdout.trim();

			fs.writeFileSync(path.join(root, 'note.txt'), 'new head\n');
			expect(run(['add', 'note.txt']).status).toBe(0);
			expect(run(['commit', '-m', 'move head']).status).toBe(0);
			const stale = await protectedStateAuthority.issueBunWorkflowAuthorization(root, {
				actor: 'bun-pin-test',
				path: spec.path,
				sourceHead,
				targetBunVersion: '1.4.2',
			});
			expect(stale).toMatchObject({ success: false });
			expect(stale.error).toContain('source HEAD changed');

			const currentHead = run(['rev-parse', 'HEAD']).stdout.trim();
			let inserts = 0;
			const raced = await protectedStateAuthority.issueBunWorkflowAuthorization(root, {
				actor: 'bun-pin-test',
				path: spec.path,
				sourceHead: currentHead,
				targetBunVersion: '1.4.2',
			}, {
				deps: {
					kernelBroker: { config: {} },
					kernelDriver: {
						listKernelEvents: async () => {
							fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ packageManager: 'bun@1.4.3' }));
							return [];
						},
						insertKernelEvent: async () => {
							inserts += 1;
							throw new Error('must not insert');
						},
					},
				},
			});
			expect(raced).toMatchObject({ success: false });
			expect(raced.error).toMatch(/target changed|pin differs/);
			expect(inserts).toBe(0);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});
});
