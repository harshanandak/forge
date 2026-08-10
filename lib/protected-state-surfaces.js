const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { redact } = require('./audit-evidence');
const { appendCappedJsonlRecord } = require('./capped-jsonl-log');

/**
 * Protected-state decisions are logged locally rather than to the kernel event
 * stream: kernel events are issue-scoped and async, and this runs inside a
 * synchronous pre-commit hook that has no issue id and must not open the kernel
 * SQLite handle. Capped so a repeated blocked commit cannot grow it unbounded.
 */
const PROTECTED_STATE_AUDIT_LOG = '.forge/protected-state-audit.jsonl';
const PROTECTED_STATE_AUDIT_MAX_RECORDS = 500;

function normalizeRepoPath(filePath) {
	return String(filePath || '')
		.replace(/\\/g, '/')
		.replace(/^\.\//, '')
		.replace(/\/+/g, '/');
}

function hashProtectedContent(content) {
	const bytes = Buffer.isBuffer(content) ? content : Buffer.from(String(content), 'utf8');
	return `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;
}

function createProtectedStateAuditRecord({
	actor,
	surface,
	path: filePath,
	content,
	operation = 'generate',
	viaForgeApi = false,
	sourceHead,
}) {
	if (!actor || !surface || !filePath || content === undefined) {
		throw new TypeError('Protected state audit record requires actor, surface, path, and content');
	}

	return {
		kind: 'protected_state_write',
		actor,
		path: normalizeRepoPath(filePath),
		decision: 'allowed',
		requiredSurface: surface,
		declaredSurface: surface,
		operation,
		viaForgeApi: viaForgeApi === true,
		...(sourceHead ? { sourceHead } : {}),
		contentHash: hashProtectedContent(content),
		reason: `Forge API generated content for protected surface: ${surface}.`,
		repairHint: null,
	};
}

function startsWithAny(filePath, prefixes) {
	return prefixes.some(prefix => filePath === prefix || filePath.startsWith(`${prefix}/`));
}

const PROTECTED_SURFACES = [
	{
		id: 'immutable',
		label: 'Immutable runtime paths',
		matches: filePath => startsWithAny(filePath, ['.git', '.hg', '.svn']),
		repairHint: 'Do not edit immutable VCS/runtime internals directly; use git or the owning tool command.',
	},
	{
		id: 'secrets',
		label: 'Secrets',
		matches: filePath =>
			filePath === '.env' ||
			filePath.startsWith('.env.') ||
			filePath.endsWith('/.env') ||
			filePath.includes('/.env.') ||
			/(^|\/)(secrets?|credentials?)(\.|\/|$)/i.test(filePath),
		repairHint: 'Use the project secret manager or local environment setup command; never hand-edit or commit secrets.',
	},
	{
		id: 'append_only_logs',
		label: 'Append-only logs',
		matches: filePath =>
			[
				'.forge/log.jsonl',
				'.forge/audit.log',
				'.forge/agent-log.ndjson',
				'.beads/interactions.jsonl',
			].includes(filePath),
		repairHint: 'append-only logs must be written by the Forge audit writer; do not rewrite existing log content.',
	},
	{
		id: 'beads_state',
		label: 'Legacy Beads state',
		matches: filePath => startsWithAny(filePath, ['.beads']),
		repairHint: 'A legacy .beads directory is import-only state. Import it with `forge migrate --from beads`, then use Forge issue commands such as forge ready or forge close.',
	},
	{
		id: 'forge_config',
		label: 'Forge config',
		matches: filePath =>
			filePath === '.forge/config.yaml' ||
			filePath === '.forge/config.yml' ||
			filePath === '.forge/config.json' ||
			filePath === '.forge/protected-paths.yaml',
		repairHint: 'Use Forge setup/config commands or the protected Forge API writer for .forge configuration.',
	},
	{
		id: 'extension_manifests',
		label: 'Extension manifests',
		matches: filePath =>
			filePath === '.github/PLUGIN_TEMPLATE.json' ||
			/^\.forge\/extensions\/[^/]+\/manifest\.json$/i.test(filePath) ||
			/^plugins\/[^/]+\/(?:plugin|extension|manifest)\.json$/i.test(filePath),
		repairHint: 'Use the Forge extension/plugin manager so manifests and trust metadata stay consistent.',
	},
	{
		id: 'lockfiles',
		label: 'Lockfiles',
		matches: filePath =>
			/(^|\/)(bun\.lock|package-lock\.json|pnpm-lock\.yaml|yarn\.lock|requirements\.lock|poetry\.lock|Cargo\.lock|go\.sum)$/.test(filePath) ||
			filePath === '.forge/extensions.lock',
		repairHint: 'Regenerate lockfiles through the package manager or Forge extension installer instead of editing them by hand.',
	},
	{
		id: 'workflows',
		label: 'Workflow definitions',
		matches: filePath =>
			startsWithAny(filePath, ['.github/workflows', '.forge/hooks']) ||
			filePath === 'lefthook.yml',
		repairHint: 'Use Forge workflow/setup commands so workflow files and hooks remain in sync.',
	},
	{
		id: 'generated_harness',
		label: 'Generated harness files',
		matches: filePath =>
			startsWithAny(filePath, [
				'.agents/skills',
				'.claude/skills',
				'.codex/skills',
				'.cursor/rules',
			]) ||
			['AGENTS.md', 'CLAUDE.md', '.mcp.json'].includes(filePath),
		repairHint: 'Regenerate harness files with forge setup or the owning Forge API surface instead of direct edits.',
	},
	{
		id: 'memory_projection',
		label: 'Memory projection files',
		matches: filePath =>
			startsWithAny(filePath, ['docs/sessions', 'docs/memory', '.forge/memory']) ||
			filePath.endsWith('/memory.md') ||
			filePath.endsWith('/MEMORY.md'),
		repairHint: 'Use the Forge memory projection command or append-only session writer; do not edit projections directly.',
	},
];

function classifyProtectedPath(filePath) {
	const normalized = normalizeRepoPath(filePath);
	if (!normalized) return null;
	const surface = PROTECTED_SURFACES.find(candidate => candidate.matches(normalized));
	if (!surface) return null;
	return {
		path: normalized,
		surface: surface.id,
		label: surface.label,
		repairHint: surface.repairHint,
	};
}

function resolveRepoRelativePath(projectRoot, filePath) {
	const root = path.resolve(projectRoot);
	const target = path.resolve(root, filePath);
	if (!pathStaysInsideRoot(root, target)) {
		return {
			insideRoot: false,
			root,
			target,
			relativePath: normalizeRepoPath(filePath),
		};
	}
	return {
		insideRoot: true,
		root,
		target,
		relativePath: normalizeRepoPath(path.relative(root, target)),
	};
}

function pathStaysInsideRoot(root, candidate) {
	return candidate === root || candidate.startsWith(`${root}${path.sep}`);
}

function lstatIfPresent(candidate) {
	try {
		return fs.lstatSync(candidate);
	} catch (error) {
		if (error.code === 'ENOENT') return null;
		throw error;
	}
}

function nearestExistingPath(candidate) {
	let current = candidate;
	while (!lstatIfPresent(current)) {
		const parent = path.dirname(current);
		if (parent === current) return current;
		current = parent;
	}
	return current;
}

function realpathNearestExistingPath(candidate) {
	return fs.realpathSync(nearestExistingPath(candidate));
}

function assertNoAncestorSymlinkEscape(root, target) {
	const realRoot = realpathNearestExistingPath(root);
	const existing = nearestExistingPath(path.dirname(target));
	const existingStat = lstatIfPresent(existing);
	if (existing !== root && existingStat?.isSymbolicLink()) {
		return {
			allowed: false,
			decision: 'blocked',
			reason: `Write ancestor is a symlink: ${existing}`,
			repairHint: 'Remove the symlink escape or write through a real directory inside the project root.',
		};
	}

	const realExisting = realpathNearestExistingPath(existing);
	if (!pathStaysInsideRoot(realRoot, realExisting)) {
		return {
			allowed: false,
			decision: 'blocked',
			reason: `Write ancestor resolves outside project root: ${existing}`,
			repairHint: 'Remove the symlink escape or write through a real directory inside the project root.',
		};
	}
	return null;
}

function assertNoSymlinkEscape(root, target) {
	const parent = path.dirname(target);
	const realRoot = realpathNearestExistingPath(root);
	const existingParent = realpathNearestExistingPath(parent);
	if (!pathStaysInsideRoot(realRoot, existingParent)) {
		return {
			allowed: false,
			decision: 'blocked',
			reason: `Write parent resolves outside project root: ${parent}`,
			repairHint: 'Remove the symlink escape or write through a real directory inside the project root.',
		};
	}

	try {
		if (fs.lstatSync(target).isSymbolicLink()) {
			return {
				allowed: false,
				decision: 'blocked',
				reason: `Write target is a symlink: ${target}`,
				repairHint: 'Replace the symlink with a real file through the owning Forge API before writing.',
			};
		}
	} catch (error) {
		if (error.code !== 'ENOENT') {
			throw error;
		}
	}

	return null;
}

function assertProtectedWriteAllowed(filePath, options = {}) {
	const classification = classifyProtectedPath(filePath);
	const actor = options.actor || process.env.FORGE_ACTOR || process.env.USER || process.env.USERNAME || 'unknown';
	const operation = options.operation || 'write';

	if (!classification) {
		return {
			allowed: true,
			decision: 'allowed',
			actor,
			path: normalizeRepoPath(filePath),
			operation,
			requiredSurface: null,
			reason: 'Path is not protected.',
			repairHint: null,
		};
	}

	const requiredSurface = classification.surface;
	const declaredSurface = options.surface || options.requiredSurface;
	const allowed = Boolean(options.viaForgeApi && declaredSurface === requiredSurface);

	return {
		allowed,
		decision: allowed ? 'allowed' : 'blocked',
		actor,
		path: classification.path,
		operation,
		requiredSurface,
		surfaceLabel: classification.label,
		declaredSurface: declaredSurface || null,
		reason: allowed
			? `Forge API write declared required surface: ${requiredSurface}.`
			: `Direct edits to protected ${requiredSurface} paths are not allowed.`,
		repairHint: classification.repairHint,
	};
}

function writeProtectedFile(projectRoot, filePath, content, options = {}) {
	const resolved = resolveRepoRelativePath(projectRoot, filePath);
	if (!resolved.insideRoot) {
		return {
			allowed: false,
			decision: 'blocked',
			actor: options.actor || process.env.FORGE_ACTOR || process.env.USER || process.env.USERNAME || 'unknown',
			path: resolved.relativePath,
			operation: options.operation || 'write',
			requiredSurface: null,
			reason: `Write path escapes project root: ${filePath}`,
			repairHint: 'Write only repo-relative paths inside the project root.',
		};
	}

	const decision = assertProtectedWriteAllowed(resolved.relativePath, {
		...options,
		operation: options.operation || 'write',
	});
	if (!decision.allowed) return decision;

	const ancestorEscape = assertNoAncestorSymlinkEscape(resolved.root, resolved.target);
	if (ancestorEscape) {
		return {
			...decision,
			...ancestorEscape,
		};
	}

	fs.mkdirSync(path.dirname(resolved.target), { recursive: true });
	const symlinkEscape = assertNoSymlinkEscape(resolved.root, resolved.target);
	if (symlinkEscape) {
		return {
			...decision,
			...symlinkEscape,
		};
	}

	fs.writeFileSync(resolved.target, content, options.encoding || 'utf8');
	return { ...decision, contentHash: hashProtectedContent(content), fullPath: resolved.target };
}

function buildProtectedStateAuditEvent(decision) {
	if (!decision || typeof decision !== 'object') {
		throw new TypeError('Protected state decision is required');
	}

	const event = {
		kind: 'protected_state_write',
		actor: decision.actor || 'unknown',
		path: decision.path,
		decision: decision.decision,
		requiredSurface: decision.requiredSurface,
		declaredSurface: decision.declaredSurface || null,
		operation: decision.operation || 'write',
		viaForgeApi: decision.viaForgeApi === true,
		...(decision.sourceHead ? { sourceHead: decision.sourceHead } : {}),
		contentHash: decision.contentHash || null,
		reason: decision.reason,
		repairHint: decision.repairHint,
		metadata: {
			actor: decision.actor || 'unknown',
			path: decision.path,
			operation: decision.operation || 'write',
			viaForgeApi: decision.viaForgeApi === true,
			...(decision.sourceHead ? { sourceHead: decision.sourceHead } : {}),
			contentHash: decision.contentHash || null,
			requiredSurface: decision.requiredSurface,
			declaredSurface: decision.declaredSurface || null,
			decision: decision.decision,
			reason: decision.reason,
			repairHint: decision.repairHint,
		},
	};

	return redact(event);
}

/**
 * Best-effort: a failed audit write is reported to the caller, never thrown, so
 * the protected-state decision itself still stands.
 */
function recordProtectedStateAuditEvent(decision, options = {}) {
	const event = buildProtectedStateAuditEvent(decision);
	const logPath = path.resolve(options.cwd || process.cwd(), PROTECTED_STATE_AUDIT_LOG);
	const appendRecord = options.appendRecord || appendCappedJsonlRecord;

	try {
		const record = { ...event, recordedAt: options.now || new Date().toISOString() };
		appendRecord(logPath, record, options.maxRecords || PROTECTED_STATE_AUDIT_MAX_RECORDS);
		return { success: true, event, logPath };
	} catch (error) {
		return { success: false, event, logPath, error: error.message };
	}
}

module.exports = {
	PROTECTED_SURFACES,
	PROTECTED_STATE_AUDIT_LOG,
	PROTECTED_STATE_AUDIT_MAX_RECORDS,
	normalizeRepoPath,
	hashProtectedContent,
	createProtectedStateAuditRecord,
	resolveRepoRelativePath,
	lstatIfPresent,
	assertNoAncestorSymlinkEscape,
	assertNoSymlinkEscape,
	classifyProtectedPath,
	assertProtectedWriteAllowed,
	writeProtectedFile,
	buildProtectedStateAuditEvent,
	recordProtectedStateAuditEvent,
};
