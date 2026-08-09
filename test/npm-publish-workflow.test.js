'use strict';

const { describe, expect, test } = require('bun:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const releaseCommand = require('../lib/commands/release');
const {
	NPM_PUBLISH_WORKFLOW_PATH,
	generateNpmPublishWorkflow,
	renderNpmDistTagResolverScript,
	renderNpmPublishWorkflow,
} = require('../lib/npm-publish-workflow');
const {
	PROTECTED_STATE_AUDIT_LOG,
} = require('../lib/protected-state-surfaces');
const protectedStateAuthority = require('../lib/protected-state-authority');
const {
	createReleaseSuiteReceipt,
	verifyReleaseSuiteReceipt,
} = require('../scripts/npm-release-receipt');

const repoRoot = path.resolve(__dirname, '..');
const bashExecutable = process.platform === 'win32'
	? path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Git', 'bin', 'bash.exe')
	: 'bash';

function normalizeNewlines(content) {
	return content.replace(/\r\n/g, '\n');
}

function jobSection(workflow, name) {
	const match = workflow.match(new RegExp(`\\n  ${name}:\\n([\\s\\S]*?)(?=\\n  [A-Za-z0-9_-]+:|$)`));
	return match?.[1] || '';
}

describe('Forge-owned npm publish workflow', () => {
	test('resolves beta, RC, and stable versions to distinct npm dist-tags', () => {
		const script = renderNpmDistTagResolverScript();
		const resolve = version => {
			const output = path.join(os.tmpdir(), `forge-npm-dist-tag-${process.pid}-${Date.now()}`);
			try {
				const result = spawnSync(bashExecutable, ['-c', script], {
					encoding: 'utf8',
					env: { ...process.env, VERSION: version, GITHUB_OUTPUT: output },
				});
				return {
					...result,
					output: fs.existsSync(output) ? fs.readFileSync(output, 'utf8') : '',
				};
			} finally {
				fs.rmSync(output, { force: true });
			}
		};

		expect(resolve('0.1.0-beta.5')).toMatchObject({ status: 0, output: 'tag=beta\n' });
		expect(resolve('0.1.0-beta')).toMatchObject({ status: 0, output: 'tag=beta\n' });
		expect(resolve('0.1.0-rc.1')).toMatchObject({ status: 0, output: 'tag=rc\n' });
		expect(resolve('0.1.0-rc')).toMatchObject({ status: 0, output: 'tag=rc\n' });
		expect(resolve('0.1.0')).toMatchObject({ status: 0, output: 'tag=latest\n' });
	});

	test('fails closed for unsupported prerelease identifiers', () => {
		const output = path.join(os.tmpdir(), `forge-npm-dist-tag-deny-${process.pid}-${Date.now()}`);
		try {
			const result = spawnSync(bashExecutable, ['-c', renderNpmDistTagResolverScript()], {
				encoding: 'utf8',
				env: { ...process.env, VERSION: '0.1.0-alpha.1', GITHUB_OUTPUT: output },
			});
			expect(result.status).toBe(1);
			expect(`${result.stdout}${result.stderr}`).toContain('Unsupported npm prerelease');
			expect(fs.existsSync(output)).toBe(false);
		} finally {
			fs.rmSync(output, { force: true });
		}
	});

	test('the checked-in workflow is exactly the deterministic generator output', () => {
		const generated = renderNpmPublishWorkflow();
		const checkedIn = fs.readFileSync(path.join(repoRoot, NPM_PUBLISH_WORKFLOW_PATH), 'utf8');

		expect(renderNpmPublishWorkflow()).toBe(generated);
		expect(normalizeNewlines(checkedIn)).toBe(generated);
	});

	test('resolves one tag SHA and pins the complete suite and publish to it', () => {
		const workflow = renderNpmPublishWorkflow();
		const resolveJob = jobSection(workflow, 'resolve-release');
		const buildJob = jobSection(workflow, 'build');
		const publishJob = jobSection(workflow, 'publish-npm');

		expect(workflow).toContain('types: [published]');
		expect(workflow).not.toContain('types: [created]');
		expect(resolveJob).toContain('ref: ${{ github.event.release.tag_name }}');
		expect(resolveJob).toContain('persist-credentials: false');
		expect(resolveJob).toContain('git rev-parse "${RELEASE_TAG}^{commit}"');
		expect(buildJob).toContain('ref: ${{ needs.resolve-release.outputs.commitSha }}');
		expect(buildJob).toContain('persist-credentials: false');
		expect(buildJob).toContain('node scripts/test-full-suite.js --label-prefix release-full');
		expect(buildJob).toContain('bash test-env/automation/setup-fixtures.sh --force');
		expect(buildJob.match(/node scripts\/test-full-suite\.js --label-prefix release-full/g)).toHaveLength(1);
		expect(buildJob).not.toContain('bun test --timeout 15000 test-env/');
		expect(publishJob).toContain('ref: ${{ needs.resolve-release.outputs.commitSha }}');
		expect(publishJob).toContain('persist-credentials: false');
	});

	test('publishing requires the attributable exact-suite receipt and checkout SHA', () => {
		const workflow = renderNpmPublishWorkflow();
		const buildJob = jobSection(workflow, 'build');
		const publishJob = jobSection(workflow, 'publish-npm');

		expect(buildJob).toContain('receipt: ${{ steps.evidence.outputs.receipt }}');
		expect(buildJob).toContain('node scripts/npm-release-receipt.js emit');
		expect(publishJob.indexOf('actions/setup-node@v7')).toBeLessThan(
			publishJob.indexOf('node scripts/npm-release-receipt.js verify'),
		);
		expect(publishJob).toContain('node scripts/npm-release-receipt.js verify');
	});

	test('executable receipt guard denies missing fields and every SHA mismatch', () => {
		const attribution = {
			repository: 'owner/forge',
			workflowRef: 'owner/forge/.github/workflows/npm-publish.yml@refs/tags/v0.1.0-beta.5',
			runId: '1234',
			runAttempt: '1',
		};
		const sha = 'a'.repeat(40);
		const otherSha = 'b'.repeat(40);
		const evidence = createReleaseSuiteReceipt({ ...attribution, sha });
		const valid = {
			...attribution,
			expectedSha: sha,
			verifiedSha: sha,
			checkoutSha: sha,
			receipt: evidence.receipt,
			receiptSubject: evidence.receiptSubject,
		};

		expect(verifyReleaseSuiteReceipt(valid)).toMatchObject({ allowed: true });
		for (const field of ['expectedSha', 'verifiedSha', 'checkoutSha', 'receipt', 'receiptSubject']) {
			expect(verifyReleaseSuiteReceipt({ ...valid, [field]: '' })).toMatchObject({
				allowed: false,
				reason: `missing:${field}`,
			});
		}
		expect(verifyReleaseSuiteReceipt({ ...valid, verifiedSha: otherSha })).toMatchObject({
			allowed: false,
			reason: 'sha_mismatch',
		});
		expect(verifyReleaseSuiteReceipt({ ...valid, checkoutSha: otherSha })).toMatchObject({
			allowed: false,
			reason: 'sha_mismatch',
		});

		const wrongShaEvidence = createReleaseSuiteReceipt({ ...attribution, sha: otherSha });
		expect(verifyReleaseSuiteReceipt({
			...valid,
			receipt: wrongShaEvidence.receipt,
			receiptSubject: wrongShaEvidence.receiptSubject,
		})).toMatchObject({ allowed: false, reason: 'receipt_mismatch' });
		expect(verifyReleaseSuiteReceipt({
			...valid,
			receiptSubject: wrongShaEvidence.receiptSubject,
		})).toMatchObject({ allowed: false, reason: 'receipt_mismatch' });
	});

	test('preserves release guards, OIDC provenance, and explicit prerelease dist-tags', () => {
		const workflow = renderNpmPublishWorkflow();
		const publishJob = jobSection(workflow, 'publish-npm');

		expect(publishJob).toContain('id-token: write');
		expect(publishJob).toContain('Release tag matches package.json version');
		expect(publishJob).toContain("version.split('-')[0]");
		expect(publishJob).toContain('npm pack --dry-run');
		expect(publishJob).toContain('npm publish --provenance --tag beta');
		expect(publishJob).toContain('npm publish --provenance --tag rc');
		expect(publishJob).toContain('npm publish --provenance');
		expect(publishJob).toContain('tag=latest');
		expect(publishJob).toContain('npm install --global npm@11.5.1 && npm --version');
		expect(publishJob).not.toContain('npm@latest');
	});

	test('release generator writes through the protected API and records content-bound evidence', async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-npm-workflow-'));
		try {
			expect(spawnSync('git', ['init'], { cwd: root }).status).toBe(0);
			const result = await releaseCommand.handler(
				['generate-npm-workflow'],
				{},
				root,
				{ env: { FORGE_ACTOR: 'release-test' } },
			);

			expect(result.success).toBe(true);
			expect(fs.readFileSync(path.join(root, NPM_PUBLISH_WORKFLOW_PATH), 'utf8')).toBe(
				renderNpmPublishWorkflow(),
			);

			const records = fs
				.readFileSync(path.join(root, PROTECTED_STATE_AUDIT_LOG), 'utf8')
				.trim()
				.split('\n')
				.map(line => JSON.parse(line));
			expect(records.at(-1)).toMatchObject({
				actor: 'release-test',
				path: NPM_PUBLISH_WORKFLOW_PATH,
				requiredSurface: 'workflows',
				decision: 'allowed',
			});
			expect(records.at(-1).contentHash).toMatch(/^sha256:[a-f0-9]{64}$/);
			expect(result.generated.trustedAuthorization.capabilityId).toBeTruthy();
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	test('does not publish authorization when the protected write fails', async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-npm-write-failure-'));
		let auditCalls = 0;
		try {
			const result = await generateNpmPublishWorkflow(root, {
				actor: 'release-test',
				writeProtectedFile: () => ({
					allowed: false,
					decision: 'blocked',
					reason: 'injected write failure',
				}),
				recordProtectedStateAuditEvent: () => {
					auditCalls += 1;
					return { success: true };
				},
			});

			expect(result).toMatchObject({ success: false, error: 'injected write failure' });
			expect(auditCalls).toBe(0);
			expect(fs.existsSync(path.join(root, PROTECTED_STATE_AUDIT_LOG))).toBe(false);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	test('restores previous workflow bytes when authorization audit persistence fails', async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-npm-audit-failure-'));
		const workflowPath = path.join(root, NPM_PUBLISH_WORKFLOW_PATH);
		const previous = Buffer.from('previous workflow bytes\r\n', 'utf8');
		try {
			fs.mkdirSync(path.dirname(workflowPath), { recursive: true });
			fs.writeFileSync(workflowPath, previous);
			const result = await generateNpmPublishWorkflow(root, {
				actor: 'release-test',
				recordProtectedStateAuditEvent: () => ({
					success: false,
					error: 'audit sink unavailable',
				}),
			});

			expect(result).toMatchObject({
				success: false,
				error: 'Could not record protected-state authorization: audit sink unavailable',
			});
			expect(fs.readFileSync(workflowPath)).toEqual(previous);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	test('removes a newly created workflow when authorization audit persistence throws', async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-npm-audit-throw-'));
		const workflowPath = path.join(root, NPM_PUBLISH_WORKFLOW_PATH);
		try {
			const result = await generateNpmPublishWorkflow(root, {
				actor: 'release-test',
				recordProtectedStateAuditEvent: () => {
					throw new Error('audit sink exploded');
				},
			});

			expect(result).toMatchObject({
				success: false,
				error: 'Could not record protected-state authorization: audit sink exploded',
			});
			expect(fs.existsSync(workflowPath)).toBe(false);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	test('real capped audit failure cannot leave a reusable authorization behind', async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-npm-capped-audit-'));
		const workflowPath = path.join(root, NPM_PUBLISH_WORKFLOW_PATH);
		const auditPath = path.join(root, PROTECTED_STATE_AUDIT_LOG);
		const previous = Buffer.from('previous workflow\n', 'utf8');
		const realWriteFileSync = fs.writeFileSync;
		try {
			fs.mkdirSync(path.dirname(workflowPath), { recursive: true });
			fs.mkdirSync(path.dirname(auditPath), { recursive: true });
			fs.writeFileSync(workflowPath, previous);
			const seeded = Array.from({ length: 500 }, (_, index) => JSON.stringify({
				kind: 'protected_state_write',
				decision: 'blocked',
				seq: index,
			}));
			fs.writeFileSync(auditPath, `${seeded.join('\n')}\n`, 'utf8');
			fs.writeFileSync = (target, ...args) => {
				if (String(target).startsWith(`${auditPath}.`) && String(target).endsWith('.tmp')) {
					const error = new Error('forced audit temp failure');
					error.code = 'ENOSPC';
					throw error;
				}
				return realWriteFileSync(target, ...args);
			};

			const result = await generateNpmPublishWorkflow(root, { actor: 'release-test' });
			expect(result).toMatchObject({
				success: false,
				error: 'Could not record protected-state authorization: forced audit temp failure',
			});
			expect(fs.readFileSync(workflowPath)).toEqual(previous);
			const records = fs.readFileSync(auditPath, 'utf8').trim().split('\n').map(line => JSON.parse(line));
			expect(records).toHaveLength(500);
			expect(records.every(record => record.capabilityId === undefined)).toBe(true);
		} finally {
			fs.writeFileSync = realWriteFileSync;
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	test('restores previous workflow bytes when trusted authorization persistence fails', async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-npm-authority-failure-'));
		const workflowPath = path.join(root, NPM_PUBLISH_WORKFLOW_PATH);
		const previous = Buffer.from('previous trusted workflow bytes\n', 'utf8');
		try {
			fs.mkdirSync(path.dirname(workflowPath), { recursive: true });
			fs.writeFileSync(workflowPath, previous);
			const result = await generateNpmPublishWorkflow(root, {
				actor: 'release-test',
				issueNpmPublishWorkflowAuthorization: async () => ({
					success: false,
					error: 'kernel authority unavailable',
				}),
			});

			expect(result).toMatchObject({
				success: false,
				error: 'Could not record trusted protected-state authorization: kernel authority unavailable',
			});
			expect(fs.readFileSync(workflowPath)).toEqual(previous);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	test('hook accepts exact generator evidence but denies raw edits and missing evidence', async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-npm-hook-'));
		const actor = 'release-hook-test';
		const checker = path.join(repoRoot, 'scripts', 'protected-state-check.js');
		const run = (command, args) => spawnSync(command, args, { cwd: root, encoding: 'utf8' });
		const check = () => spawnSync(process.execPath, [checker], {
			cwd: root,
			encoding: 'utf8',
			env: { ...process.env, FORGE_PROTECTED_STATE_ACTOR: actor },
		});
		try {
			expect(run('git', ['init']).status).toBe(0);
			expect((await releaseCommand.handler(
				['generate-npm-workflow'],
				{},
				root,
				{ env: { FORGE_ACTOR: actor } },
			)).success).toBe(true);
			expect(run('git', ['add', NPM_PUBLISH_WORKFLOW_PATH]).status).toBe(0);
			const wrongActor = spawnSync(process.execPath, [checker], {
				cwd: root,
				encoding: 'utf8',
				env: { ...process.env, FORGE_PROTECTED_STATE_ACTOR: `${actor}-other` },
			});
			expect(wrongActor.status).toBe(1);
			expect(`${wrongActor.stdout}${wrongActor.stderr}`).toContain('content-bound authorization');
			expect(check().status).toBe(0);

			expect((await releaseCommand.handler(
				['generate-npm-workflow'],
				{},
				root,
				{ env: { FORGE_ACTOR: actor } },
			)).success).toBe(true);
			fs.appendFileSync(path.join(root, NPM_PUBLISH_WORKFLOW_PATH), '# raw edit\n');
			expect(run('git', ['add', NPM_PUBLISH_WORKFLOW_PATH]).status).toBe(0);
			const rawEdit = check();
			expect(rawEdit.status).toBe(1);
			expect(`${rawEdit.stdout}${rawEdit.stderr}`).toContain('content-bound authorization');

			fs.rmSync(path.join(root, '.git', 'forge'), { recursive: true, force: true });
			const missingEvidence = check();
			expect(missingEvidence.status).toBe(1);
			expect(`${missingEvidence.stdout}${missingEvidence.stderr}`).toContain('Forge-owned authorization');
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	}, 30_000);

	test('hook denies a fabricated audit record in a real temporary repository', () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-npm-fabricated-audit-'));
		const actor = 'fabricated-release-actor';
		const checker = path.join(repoRoot, 'scripts', 'protected-state-check.js');
		const workflow = renderNpmPublishWorkflow();
		const workflowPath = path.join(root, NPM_PUBLISH_WORKFLOW_PATH);
		const auditPath = path.join(root, PROTECTED_STATE_AUDIT_LOG);
		const run = (command, args) => spawnSync(command, args, { cwd: root, encoding: 'utf8' });
		try {
			expect(run('git', ['init']).status).toBe(0);
			fs.mkdirSync(path.dirname(workflowPath), { recursive: true });
			fs.writeFileSync(workflowPath, workflow, 'utf8');
			fs.mkdirSync(path.dirname(auditPath), { recursive: true });
			fs.writeFileSync(auditPath, `${JSON.stringify({
				kind: 'protected_state_write',
				actor,
				path: NPM_PUBLISH_WORKFLOW_PATH,
				decision: 'allowed',
				requiredSurface: 'workflows',
				declaredSurface: 'workflows',
				operation: 'generate_npm_workflow',
				contentHash: `sha256:${require('node:crypto').createHash('sha256').update(workflow).digest('hex')}`,
				viaForgeApi: true,
			})}\n`, 'utf8');
			expect(run('git', ['add', NPM_PUBLISH_WORKFLOW_PATH]).status).toBe(0);

			const result = spawnSync(process.execPath, [checker], {
				cwd: root,
				encoding: 'utf8',
				env: { ...process.env, FORGE_PROTECTED_STATE_ACTOR: actor },
			});

			expect(result.status).toBe(1);
			expect(`${result.stdout}${result.stderr}`).toContain('Forge-owned authorization');
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	}, 15_000);

	test('generic library callers cannot mint authority for arbitrary workflow bytes', async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-npm-generic-issuer-'));
		const actor = 'spoofed-release-actor';
		const checker = path.join(repoRoot, 'scripts', 'protected-state-check.js');
		const arbitraryContent = 'name: attacker-controlled workflow\non: push\n';
		const workflowPath = path.join(root, NPM_PUBLISH_WORKFLOW_PATH);
		const run = (command, args) => spawnSync(command, args, { cwd: root, encoding: 'utf8' });
		try {
			expect(run('git', ['init']).status).toBe(0);
			expect(protectedStateAuthority.issueProtectedStateAuthorization).toBeUndefined();
			const authorization = await protectedStateAuthority.issueNpmPublishWorkflowAuthorization(root, { actor });
			expect(authorization.success).toBe(true);
			fs.mkdirSync(path.dirname(workflowPath), { recursive: true });
			fs.writeFileSync(workflowPath, arbitraryContent, 'utf8');
			expect(run('git', ['add', NPM_PUBLISH_WORKFLOW_PATH]).status).toBe(0);

			const result = spawnSync(process.execPath, [checker], {
				cwd: root,
				encoding: 'utf8',
				env: { ...process.env, FORGE_PROTECTED_STATE_ACTOR: actor },
			});

			expect(result.status).toBe(1);
			expect(`${result.stdout}${result.stderr}`).toContain('content-bound authorization');
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	}, 30_000);

	test('hook consumes authorization and denies a later same-content stale replay', async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-npm-same-content-replay-'));
		const actor = 'release-replay-test';
		const checker = path.join(repoRoot, 'scripts', 'protected-state-check.js');
		const workflowPath = path.join(root, NPM_PUBLISH_WORKFLOW_PATH);
		const run = (command, args) => spawnSync(command, args, { cwd: root, encoding: 'utf8' });
		const check = () => spawnSync(process.execPath, [checker], {
			cwd: root,
			encoding: 'utf8',
			env: { ...process.env, FORGE_PROTECTED_STATE_ACTOR: actor },
		});
		try {
			expect(run('git', ['init']).status).toBe(0);
			expect(run('git', ['config', 'user.email', 'forge-test@example.invalid']).status).toBe(0);
			expect(run('git', ['config', 'user.name', 'Forge Test']).status).toBe(0);
			expect((await releaseCommand.handler(
				['generate-npm-workflow'],
				{},
				root,
				{ env: { FORGE_ACTOR: actor } },
			)).success).toBe(true);
			expect(run('git', ['add', NPM_PUBLISH_WORKFLOW_PATH]).status).toBe(0);
			expect(check().status).toBe(0);
			expect(run('git', ['commit', '-m', 'generated workflow']).status).toBe(0);

			fs.writeFileSync(workflowPath, 'name: intermediate raw workflow\n', 'utf8');
			expect(run('git', ['add', NPM_PUBLISH_WORKFLOW_PATH]).status).toBe(0);
			expect(run('git', ['commit', '-m', 'intermediate workflow']).status).toBe(0);
			fs.writeFileSync(workflowPath, renderNpmPublishWorkflow(), 'utf8');
			expect(run('git', ['add', NPM_PUBLISH_WORKFLOW_PATH]).status).toBe(0);

			const replay = check();
			expect(replay.status).toBe(1);
			expect(`${replay.stdout}${replay.stderr}`).toContain('already consumed');
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	}, 30_000);
});
