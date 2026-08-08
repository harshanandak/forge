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
	renderNpmPublishWorkflow,
} = require('../lib/npm-publish-workflow');
const { PROTECTED_STATE_AUDIT_LOG } = require('../lib/protected-state-surfaces');
const {
	createReleaseSuiteReceipt,
	verifyReleaseSuiteReceipt,
} = require('../scripts/npm-release-receipt');

const repoRoot = path.resolve(__dirname, '..');

function normalizeNewlines(content) {
	return content.replace(/\r\n/g, '\n');
}

function jobSection(workflow, name) {
	const match = workflow.match(new RegExp(`\\n  ${name}:\\n([\\s\\S]*?)(?=\\n  [A-Za-z0-9_-]+:|$)`));
	return match?.[1] || '';
}

describe('Forge-owned npm publish workflow', () => {
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

		expect(resolveJob).toContain('ref: ${{ github.event.release.tag_name }}');
		expect(resolveJob).toContain('git rev-parse "${RELEASE_TAG}^{commit}"');
		expect(buildJob).toContain('ref: ${{ needs.resolve-release.outputs.commitSha }}');
		expect(buildJob).toContain('node scripts/test-full-suite.js --label-prefix release-full');
		expect(buildJob).toContain('bash test-env/automation/setup-fixtures.sh --force');
		expect(buildJob.match(/node scripts\/test-full-suite\.js --label-prefix release-full/g)).toHaveLength(1);
		expect(buildJob).not.toContain('bun test --timeout 15000 test-env/');
		expect(publishJob).toContain('ref: ${{ needs.resolve-release.outputs.commitSha }}');
	});

	test('publishing requires the attributable exact-suite receipt and checkout SHA', () => {
		const workflow = renderNpmPublishWorkflow();
		const buildJob = jobSection(workflow, 'build');
		const publishJob = jobSection(workflow, 'publish-npm');

		expect(buildJob).toContain('receipt: ${{ steps.evidence.outputs.receipt }}');
		expect(buildJob).toContain('node scripts/npm-release-receipt.js emit');
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

	test('preserves release guards, OIDC provenance, and beta dist-tag publishing', () => {
		const workflow = renderNpmPublishWorkflow();
		const publishJob = jobSection(workflow, 'publish-npm');

		expect(publishJob).toContain('id-token: write');
		expect(publishJob).toContain('Release tag matches package.json version');
		expect(publishJob).toContain("version.split('-')[0]");
		expect(publishJob).toContain('npm pack --dry-run');
		expect(publishJob).toContain('npm publish --provenance --tag beta');
		expect(publishJob).toContain('npm publish --provenance');
	});

	test('release generator writes through the protected API and records content-bound evidence', async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-npm-workflow-'));
		try {
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
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	test('does not publish authorization when the protected write fails', () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-npm-write-failure-'));
		let auditCalls = 0;
		try {
			const result = generateNpmPublishWorkflow(root, {
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
			expect(check().status).toBe(0);

			fs.appendFileSync(path.join(root, NPM_PUBLISH_WORKFLOW_PATH), '# raw edit\n');
			expect(run('git', ['add', NPM_PUBLISH_WORKFLOW_PATH]).status).toBe(0);
			const rawEdit = check();
			expect(rawEdit.status).toBe(1);
			expect(`${rawEdit.stdout}${rawEdit.stderr}`).toContain('content-bound authorization');

			fs.rmSync(path.join(root, PROTECTED_STATE_AUDIT_LOG));
			const missingEvidence = check();
			expect(missingEvidence.status).toBe(1);
			expect(`${missingEvidence.stdout}${missingEvidence.stderr}`).toContain('content-bound authorization');
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});
});
