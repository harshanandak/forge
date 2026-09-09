'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { secureExecFileSync } = require('./shell-utils');
const {
	createProtectedStateAuditRecord,
	recordProtectedStateAuditEvent,
	removeProtectedFile,
	writeProtectedFile,
} = require('./protected-state-surfaces');

const EXACT_BUN_VERSION = /^\d+\.\d+\.\d+$/;
const BUN_WORKFLOW_SPECS = Object.freeze([
	{ path: '.github/workflows/build-binary.yml', key: 'BUN_VERSION', count: 1 },
	{ path: '.github/workflows/docs-validation.yml', key: 'bun-version', count: 2 },
	{ path: '.github/workflows/eslint.yml', key: 'bun-version', count: 1 },
	{ path: '.github/workflows/pr-monitor.yml', key: 'bun-version', count: 1 },
	{ path: '.github/workflows/required-checks-bypass.yml', key: 'bun-version', count: 1 },
	{ path: '.github/workflows/size-check.yml', key: 'bun-version', count: 1 },
	{ path: '.github/workflows/test.yml', key: 'bun-version', count: 8 },
	{ path: '.github/workflows/yaml-lint.yml', key: 'bun-version', count: 1 },
].map(Object.freeze));

function workflowSpec(workflowPath) {
	return BUN_WORKFLOW_SPECS.find(spec => spec.path === workflowPath) || null;
}

function readPinnedBunVersion(packageContent) {
	let manifest;
	try {
		manifest = JSON.parse(Buffer.from(packageContent).toString('utf8'));
	} catch (error) {
		throw new Error(`Could not parse package.json: ${error.message}`);
	}
	const match = /^bun@(\d+\.\d+\.\d+)$/.exec(manifest.packageManager || '');
	if (!match) throw new Error('package.json packageManager must pin one exact stable Bun version.');
	return match[1];
}

function renderBunWorkflowPin(workflowPath, sourceContent, version) {
	const spec = workflowSpec(workflowPath);
	if (!spec) throw new Error(`${workflowPath} is not an allowlisted Bun workflow.`);
	if (!EXACT_BUN_VERSION.test(version)) throw new Error('Bun workflow pins require an exact stable version.');

	let replacements = 0;
	const source = Buffer.from(sourceContent).toString('utf8');
	const key = spec.key === 'BUN_VERSION' ? 'BUN_VERSION' : 'bun-version';
	const pattern = new RegExp(`^([ \\t]*${key}:[ \\t]*)(?:latest|\\d+\\.\\d+\\.\\d+)([ \\t]*\\r?)$`, 'gm');
	const rendered = source.replace(pattern, (_match, prefix, suffix) => {
		replacements += 1;
		return `${prefix}${version}${suffix}`;
	});
	if (replacements !== spec.count) {
		throw new Error(`${workflowPath} must contain exactly ${spec.count} literal ${key} pin${spec.count === 1 ? '' : 's'}; found ${replacements}.`);
	}
	return Buffer.isBuffer(sourceContent) ? Buffer.from(rendered, 'utf8') : rendered;
}

function readSourceWorkflow(projectRoot, sourceHead, workflowPath, execGit = secureExecFileSync) {
	if (!workflowSpec(workflowPath)) throw new Error(`${workflowPath} is not an allowlisted Bun workflow.`);
	const gitOptions = {
		cwd: projectRoot,
		encoding: 'utf8',
		stdio: ['ignore', 'pipe', 'pipe'],
		windowsHide: true,
	};
	const treeEntry = execGit('git', ['ls-tree', sourceHead, '--', workflowPath], gitOptions).trim();
	if (!/^100(?:644|755) blob [0-9a-f]+\t/.test(treeEntry)) {
		throw new Error(`${workflowPath} is not a regular workflow file at ${sourceHead}.`);
	}
	return Buffer.from(execGit('git', ['show', `${sourceHead}:${workflowPath}`], {
		...gitOptions,
		encoding: 'buffer',
	}));
}

function resolveCurrentHead(projectRoot, execGit = secureExecFileSync) {
	return execGit('git', ['rev-parse', '--verify', 'HEAD^{commit}'], {
		cwd: projectRoot,
		encoding: 'utf8',
		stdio: ['ignore', 'pipe', 'pipe'],
		windowsHide: true,
	}).trim();
}

function readIndexedWorkflow(projectRoot, workflowPath, execGit = secureExecFileSync) {
	if (!workflowSpec(workflowPath)) throw new Error(`${workflowPath} is not an allowlisted Bun workflow.`);
	const options = {
		cwd: projectRoot,
		encoding: 'utf8',
		stdio: ['ignore', 'pipe', 'pipe'],
		windowsHide: true,
	};
	const entry = execGit('git', ['ls-files', '--stage', '--', workflowPath], options).trim();
	if (!/^100(?:644|755) [0-9a-f]+ 0\t/.test(entry)) {
		throw new Error(`${workflowPath} is not one regular file in the Git index.`);
	}
	return Buffer.from(execGit('git', ['show', `:${workflowPath}`], { ...options, encoding: 'buffer' }));
}

function deriveBunWorkflowUpdate(projectRoot, sourceHead, workflowPath, options = {}) {
	const packageContent = fs.readFileSync(path.join(projectRoot, 'package.json'));
	const version = readPinnedBunVersion(packageContent);
	const sourceReader = options.readSourceWorkflow || readSourceWorkflow;
	const baseline = Buffer.from(sourceReader(projectRoot, sourceHead, workflowPath, options.execGit));
	return {
		path: workflowPath,
		version,
		baseline,
		content: Buffer.from(renderBunWorkflowPin(workflowPath, baseline, version)),
	};
}

function readRegularWorkflow(projectRoot, workflowPath) {
	const fullPath = path.join(projectRoot, workflowPath);
	const stat = fs.lstatSync(fullPath);
	if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${workflowPath} must be a regular file.`);
	return fs.readFileSync(fullPath);
}

function snapshotFile(projectRoot, filePath) {
	const fullPath = path.join(projectRoot, filePath);
	try {
		const stat = fs.lstatSync(fullPath);
		if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${filePath} must be a regular file.`);
		return { existed: true, content: fs.readFileSync(fullPath) };
	} catch (error) {
		if (error.code === 'ENOENT') return { existed: false, content: null };
		throw error;
	}
}

function sameSnapshot(left, right) {
	return left.existed === right.existed
		&& (!left.existed || left.content.equals(right.content));
}

function recoverAttempt(update, projectRoot, protectedWriter, protectedRemover) {
	try {
		const current = snapshotFile(projectRoot, update.path);
		if (sameSnapshot(current, update.original)) return { allowed: true, action: 'unchanged' };
		if (!current.existed || !current.content.equals(update.content)) {
			return { allowed: false, reason: 'File changed after the Bun pin write; concurrent content was preserved.' };
		}
		const recoveryOptions = {
			...update.writeOptions,
			operation: update.recoveryOperation,
			expectedContent: update.content,
		};
		return update.original.existed
			? protectedWriter(projectRoot, update.path, update.original.content, recoveryOptions)
			: protectedRemover(projectRoot, update.path, recoveryOptions);
	} catch (error) {
		return { allowed: false, reason: error.message };
	}
}

function recoverAttempts(attempts, projectRoot, protectedWriter, protectedRemover) {
	const files = [...attempts].reverse().map(update => ({
		path: update.path,
		...recoverAttempt(update, projectRoot, protectedWriter, protectedRemover),
	}));
	return { allowed: files.every(file => file.allowed), files };
}

function failedUpdate(error, results, attempts, projectRoot, protectedWriter, protectedRemover, extra = {}) {
	return {
		success: false,
		error,
		results,
		recovery: recoverAttempts(attempts, projectRoot, protectedWriter, protectedRemover),
		...extra,
	};
}

async function applyWorkflowUpdate(projectRoot, update, context) {
	let authorization;
	try {
		authorization = await context.issueAuthorization(projectRoot, {
			actor: context.actor,
			path: update.path,
			sourceHead: context.sourceHead,
		}, { deps: context.kernelDeps });
	} catch (error) {
		authorization = { success: false, error: error.message };
	}
	if (!authorization.success) {
		return { success: false, error: `Could not authorize ${update.path}: ${authorization.error}` };
	}

	const writeOptions = {
		actor: context.actor,
		operation: 'update_bun_workflow_pin',
		viaForgeApi: true,
		surface: 'workflows',
		expectedContent: update.current,
	};
	context.attempts.push({
		...update,
		original: { existed: true, content: update.current },
		writeOptions,
		recoveryOperation: 'recover_bun_workflow_pin',
	});

	let write;
	try {
		write = context.protectedWriter(projectRoot, update.path, update.content, writeOptions);
	} catch (error) {
		return { success: false, error: error.message };
	}
	if (!write.allowed) return { success: false, error: write.reason };

	let audit;
	try {
		audit = context.auditWriter(createProtectedStateAuditRecord({
			actor: context.actor,
			surface: 'workflows',
			path: update.path,
			content: update.content,
			operation: 'update_bun_workflow_pin',
			viaForgeApi: true,
			sourceHead: context.sourceHead,
		}), { cwd: projectRoot });
	} catch (error) {
		audit = { success: false, error: error.message };
	}
	if (!audit.success) return { success: false, error: `Could not record ${update.path}: ${audit.error}` };

	let completion;
	try {
		completion = await context.completeAuthorization(projectRoot, {
			actor: context.actor,
			path: update.path,
			sourceHead: context.sourceHead,
			capabilityId: authorization.capabilityId,
		}, { deps: context.kernelDeps });
	} catch (error) {
		completion = { success: false, error: error.message };
	}
	if (!completion.success) return { success: false, error: `Could not complete ${update.path}: ${completion.error}` };

	return { success: true, result: { path: update.path, write, authorization, completion } };
}

async function updateBunWorkflowPins(projectRoot, options = {}) {
	const npmWorkflow = require('./npm-publish-workflow');
	const { verifyExpectedHead } = npmWorkflow;
	const head = verifyExpectedHead(projectRoot, options.expectedHead, options.resolveHead);
	if (!head.success) return head;
	const sourceHead = head.sourceHead;
	const actor = options.actor || options.env?.FORGE_ACTOR || process.env.FORGE_ACTOR || process.env.USER || process.env.USERNAME || 'forge-release';

	let updates;
	let npmUpdate;
	try {
		updates = BUN_WORKFLOW_SPECS.map(spec => {
			const update = deriveBunWorkflowUpdate(projectRoot, sourceHead, spec.path, options);
			const current = readRegularWorkflow(projectRoot, spec.path);
			const indexReader = options.readIndexedWorkflow || readIndexedWorkflow;
			const indexed = Buffer.from(indexReader(projectRoot, spec.path, options.execGit));
			if (!current.equals(update.baseline) && !current.equals(update.content)) {
				throw new Error(`${spec.path} has unrelated local edits; restore or commit them before updating Bun pins.`);
			}
			if (!indexed.equals(update.baseline) && !indexed.equals(update.content)) {
				throw new Error(`${spec.path} has unrelated staged edits; restore or commit them before updating Bun pins.`);
			}
			return { ...update, current, indexed };
		});
		const npmPath = npmWorkflow.NPM_PUBLISH_WORKFLOW_PATH;
		npmUpdate = {
			path: npmPath,
			original: snapshotFile(projectRoot, npmPath),
			content: Buffer.from(npmWorkflow.renderNpmPublishWorkflow(updates[0].version)),
			writeOptions: {
				actor,
				operation: 'generate_npm_workflow',
				viaForgeApi: true,
				surface: 'workflows',
			},
			recoveryOperation: 'recover_npm_workflow',
		};
	} catch (error) {
		return { success: false, error: error.message };
	}

	const authority = require('./protected-state-authority');
	const issueAuthorization = options.issueAuthorization || authority.issueBunWorkflowAuthorization;
	const completeAuthorization = options.completeAuthorization || authority.completeBunWorkflowAuthorization;
	const protectedWriter = options.writeProtectedFile || writeProtectedFile;
	const protectedRemover = options.removeProtectedFile || removeProtectedFile;
	const auditWriter = options.recordProtectedStateAuditEvent || recordProtectedStateAuditEvent;
	const results = [];
	const attempts = [];
	const context = {
		actor,
		sourceHead,
		kernelDeps: options.kernelDeps,
		issueAuthorization,
		completeAuthorization,
		protectedWriter,
		auditWriter,
		attempts,
	};
	for (const update of updates) {
		const applied = await applyWorkflowUpdate(projectRoot, update, context);
		if (!applied.success) {
			return failedUpdate(applied.error, results, attempts, projectRoot, protectedWriter, protectedRemover);
		}
		results.push(applied.result);
	}

	const npmGenerator = options.generateNpmPublishWorkflow || npmWorkflow.generateNpmPublishWorkflow;
	attempts.push(npmUpdate);
	let npm;
	try {
		npm = await npmGenerator(projectRoot, {
			actor,
			env: options.env,
			kernelDeps: options.kernelDeps,
			expectedHead: sourceHead,
			resolveHead: options.resolveHead,
			bunVersion: updates[0].version,
		});
	} catch (error) {
		return failedUpdate(error.message, results, attempts, projectRoot, protectedWriter, protectedRemover);
	}
	if (!npm.success) {
		return failedUpdate(npm.error, results, attempts, projectRoot, protectedWriter, protectedRemover, { npm });
	}

	return {
		success: true,
		version: updates[0].version,
		paths: [...results.map(result => result.path), npm.path],
		results,
		npm,
	};
}

module.exports = {
	BUN_WORKFLOW_SPECS,
	readPinnedBunVersion,
	renderBunWorkflowPin,
	readSourceWorkflow,
	readIndexedWorkflow,
	resolveCurrentHead,
	deriveBunWorkflowUpdate,
	updateBunWorkflowPins,
};
