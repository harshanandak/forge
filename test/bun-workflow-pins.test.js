// forge-test-resource: exclusive
'use strict';

const { describe, expect, test } = require('bun:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const releaseCommand = require('../lib/commands/release');
const { secureExecFileSync } = require('../lib/shell-utils');
const protectedStateAuthority = require('../lib/protected-state-authority');
const { hashProtectedContent } = require('../lib/protected-state-surfaces');
const {
	NPM_PUBLISH_WORKFLOW_PATH,
	generateNpmPublishWorkflow,
	renderNpmPublishWorkflow,
} = require('../lib/npm-publish-workflow');
const {
	BUN_WORKFLOW_SPECS,
	readCompleteBunPinBatch,
	readPinnedBunVersion,
	renderBunWorkflowPin,
	updateBunWorkflowPins,
} = require('../lib/bun-workflow-pins');

const TEST_HEAD = 'a'.repeat(40);
const repoRoot = path.resolve(__dirname, '..');

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
	const npmPath = path.join(root, NPM_PUBLISH_WORKFLOW_PATH);
	fs.mkdirSync(path.dirname(npmPath), { recursive: true });
	fs.writeFileSync(npmPath, renderNpmPublishWorkflow('1.3.12'));
	return root;
}

function batchFixtureOptions() {
	return {
		readSourcePackageManifest: () => Buffer.from('{"packageManager":"bun@1.3.12"}'),
		readSourceNpmPublishWorkflow: () => Buffer.from(renderNpmPublishWorkflow('1.3.12')),
		readIndexedNpmPublishWorkflow: () => Buffer.from(renderNpmPublishWorkflow('1.3.12')),
	};
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

	test('reads the complete source and index Bun pin snapshot in four Git calls', () => {
		const root = createFixture();
		const run = args => spawnSync('git', args, { cwd: root, encoding: 'utf8' });
		try {
			expect(run(['init']).status).toBe(0);
			expect(run(['config', 'user.email', 'forge-test@example.invalid']).status).toBe(0);
			expect(run(['config', 'user.name', 'Forge Test']).status).toBe(0);
			expect(run(['add', '.']).status).toBe(0);
			expect(run(['commit', '-m', 'base']).status).toBe(0);
			const sourceHead = run(['rev-parse', 'HEAD']).stdout.trim();
			const gitCalls = [];
			const snapshot = readCompleteBunPinBatch(root, sourceHead, [NPM_PUBLISH_WORKFLOW_PATH],
				(command, args, options) => {
					gitCalls.push(args);
					return secureExecFileSync(command, args, options);
				});

			expect(gitCalls).toHaveLength(4);
			expect(snapshot.source.get('package.json')).toEqual(fs.readFileSync(path.join(root, 'package.json')));
			expect(snapshot.source.size).toBe(1 + BUN_WORKFLOW_SPECS.length);
			expect(snapshot.indexed.size).toBe(2 + BUN_WORKFLOW_SPECS.length);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	test('does not require the workflow snapshot when the staged Bun pin is unchanged', async () => {
		const packageManifest = Buffer.from('{"name":"forge-workflow","packageManager":"bun@1.4.2"}');
		let batchReads = 0;
		const result = await protectedStateAuthority.authorizeAndConsumeProtectedStateWrites('C:\\fixture', [], {
			sourceHead: TEST_HEAD,
			readSourcePackageManifest: () => packageManifest,
			readIndexedPackageManifest: () => packageManifest,
			readCompleteBunPinBatch: () => {
				batchReads += 1;
				throw new Error('workflow snapshot should not be read');
			},
		});

		expect(result).toEqual({ success: true, decisions: [] });
		expect(batchReads).toBe(0);
	});

	test('does not load the npm workflow before detecting an unchanged staged Bun pin', () => {
		const authorityPath = path.join(repoRoot, 'lib', 'protected-state-authority.js');
		const npmWorkflowPath = path.join(repoRoot, 'lib', 'npm-publish-workflow.js');
		const script = `
			const Module = require('node:module');
			const authorityPath = process.argv[1];
			const npmWorkflowPath = process.argv[2];
			const originalLoad = Module._load;
			let invalidManifestReads = 0;
			Module._load = function(request, parent, isMain) {
				if (request === '../package.json' && parent?.filename === npmWorkflowPath) {
					invalidManifestReads += 1;
					return { packageManager: 'bun@latest' };
				}
				return originalLoad.call(this, request, parent, isMain);
			};
			(async () => {
				const authority = require(authorityPath);
				const manifest = version => Buffer.from(JSON.stringify({
					name: 'forge-workflow',
					packageManager: 'bun@' + version,
				}));
				const unchanged = await authority.authorizeAndConsumeProtectedStateWrites('C:\\\\fixture', [], {
					sourceHead: '${TEST_HEAD}',
					readSourcePackageManifest: () => manifest('1.4.2'),
					readIndexedPackageManifest: () => manifest('1.4.2'),
				});
				const readsAfterUnchanged = invalidManifestReads;
				const changed = await authority.authorizeAndConsumeProtectedStateWrites('C:\\\\fixture', [], {
					sourceHead: '${TEST_HEAD}',
					readSourcePackageManifest: () => manifest('1.3.12'),
					readIndexedPackageManifest: () => manifest('1.4.2'),
				});
				process.stdout.write(JSON.stringify({ unchanged, readsAfterUnchanged, changed, invalidManifestReads }));
			})().catch(error => {
				process.stderr.write(error.stack || error.message);
				process.exitCode = 1;
			});
		`;
		const isolated = spawnSync('node', ['-e', script, authorityPath, npmWorkflowPath], {
			cwd: repoRoot,
			encoding: 'utf8',
		});

		expect(isolated.status, isolated.stderr).toBe(0);
		const result = JSON.parse(isolated.stdout);
		expect(result.unchanged).toEqual({ success: true, decisions: [] });
		expect(result.readsAfterUnchanged).toBe(0);
		expect(result.changed).toMatchObject({
			success: false,
			batchDecision: { reason: expect.stringContaining('package.json must pin an exact stable Bun version') },
		});
		expect(result.invalidManifestReads).toBe(1);
	});

	test('updates all owned workflow pins and delegates npm-publish to its existing generator', async () => {
		const root = createFixture();
		const issued = [];
		const completed = [];
		let npmCalls = 0;
		try {
			const result = await updateBunWorkflowPins(root, {
				...batchFixtureOptions(),
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
				...batchFixtureOptions(),
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

	test('rejects pre-existing npm workflow edits before issuing any batch authority', async () => {
		for (const staged of [false, true]) {
			const root = createFixture();
			let authorityCalls = 0;
			try {
				if (!staged) fs.appendFileSync(path.join(root, NPM_PUBLISH_WORKFLOW_PATH), '# unrelated\n');
				const result = await updateBunWorkflowPins(root, {
					...batchFixtureOptions(),
					expectedHead: TEST_HEAD,
					resolveHead: () => TEST_HEAD,
					readIndexedPackageManifest: () => fs.readFileSync(path.join(root, 'package.json')),
					readSourceWorkflow: (_root, _head, workflowPath) => Buffer.from(fixtureContent(
						BUN_WORKFLOW_SPECS.find(spec => spec.path === workflowPath),
					)),
					readIndexedWorkflow: (_root, workflowPath) => Buffer.from(fixtureContent(
						BUN_WORKFLOW_SPECS.find(spec => spec.path === workflowPath),
					)),
					...(staged ? { readIndexedNpmPublishWorkflow: () => Buffer.from('name: unrelated staged npm workflow\n') } : {}),
					issueAuthorization: async () => {
						authorityCalls += 1;
						return { success: true };
					},
				});

				expect(result).toMatchObject({ success: false });
				expect(result.error).toContain(staged ? 'unrelated staged edits' : 'unrelated local edits');
				expect(authorityCalls).toBe(0);
				for (const spec of BUN_WORKFLOW_SPECS) {
					expect(fs.readFileSync(path.join(root, spec.path), 'utf8')).toBe(fixtureContent(spec));
				}
			} finally {
				fs.rmSync(root, { recursive: true, force: true });
			}
		}
	});

	test('fails before authority or writes when the working Bun pin differs from the index', async () => {
		const root = createFixture();
		let authorityCalls = 0;
		try {
			const result = await updateBunWorkflowPins(root, {
				...batchFixtureOptions(),
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
				...batchFixtureOptions(),
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
					...batchFixtureOptions(),
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
				...batchFixtureOptions(),
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
			expect(fs.readFileSync(path.join(root, NPM_PUBLISH_WORKFLOW_PATH), 'utf8')).toBe(renderNpmPublishWorkflow('1.3.12'));
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
		const originalNpm = Buffer.from(renderNpmPublishWorkflow('1.3.12'));
		const concurrentNpm = Buffer.from('name: concurrent npm workflow\n');
		fs.mkdirSync(path.dirname(npmPath), { recursive: true });
		fs.writeFileSync(npmPath, originalNpm);
		try {
			const result = await updateBunWorkflowPins(root, {
				...batchFixtureOptions(),
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
				validateCompleteBunPinBatch: () => ({ success: true }),
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

	test('the commit boundary rejects incomplete Bun pin batches before consuming authority', async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-bun-complete-batch-'));
		const run = args => spawnSync('git', args, { cwd: root, encoding: 'utf8' });
		try {
			expect(run(['init']).status).toBe(0);
			expect(run(['config', 'user.email', 'forge-test@example.invalid']).status).toBe(0);
			expect(run(['config', 'user.name', 'Forge Test']).status).toBe(0);
			fs.writeFileSync(path.join(root, 'package.json'), '{"name":"forge-workflow","packageManager":"bun@1.3.12"}');
			for (const spec of BUN_WORKFLOW_SPECS) {
				const fullPath = path.join(root, spec.path);
				fs.mkdirSync(path.dirname(fullPath), { recursive: true });
				fs.writeFileSync(fullPath, fixtureContent(spec));
			}
			const npmPath = path.join(root, NPM_PUBLISH_WORKFLOW_PATH);
			fs.writeFileSync(npmPath, renderNpmPublishWorkflow('1.3.12'));
			expect(run(['add', '.']).status).toBe(0);
			expect(run(['commit', '-m', 'base']).status).toBe(0);
			const sourceHead = run(['rev-parse', 'HEAD']).stdout.trim();

			fs.writeFileSync(path.join(root, 'package.json'), '{"name":"forge-workflow","packageManager":"bun@1.4.2"}');
			expect(run(['add', 'package.json']).status).toBe(0);
			let kernelReads = 0;
			const blocked = await protectedStateAuthority.authorizeAndConsumeProtectedStateWrites(root, [{
				actor: 'bun-pin-test',
				path: BUN_WORKFLOW_SPECS[0].path,
				surface: 'workflows',
				content: Buffer.from(fixtureContent(BUN_WORKFLOW_SPECS[0], '1.4.2')),
				sourceHead,
			}], {
				deps: {
					kernelBroker: { config: {} },
					kernelDriver: { listKernelEvents: async () => { kernelReads += 1; return []; } },
				},
			});
			expect(blocked).toMatchObject({ success: false });
			expect(blocked.batchDecision.reason).toContain(BUN_WORKFLOW_SPECS[0].path);
			expect(kernelReads).toBe(0);

			const hook = spawnSync(process.execPath, [path.join(repoRoot, 'scripts', 'protected-state-check.js')], {
				cwd: root,
				encoding: 'utf8',
				env: { ...process.env, FORGE_PROTECTED_STATE_ACTOR: 'bun-pin-test' },
			});
			expect(hook.status).toBe(1);
			expect(`${hook.stdout}${hook.stderr}`).toContain('complete generated workflow set');

			for (const spec of BUN_WORKFLOW_SPECS) {
				fs.writeFileSync(path.join(root, spec.path), fixtureContent(spec, '1.4.2'));
			}
			expect(run(['add', ...BUN_WORKFLOW_SPECS.map(spec => spec.path)]).status).toBe(0);
			const withoutNpm = await protectedStateAuthority.authorizeAndConsumeProtectedStateWrites(root, []);
			expect(withoutNpm).toMatchObject({ success: false });
			expect(withoutNpm.batchDecision.reason).toContain(NPM_PUBLISH_WORKFLOW_PATH);

			fs.writeFileSync(npmPath, renderNpmPublishWorkflow('1.4.2'));
			expect(run(['add', NPM_PUBLISH_WORKFLOW_PATH]).status).toBe(0);
			expect(await protectedStateAuthority.authorizeAndConsumeProtectedStateWrites(root, []))
				.toEqual({ success: true, decisions: [] });

			const workflowPath = BUN_WORKFLOW_SPECS[0].path;
			const content = Buffer.from(fixtureContent(BUN_WORKFLOW_SPECS[0], '1.4.2'));
			const worktreeScope = 'complete-batch-race-scope';
			const capabilityId = 'complete-batch-race-capability';
			const event = (eventType, operation) => ({
				entity_type: 'protected_state',
				entity_id: protectedStateAuthority.authorizationEntityId(worktreeScope, workflowPath),
				event_type: eventType,
				actor: 'bun-pin-test',
				origin: 'cli',
				payload_json: JSON.stringify({
					version: 1,
					capabilityId,
					actor: 'bun-pin-test',
					path: workflowPath,
					surface: 'workflows',
					contentHash: hashProtectedContent(content),
					sourceHead,
					worktreeScope,
					writeIntent: 'update',
					targetBunVersion: '1.4.2',
					operation,
					viaForgeApi: true,
					sourceCommand: 'forge release update-bun-pins',
				}),
			});
			let consumed = 0;
			const raced = await protectedStateAuthority.authorizeAndConsumeProtectedStateWrites(root, [{
				actor: 'bun-pin-test',
				path: workflowPath,
				surface: 'workflows',
				content,
				sourceHead,
			}], {
				worktreeScope,
				deps: {
					kernelBroker: { config: {} },
					kernelDriver: {
						listKernelEvents: async () => {
							fs.writeFileSync(path.join(root, workflowPath), fixtureContent(BUN_WORKFLOW_SPECS[0]));
							expect(run(['add', workflowPath]).status).toBe(0);
							return [
								event(protectedStateAuthority.PROTECTED_STATE_AUTHORIZATION_ISSUED, 'update_bun_workflow_pin'),
								event(protectedStateAuthority.PROTECTED_STATE_WRITE_COMPLETED, 'update_bun_workflow_pin_completed'),
							];
						},
						insertKernelEvent: async () => { consumed += 1; },
					},
				},
			});
			expect(raced).toMatchObject({ success: false });
			expect(raced.batchDecision.reason).toContain(workflowPath);
			expect(consumed).toBe(0);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	}, 30_000);

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
