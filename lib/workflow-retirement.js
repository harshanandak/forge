'use strict';

// Forge-owned writer that retires (deletes) GitHub workflow files. It reuses the
// protected-state capability lifecycle: issue a delete-only authorization bound to
// the exact HEAD bytes, remove the file, audit, then record completion. The
// pre-commit hook consumes that capability only for the matching staged deletion.

const { randomUUID } = require('node:crypto');
const YAML = require('yaml');
const { secureExecFileSync } = require('./shell-utils');
const {
	createProtectedStateAuditRecord,
	normalizeRepoPath,
	recordProtectedStateAuditEvent,
	removeProtectedFile,
	writeProtectedFile,
} = require('./protected-state-surfaces');
const {
	completeWorkflowRetirementAuthorization,
	isRetirableWorkflowPath,
	issueWorkflowRetirementAuthorization,
} = require('./protected-state-authority');

const WORKFLOWS_DIR = '.github/workflows';
const WORKFLOW_FILE = /\.ya?ml$/;

function gitOptions(projectRoot, encoding = 'utf8') {
	return { cwd: projectRoot, encoding, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true };
}

/** Every regular top-level file under .github/workflows at the revision, as { path → bytes }. */
function readWorkflowTree(projectRoot, revision, execGit = secureExecFileSync) {
	const listing = execGit('git', ['ls-tree', '-z', revision, '--', `${WORKFLOWS_DIR}/`], gitOptions(projectRoot));
	const files = new Map();
	for (const entry of listing.split('\0').filter(Boolean)) {
		const match = /^(\d+) (\w+) [0-9a-f]+\t(.+)$/.exec(entry);
		if (!match || match[2] !== 'blob' || !/^100(?:644|755)$/.test(match[1])) continue;
		if (!isRetirableWorkflowPath(match[3])) continue;
		files.set(match[3], Buffer.from(execGit('git', ['show', `${revision}:${match[3]}`], gitOptions(projectRoot, 'buffer'))));
	}
	return files;
}

function parseWorkflow(filePath, content) {
	if (!WORKFLOW_FILE.test(filePath)) return { success: true, doc: null };
	try {
		const doc = YAML.parse(content.toString('utf8'));
		if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
			return { success: false, error: `${filePath} is not a workflow mapping.` };
		}
		return { success: true, doc };
	} catch (error) {
		return { success: false, error: `${filePath} is not parseable YAML: ${error.message}` };
	}
}

function escapeRegex(value) {
	return value.replace(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
}

// GitHub names a check run after the job (`name:` or the job id), adds a
// ` (matrix values)` suffix for matrices, and prefixes reusable-workflow jobs
// with `caller / `. Expressions in names can render to anything.
function checkNamePattern(name) {
	const parts = String(name).split(/\$\{\{[\s\S]*?\}\}/);
	return new RegExp(`^${parts.map(escapeRegex).join('.*')}(?: \\(.*\\))?$`);
}

function candidateCheckNames(doc) {
	if (!doc) return [];
	const names = [];
	if (doc.name !== undefined && doc.name !== null) names.push(String(doc.name));
	const jobs = doc.jobs && typeof doc.jobs === 'object' && !Array.isArray(doc.jobs) ? doc.jobs : {};
	for (const [jobId, job] of Object.entries(jobs)) {
		names.push(jobId);
		if (job && typeof job === 'object' && job.name !== undefined && job.name !== null) names.push(String(job.name));
	}
	return names;
}

/**
 * Returns the required contexts this workflow file could produce. Conservative on purpose:
 * a context counts when it matches a workflow/job check name (with matrix and reusable
 * decorations and expression wildcards), or when the file text names it at all, which also
 * covers statuses and code-scanning categories posted by steps.
 *
 * @param {Buffer|string} content workflow bytes
 * @param {string[]} requiredContexts branch-protection required contexts
 * @param {string} [filePath] repo path, used to decide whether to parse YAML
 * @returns {string[]} required contexts attributable to this file
 */
function producedRequiredContexts(content, requiredContexts, filePath = `${WORKFLOWS_DIR}/workflow.yml`) {
	const text = Buffer.isBuffer(content) ? content.toString('utf8') : String(content);
	const parsed = parseWorkflow(filePath, Buffer.from(text));
	if (!parsed.success) throw new Error(parsed.error);
	const patterns = candidateCheckNames(parsed.doc).map(checkNamePattern);
	return requiredContexts.filter(context => {
		const bounded = new RegExp(`(^|[^A-Za-z0-9_-])${escapeRegex(context)}($|[^A-Za-z0-9_-])`, 'm');
		if (bounded.test(text)) return true;
		const segments = [context, ...context.split(' / ')];
		return patterns.some(pattern => segments.some(segment => pattern.test(segment)));
	});
}

function asList(value) {
	if (value === undefined || value === null) return [];
	return Array.isArray(value) ? value : [value];
}

function workflowRunSources(doc) {
	const on = doc?.on;
	if (typeof on === 'string' || Array.isArray(on)) {
		return asList(on).includes('workflow_run') ? { unfiltered: true, names: [] } : { unfiltered: false, names: [] };
	}
	if (!on || typeof on !== 'object' || !Object.prototype.hasOwnProperty.call(on, 'workflow_run')) {
		return { unfiltered: false, names: [] };
	}
	const names = asList(on.workflow_run?.workflows).map(String);
	return { unfiltered: names.length === 0, names };
}

function reusableCalls(doc) {
	const jobs = doc?.jobs && typeof doc.jobs === 'object' ? doc.jobs : {};
	return Object.values(jobs)
		.filter(job => job && typeof job === 'object' && typeof job.uses === 'string')
		.map(job => job.uses.trim().replace(/@.*$/, ''));
}

/** Names another workflow's `workflow_run.workflows` can use for this file. */
function workflowRunNames(filePath, doc) {
	const names = new Set([filePath, filePath.slice(WORKFLOWS_DIR.length + 1)]);
	if (doc && typeof doc.name === 'string' && doc.name.trim()) names.add(doc.name);
	return names;
}

function findDependents(targets, tree, parsedByPath) {
	const retiring = new Set(targets);
	const problems = [];
	for (const [otherPath, parsed] of parsedByPath) {
		if (retiring.has(otherPath) || !parsed.doc) continue;
		const runs = workflowRunSources(parsed.doc);
		const calls = reusableCalls(parsed.doc);
		for (const target of targets) {
			const names = workflowRunNames(target, parsedByPath.get(target)?.doc);
			const file = target.slice(WORKFLOWS_DIR.length + 1);
			if (runs.unfiltered || runs.names.some(name => names.has(name))) {
				problems.push(`${otherPath} runs on workflow_run of ${target}`);
			}
			if (calls.some(ref => ref === `./${target}` || ref === target || ref.endsWith(`/${WORKFLOWS_DIR}/${file}`))) {
				problems.push(`${otherPath} calls ${target} via uses:`);
			}
		}
	}
	return problems;
}

function normalizeTargets(paths) {
	const list = asList(paths).map(normalizeRepoPath);
	if (list.length === 0) return { success: false, error: 'Name at least one .github/workflows/<file> to retire.' };
	const invalid = list.filter(filePath => !isRetirableWorkflowPath(filePath));
	if (invalid.length > 0) {
		return { success: false, error: `Only single files directly under ${WORKFLOWS_DIR}/ can be retired: ${invalid.join(', ')}` };
	}
	if (new Set(list).size !== list.length) return { success: false, error: 'Each workflow may be named only once.' };
	return { success: true, paths: list };
}

async function readRequiredContextSet(readRequiredContexts) {
	if (typeof readRequiredContexts !== 'function') {
		return { success: false, error: 'Branch protection reader is unavailable; refusing to retire a workflow without the required-context set.' };
	}
	let contexts;
	try {
		contexts = await readRequiredContexts();
	} catch (error) {
		return { success: false, error: `Branch protection is unreadable (${error.message}); refusing to retire a workflow.` };
	}
	if (!Array.isArray(contexts) || contexts.some(context => typeof context !== 'string' || !context.trim())) {
		return { success: false, error: 'Branch protection is unreadable or malformed; refusing to retire a workflow.' };
	}
	return { success: true, contexts: [...new Set(contexts)] };
}

function restoreRemoved(projectRoot, removed, writeOptions) {
	return removed.map(target => {
		try {
			return writeProtectedFile(projectRoot, target.path, target.content, {
				...writeOptions,
				operation: 'recover_retired_workflow',
				expectedContent: null,
			});
		} catch (error) {
			return { allowed: false, path: target.path, reason: error.message };
		}
	});
}

/**
 * Retires workflow files through the protected-state authority. Fail-closed preconditions:
 * exact HEAD, each path one existing file under .github/workflows at HEAD whose worktree bytes
 * equal HEAD, readable branch protection with no required context attributable to the file,
 * and no remaining workflow that depends on it via workflow_run or a reusable `uses:` call.
 *
 * @param {string} projectRoot repository root
 * @param {object} options paths, reason, expectedHead, readRequiredContexts, and writer seams
 * @returns {Promise<object>} success evidence, or `{ success: false, error }`
 */
async function retireWorkflows(projectRoot, options = {}) {
	const { verifyExpectedHead } = require('./npm-publish-workflow');
	const head = verifyExpectedHead(projectRoot, options.expectedHead, options.resolveHead);
	if (!head.success) return head;
	const sourceHead = head.sourceHead;
	const reason = typeof options.reason === 'string' ? options.reason.trim() : '';
	if (!reason) return { success: false, error: 'Workflow retirement requires a non-empty --reason.' };
	const normalized = normalizeTargets(options.paths);
	if (!normalized.success) return normalized;
	const targets = normalized.paths;

	let tree;
	try {
		tree = readWorkflowTree(projectRoot, sourceHead, options.execGit);
	} catch (error) {
		return { success: false, error: `Could not read ${WORKFLOWS_DIR} at ${sourceHead}: ${error.message}` };
	}
	const missing = targets.filter(target => !tree.has(target));
	if (missing.length > 0) return { success: false, error: `Not a regular file at ${sourceHead}: ${missing.join(', ')}` };

	const parsedByPath = new Map();
	for (const [filePath, content] of tree) {
		const parsed = parseWorkflow(filePath, content);
		if (!parsed.success) return { success: false, error: `Cannot prove workflow dependencies: ${parsed.error}` };
		parsedByPath.set(filePath, parsed);
	}

	const required = await readRequiredContextSet(options.readRequiredContexts);
	if (!required.success) return required;
	for (const target of targets) {
		const produced = producedRequiredContexts(tree.get(target), required.contexts, target);
		if (produced.length > 0) {
			return { success: false, error: `${target} produces required status context(s): ${produced.join(', ')}. Remove them from branch protection first.` };
		}
	}

	const dependents = findDependents(targets, tree, parsedByPath);
	if (dependents.length > 0) {
		return { success: false, error: `Other workflows depend on the retirement; retire them in the same call or remove the dependency: ${dependents.join('; ')}` };
	}

	const env = options.env || process.env;
	const actor = options.actor || env.FORGE_PROTECTED_STATE_ACTOR || env.FORGE_ACTOR || env.USER || env.USERNAME || 'unknown';
	const issueAuthorization = options.issueAuthorization || issueWorkflowRetirementAuthorization;
	const completeAuthorization = options.completeAuthorization || completeWorkflowRetirementAuthorization;
	const protectedRemover = options.removeProtectedFile || removeProtectedFile;
	const auditWriter = options.recordProtectedStateAuditEvent || recordProtectedStateAuditEvent;
	const writeOptions = { actor, viaForgeApi: true, surface: 'workflows' };

	const authorized = [];
	for (const target of targets) {
		const capabilityId = (options.createCapabilityId || randomUUID)();
		let authorization;
		try {
			authorization = await issueAuthorization(projectRoot, {
				actor, path: target, sourceHead, reason, priorContent: tree.get(target),
			}, { deps: options.kernelDeps, capabilityId });
		} catch (error) {
			authorization = { success: false, error: error.message };
		}
		if (!authorization.success || authorization.capabilityId !== capabilityId) {
			return { success: false, error: `Could not authorize retiring ${target}: ${authorization.error || 'authority returned a different capability id.'}` };
		}
		authorized.push({ path: target, content: tree.get(target), capabilityId });
	}

	const removed = [];
	for (const target of authorized) {
		let removal;
		try {
			removal = protectedRemover(projectRoot, target.path, {
				...writeOptions,
				operation: 'retire_workflow',
				expectedContent: target.content,
			});
		} catch (error) {
			removal = { allowed: false, reason: error.message };
		}
		if (!removal.allowed) {
			const recovery = restoreRemoved(projectRoot, removed, writeOptions);
			return { success: false, error: `Could not remove ${target.path}: ${removal.reason}`, recovery };
		}
		removed.push(target);
	}

	const retired = [];
	for (const target of authorized) {
		const audit = (() => {
			try {
				return auditWriter({
					...createProtectedStateAuditRecord({
						actor,
						surface: 'workflows',
						path: target.path,
						content: target.content,
						operation: 'retire_workflow',
						viaForgeApi: true,
						sourceHead,
					}),
					reason: `Forge retired workflow: ${reason}`,
				}, { cwd: projectRoot });
			} catch (error) {
				return { success: false, error: error.message };
			}
		})();
		if (!audit.success) {
			const recovery = restoreRemoved(projectRoot, removed, writeOptions);
			return { success: false, error: `Could not record retiring ${target.path}: ${audit.error}`, recovery };
		}
		let completion;
		try {
			completion = await completeAuthorization(projectRoot, {
				actor, path: target.path, sourceHead, reason, capabilityId: target.capabilityId, priorContent: target.content,
			}, { deps: options.kernelDeps });
		} catch (error) {
			completion = { success: false, error: error.message };
		}
		if (!completion.success) {
			const recovery = restoreRemoved(projectRoot, removed, writeOptions);
			return { success: false, error: `Could not complete retiring ${target.path}: ${completion.error}`, recovery };
		}
		retired.push({ path: target.path, capabilityId: target.capabilityId });
	}

	return { success: true, sourceHead, reason, paths: targets, retired };
}

/**
 * Required status contexts from classic branch protection on the default branch, read
 * through the PR-state adapter. Anything but an authoritative set throws (fail closed).
 *
 * @param {function(string[], object): string} runGh gh runner (bound account when available)
 * @param {string} projectRoot repository root
 * @returns {function(): Promise<string[]>}
 */
function createBranchProtectionContextReader(runGh, projectRoot) {
	return async () => {
		const { PrStateAdapter } = require('./adapters/pr-state-adapter');
		const repo = JSON.parse(runGh(['repo', 'view', '--json', 'nameWithOwner,defaultBranchRef,isFork'], { cwd: projectRoot }) || '{}');
		if (repo.isFork !== false) throw new Error('repository is a fork or its identity is unknown');
		const [owner, name] = String(repo.nameWithOwner || '').split('/');
		const base = repo.defaultBranchRef?.name;
		if (!owner || !name || !base) throw new Error('repository identity or default branch is unknown');
		const adapter = new PrStateAdapter({ gh: (_cmd, args) => runGh(args, { cwd: projectRoot }) });
		const policy = await adapter.readRequiredCheckPolicy({ owner, repo: name, base });
		if (!Array.isArray(policy) || adapter.lastRequiredSource !== 'protection') {
			throw new Error(`required status checks for ${owner}/${name}@${base} are not readable`);
		}
		return policy.map(entry => entry.context);
	};
}

module.exports = {
	createBranchProtectionContextReader,
	producedRequiredContexts,
	retireWorkflows,
};
