'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { secureExecFileSync } = require('./shell-utils');
const {
	createProtectedStateAuditRecord,
	recordProtectedStateAuditEvent,
	removeProtectedFile,
	writeProtectedFile,
} = require('./protected-state-surfaces');
const {
	issueTestWorkflowAuthorization,
	completeTestWorkflowAuthorization,
} = require('./protected-state-authority');
const {
	readIndexedPackageManifest,
	readPinnedBunVersion,
	readSourcePackageManifest,
	resolveCurrentHead,
} = require('./bun-workflow-pins');
const { verifyExpectedHead } = require('./npm-publish-workflow');

const TEST_WORKFLOW_PATH = '.github/workflows/test.yml';
const TEST_WORKFLOW_TEMPLATE_PATH = 'lib/workflow-templates/test.yml';
const BUN_VERSION_TOKEN = '{{BUN_VERSION}}';
const BUN_VERSION_TOKEN_COUNT = 8;

function renderTestWorkflow(template, bunVersion) {
	if (!/^\d+\.\d+\.\d+$/.test(bunVersion)) {
		throw new Error('Test workflow requires an exact stable Bun version.');
	}
	const source = Buffer.from(template).toString('utf8');
	const count = source.split(BUN_VERSION_TOKEN).length - 1;
	if (count !== BUN_VERSION_TOKEN_COUNT) {
		throw new Error(`Test workflow template must contain exactly ${BUN_VERSION_TOKEN_COUNT} ${BUN_VERSION_TOKEN} tokens; found ${count}.`);
	}
	return Buffer.from(source.replaceAll(BUN_VERSION_TOKEN, bunVersion));
}

function readGitFile(projectRoot, revision, filePath, execGit = secureExecFileSync) {
	const indexed = revision === ':';
	const options = {
		cwd: projectRoot,
		encoding: 'utf8',
		stdio: ['ignore', 'pipe', 'pipe'],
		windowsHide: true,
	};
	const entry = execGit('git', indexed
		? ['ls-files', '--stage', '--', filePath]
		: ['ls-tree', revision, '--', filePath], options).trim();
	const suffix = filePath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	const expected = indexed
		? new RegExp(`^100(?:644|755) [0-9a-f]+ 0\\t${suffix}$`)
		: new RegExp(`^100(?:644|755) blob [0-9a-f]+\\t${suffix}$`);
	if (!expected.test(entry)) {
		throw new Error(`${filePath} is not one regular file ${indexed ? 'in the Git index' : `at ${revision}`}.`);
	}
	return Buffer.from(execGit('git', ['show', `${revision}${indexed ? '' : ':'}${filePath}`], {
		...options,
		encoding: 'buffer',
	}));
}

function readRegularFile(projectRoot, filePath) {
	const fullPath = path.join(projectRoot, filePath);
	const stat = fs.lstatSync(fullPath);
	if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${filePath} must be a regular file.`);
	return fs.readFileSync(fullPath);
}

function snapshotWorkflow(projectRoot) {
	const fullPath = path.join(projectRoot, TEST_WORKFLOW_PATH);
	try {
		const stat = fs.lstatSync(fullPath);
		if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${TEST_WORKFLOW_PATH} must be a regular file.`);
		return { existed: true, content: fs.readFileSync(fullPath) };
	} catch (error) {
		if (error.code === 'ENOENT') return { existed: false, content: null };
		throw error;
	}
}

function sameSnapshot(left, right) {
	return left?.existed === right?.existed
		&& (!left?.existed || (Buffer.isBuffer(left.content) && left.content.equals(right.content)));
}

function resolveTestWorkflowUpdate(projectRoot, sourceHead, options = {}) {
	const currentHead = (options.resolveHead || resolveCurrentHead)(projectRoot, options.execGit);
	if (currentHead !== sourceHead) {
		throw new Error(`Protected test workflow source HEAD changed from ${sourceHead} to ${currentHead}.`);
	}

	const sourcePackage = Buffer.from((options.readSourcePackageManifest || readSourcePackageManifest)(
		projectRoot,
		sourceHead,
		options.execGit,
	));
	const indexedPackage = Buffer.from((options.readIndexedPackageManifest || readIndexedPackageManifest)(
		projectRoot,
		options.execGit,
	));
	const workingPackage = readRegularFile(projectRoot, 'package.json');
	if (!workingPackage.equals(indexedPackage)) {
		throw new Error('package.json differs from the Git index; stage the intended manifest before generating test.yml.');
	}

	const sourceTemplate = Buffer.from((options.readSourceTemplate || readGitFile)(
		projectRoot,
		sourceHead,
		TEST_WORKFLOW_TEMPLATE_PATH,
		options.execGit,
	));
	const indexedTemplate = Buffer.from((options.readIndexedTemplate || readGitFile)(
		projectRoot,
		':',
		TEST_WORKFLOW_TEMPLATE_PATH,
		options.execGit,
	));
	const workingTemplate = readRegularFile(projectRoot, TEST_WORKFLOW_TEMPLATE_PATH);
	if (!workingTemplate.equals(indexedTemplate)) {
		throw new Error(`${TEST_WORKFLOW_TEMPLATE_PATH} differs from the Git index; stage the intended template before generating test.yml.`);
	}

	const sourceWorkflow = Buffer.from((options.readSourceWorkflow || readGitFile)(
		projectRoot,
		sourceHead,
		TEST_WORKFLOW_PATH,
		options.execGit,
	));
	const sourceVersion = readPinnedBunVersion(sourcePackage);
	const baseline = renderTestWorkflow(sourceTemplate, sourceVersion);
	if (!sourceWorkflow.equals(baseline)) {
		throw new Error(`${TEST_WORKFLOW_PATH} at ${sourceHead} differs from its canonical template output.`);
	}

	const version = readPinnedBunVersion(indexedPackage);
	const content = renderTestWorkflow(indexedTemplate, version);
	const snapshot = snapshotWorkflow(projectRoot);
	if (!snapshot.existed || (!snapshot.content.equals(baseline) && !snapshot.content.equals(content))) {
		throw new Error(`${TEST_WORKFLOW_PATH} has unrelated local edits; restore or commit them before generation.`);
	}
	const indexedWorkflow = Buffer.from((options.readIndexedWorkflow || readGitFile)(
		projectRoot,
		':',
		TEST_WORKFLOW_PATH,
		options.execGit,
	));
	if (!indexedWorkflow.equals(baseline) && !indexedWorkflow.equals(content)) {
		throw new Error(`${TEST_WORKFLOW_PATH} has unrelated staged edits; restore or commit them before generation.`);
	}

	return { path: TEST_WORKFLOW_PATH, sourceHead, version, baseline, content, indexedWorkflow, snapshot };
}

function recoverWorkflow(snapshot, projectRoot, generatedContent, protectedWriter, protectedRemover, writeOptions) {
	const recoveryOptions = {
		...writeOptions,
		operation: 'recover_test_workflow',
		expectedContent: generatedContent,
	};
	return snapshot.existed
		? protectedWriter(projectRoot, TEST_WORKFLOW_PATH, snapshot.content, recoveryOptions)
		: protectedRemover(projectRoot, TEST_WORKFLOW_PATH, recoveryOptions);
}

function attemptRecovery(snapshot, projectRoot, generatedContent, protectedWriter, protectedRemover, writeOptions) {
	try {
		return recoverWorkflow(snapshot, projectRoot, generatedContent, protectedWriter, protectedRemover, writeOptions);
	} catch (error) {
		return { allowed: false, reason: error.message };
	}
}

async function generateTestWorkflow(projectRoot, options = {}) {
	const head = verifyExpectedHead(projectRoot, options.expectedHead, options.resolveHead);
	if (!head.success) return head;
	const sourceHead = head.sourceHead;
	if (options.expectedSnapshot && !sameSnapshot(options.expectedSnapshot, snapshotWorkflow(projectRoot))) {
		return { success: false, error: `${TEST_WORKFLOW_PATH} changed after Bun pin batch preflight.` };
	}
	let update;
	try {
		update = resolveTestWorkflowUpdate(projectRoot, sourceHead, options);
	} catch (error) {
		return { success: false, error: error.message };
	}

	const actor = options.actor || options.env?.FORGE_ACTOR || process.env.FORGE_ACTOR || process.env.USER || process.env.USERNAME || 'forge-release';
	const capabilityId = (options.createCapabilityId || randomUUID)();
	const issueAuthorization = options.issueAuthorization || issueTestWorkflowAuthorization;
	const completeAuthorization = options.completeAuthorization || completeTestWorkflowAuthorization;
	const protectedWriter = options.writeProtectedFile || writeProtectedFile;
	const protectedRemover = options.removeProtectedFile || removeProtectedFile;
	const auditWriter = options.recordProtectedStateAuditEvent || recordProtectedStateAuditEvent;
	let authorization;
	try {
		authorization = await issueAuthorization(projectRoot, {
			actor,
			sourceHead,
			targetBunVersion: update.version,
		}, { deps: options.kernelDeps, capabilityId });
	} catch (error) {
		authorization = { success: false, error: error.message };
	}
	if (!authorization.success || authorization.capabilityId !== capabilityId) {
		return { success: false, error: `Could not authorize ${TEST_WORKFLOW_PATH}: ${authorization.error || 'authority returned a different capability id.'}` };
	}

	const writeOptions = {
		actor,
		operation: 'generate_test_workflow',
		viaForgeApi: true,
		surface: 'workflows',
		expectedContent: update.snapshot.content,
		...(options.beforeAtomicCommit ? { beforeAtomicCommit: options.beforeAtomicCommit } : {}),
	};
	let write;
	try {
		write = protectedWriter(projectRoot, TEST_WORKFLOW_PATH, update.content, writeOptions);
	} catch (error) {
		return { success: false, error: error.message };
	}
	if (!write.allowed) return { success: false, error: write.reason, write };

	const audit = (() => {
		try {
			return auditWriter(createProtectedStateAuditRecord({
				actor,
				surface: 'workflows',
				path: TEST_WORKFLOW_PATH,
				content: update.content,
				operation: 'generate_test_workflow',
				viaForgeApi: true,
				sourceHead,
			}), { cwd: projectRoot });
		} catch (error) {
			return { success: false, error: error.message };
		}
	})();
	if (!audit.success) {
		const recovery = attemptRecovery(update.snapshot, projectRoot, update.content, protectedWriter, protectedRemover, writeOptions);
		return { success: false, error: `Could not record ${TEST_WORKFLOW_PATH}: ${audit.error}`, audit, recovery };
	}

	let completion;
	try {
		completion = await completeAuthorization(projectRoot, {
			actor,
			sourceHead,
			capabilityId,
			targetBunVersion: update.version,
		}, { deps: options.kernelDeps });
	} catch (error) {
		completion = { success: false, error: error.message };
	}
	if (!completion.success) {
		const recovery = attemptRecovery(update.snapshot, projectRoot, update.content, protectedWriter, protectedRemover, writeOptions);
		return { success: false, error: `Could not complete ${TEST_WORKFLOW_PATH}: ${completion.error}`, audit, completion, recovery };
	}

	return {
		success: true,
		path: TEST_WORKFLOW_PATH,
		sourceHead,
		bunVersion: update.version,
		contentHash: write.contentHash,
		write,
		audit,
		authorization,
		completion,
	};
}

module.exports = {
	BUN_VERSION_TOKEN,
	TEST_WORKFLOW_PATH,
	TEST_WORKFLOW_TEMPLATE_PATH,
	renderTestWorkflow,
	resolveTestWorkflowUpdate,
	generateTestWorkflow,
};
