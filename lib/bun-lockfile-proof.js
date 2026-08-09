'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync: defaultSpawnSync } = require('node:child_process');
const { hashProtectedContent } = require('./protected-state-surfaces');

const REGULAR_GIT_MODES = new Set(['100644', '100755']);
const VERSION_TIMEOUT_MS = 5_000;
const INSTALL_TIMEOUT_MS = 30_000;
const SAFE_FAILURE_REASONS = new Set([
	'Working tree has inputs outside the captured Git index',
	'Workspace graph contains a symlink or submodule',
	'Tracked .npmrc is outside the deterministic proof contract',
	'Indexed bun.lock is missing or is not a regular file',
	'Proposed bun.lock is empty',
	'Committed bun.lock is missing or is not a regular file',
	'Committed bun.lock is empty',
	'Proposed bun.lock does not differ from committed HEAD',
	'Indexed root package.json is missing',
	'Package-manager input is not a regular file',
	'Indexed root package.json is invalid',
	'Root packageManager must pin an exact Bun version',
	'Workspace path is invalid',
	'Workspace path escapes the proof root',
	'Local dependency path escapes the proof root',
	'Bun version check failed',
	'Bun version is not an exact semantic version',
	'Installed Bun does not match root packageManager',
	'Bun lockfile regeneration failed',
	'Committed HEAD changed during Bun lockfile proof',
	'Git index changed during Bun lockfile proof',
	'Regenerated bun.lock is not a regular file',
	'Regenerated bun.lock does not match the staged content',
]);

function blocked(reason, proposed = Buffer.alloc(0)) {
	return {
		allowed: false,
		decision: 'blocked',
		path: 'bun.lock',
		requiredSurface: 'lockfiles',
		declaredSurface: null,
		operation: 'staged_edit',
		contentHash: proposed.length ? hashProtectedContent(proposed) : null,
		reason,
		repairHint: 'Stage all intended files and the bun.lock produced by the exact pinned Bun version, then retry.',
	};
}

function allowed(proposed) {
	return {
		allowed: true,
		decision: 'allowed',
		path: 'bun.lock',
		requiredSurface: 'lockfiles',
		declaredSurface: 'lockfiles',
		operation: 'staged_edit',
		contentHash: hashProtectedContent(proposed),
		reason: 'Pinned Bun transition from the captured committed lock matched the indexed bun.lock byte-for-byte.',
		repairHint: null,
	};
}

function parseBunVersion(output) {
	const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(String(output || '').trim());
	if (!match) throw new Error('Bun version is not an exact semantic version');
	return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) };
}

function parsePinnedBunVersion(packageJson) {
	const match = /^bun@(\d+\.\d+\.\d+)$/.exec(String(packageJson.packageManager || ''));
	if (!match) throw new Error('Root packageManager must pin an exact Bun version');
	parseBunVersion(match[1]);
	return match[1];
}

function normalizeSeparators(filePath) {
	return String(filePath).replaceAll('\\', '/');
}

function resolveContainedPath(root, relativePath) {
	const raw = String(relativePath || '');
	const normalized = normalizeSeparators(raw);
	if (!normalized || normalized.includes('\0') || isPortableAbsolute(raw) || isPortableAbsolute(normalized)) {
		throw new Error('Path escape or invalid path');
	}
	const rootPath = path.resolve(root);
	const target = path.resolve(rootPath, ...normalized.split('/'));
	if (target === rootPath || !target.startsWith(`${rootPath}${path.sep}`)) {
		throw new Error('Path escape outside proof root');
	}
	return target;
}

function git(projectRoot, args, options = {}) {
	return execFileSync('git', ['-C', projectRoot, ...args], { // NOSONAR S4036 -- Fixed local Git executable with structured non-shell arguments is the trusted repository toolchain boundary.
		encoding: options.encoding === undefined ? null : options.encoding,
		stdio: ['ignore', 'pipe', 'pipe'],
		timeout: options.timeout || 10_000,
		maxBuffer: 16 * 1024 * 1024,
	});
}

function captureIndexTree(projectRoot) {
	return git(projectRoot, ['write-tree']).toString('utf8').trim();
}

function captureHead(projectRoot) {
	const oid = git(projectRoot, ['rev-parse', '--verify', 'HEAD']).toString('utf8').trim();
	const tree = git(projectRoot, ['rev-parse', '--verify', `${oid}^{tree}`]).toString('utf8').trim();
	return { oid, tree };
}

function parseTreeEntries(projectRoot, tree) {
	return git(projectRoot, ['ls-tree', '-r', '-z', tree])
		.toString('utf8')
		.split('\0')
		.filter(Boolean)
		.map(record => {
			const match = /^(\d+) (blob|tree|commit) ([0-9a-f]+)\t([\s\S]+)$/.exec(record);
			if (!match) throw new Error('Git tree evidence is malformed');
			return { mode: match[1], type: match[2], hash: match[3], path: match[4] };
		});
}

function isLockInput(filePath) {
	return filePath === 'package.json' || filePath.endsWith('/package.json');
}

function assertNoDirtyInputs(projectRoot) {
	const status = git(projectRoot, ['status', '--porcelain=v1', '-z', '--untracked-files=all']).toString('utf8');
	const records = status.split('\0').filter(Boolean);
	for (let index = 0; index < records.length; index += 1) {
		const record = records[index];
		const state = record.slice(0, 2);
		if (state === '??' || state[1] !== ' ') {
			throw new Error('Working tree has inputs outside the captured Git index');
		}
		if (/[RC]/.test(state)) index += 1;
	}
}

function readBlob(projectRoot, hash) {
	return git(projectRoot, ['cat-file', 'blob', hash]);
}

function isPortableAbsolute(filePath) {
	return path.posix.isAbsolute(filePath) || path.win32.isAbsolute(filePath) || /^[A-Za-z]:/.test(filePath) || /^[/\\]{2}/.test(filePath);
}

function hasTraversal(filePath) {
	return /(^|[/\\{,(|])\.\.(?=$|[/\\},)|])/.test(filePath);
}

function validateWorkspacePaths(rootManifest) {
	const workspaces = Array.isArray(rootManifest.workspaces)
		? rootManifest.workspaces
		: rootManifest.workspaces?.packages;
	if (workspaces === undefined) return;
	if (!Array.isArray(workspaces)) throw new Error('Root workspaces must be an array');
	for (const workspace of workspaces) {
		if (typeof workspace !== 'string' || !workspace || workspace.includes('\0')) {
			throw new Error('Workspace path is invalid');
		}
		const normalized = normalizeSeparators(workspace);
		if (isPortableAbsolute(normalized) || hasTraversal(normalized)) {
			throw new Error('Workspace path escapes the proof root');
		}
	}
}

function workspaceContainsEntry(workspaces, entryPath) {
	return workspaces.some(workspace => {
		const normalized = normalizeSeparators(workspace);
		const special = normalized.search(/[?*{[!]/);
		const prefix = (special === -1 ? normalized : normalized.slice(0, special)).replace(/\/$/, '');
		return prefix && (entryPath === prefix || entryPath.startsWith(`${prefix}/`));
	});
}

function validateLocalDependencyPaths(manifest) {
	for (const field of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
		for (const specifier of Object.values(manifest[field] || {})) {
			if (typeof specifier !== 'string' || !/^(?:file|link):/.test(specifier)) continue;
			const relative = normalizeSeparators(specifier.replace(/^(?:file|link):/, ''));
			if (isPortableAbsolute(relative) || hasTraversal(relative)) {
				throw new Error('Local dependency path escapes the proof root');
			}
		}
	}
}

function writeRegularFile(root, filePath, content) {
	const target = resolveContainedPath(root, filePath);
	fs.mkdirSync(path.dirname(target), { recursive: true });
	const rootReal = fs.realpathSync(root);
	const parentReal = fs.realpathSync(path.dirname(target));
	if (parentReal !== rootReal && !parentReal.startsWith(`${rootReal}${path.sep}`)) {
		throw new Error('Path escape through proof directory');
	}
	fs.writeFileSync(target, content, { flag: 'wx' });
}

function sanitizedEnvironment(proofContainer) {
	const allowedKeys = new Set(['PATH', 'PATHEXT', 'SYSTEMROOT', 'COMSPEC', 'WINDIR', 'TEMP', 'TMP', 'LANG', 'LC_ALL']);
	const env = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (allowedKeys.has(key.toUpperCase())) env[key] = value;
	}
	env.HOME = proofContainer;
	env.USERPROFILE = env.HOME;
	env.APPDATA = resolveContainedPath(proofContainer, '.appdata');
	env.BUN_INSTALL_CACHE_DIR = resolveContainedPath(proofContainer, '.bun-cache');
	return env;
}

function processSucceeded(result) {
	return Boolean(result?.status === 0 && !result.error && !result.signal);
}

function readLockTransition(repoRoot) {
	const head = captureHead(repoRoot);
	const indexTree = captureIndexTree(repoRoot);
	const entries = parseTreeEntries(repoRoot, indexTree);
	const headEntries = parseTreeEntries(repoRoot, head.tree);
	const proposedEntry = entries.find(entry => entry.path === 'bun.lock');
	const baseEntry = headEntries.find(entry => entry.path === 'bun.lock');
	return {
		head,
		indexTree,
		entries,
		proposedEntry,
		proposed: proposedEntry?.type === 'blob' ? readBlob(repoRoot, proposedEntry.hash) : Buffer.alloc(0),
		baseEntry,
		baseLock: baseEntry?.type === 'blob' ? readBlob(repoRoot, baseEntry.hash) : Buffer.alloc(0),
	};
}

function assertLockTransition(transition) {
	if (!transition.proposedEntry || !REGULAR_GIT_MODES.has(transition.proposedEntry.mode)) {
		throw new Error('Indexed bun.lock is missing or is not a regular file');
	}
	if (!transition.proposed.length) throw new Error('Proposed bun.lock is empty');
	if (transition.baseEntry?.type !== 'blob' || !REGULAR_GIT_MODES.has(transition.baseEntry.mode)) {
		throw new Error('Committed bun.lock is missing or is not a regular file');
	}
	if (!transition.baseLock.length) throw new Error('Committed bun.lock is empty');
	if (transition.baseLock.equals(transition.proposed)) {
		throw new Error('Proposed bun.lock does not differ from committed HEAD');
	}
}

function readManifestProofInputs(repoRoot, entries) {
	if (entries.some(entry => entry.path === '.npmrc' || entry.path.endsWith('/.npmrc'))) {
		throw new Error('Tracked .npmrc is outside the deterministic proof contract');
	}
	const inputs = entries.filter(entry => isLockInput(entry.path));
	if (!inputs.some(entry => entry.path === 'package.json')) {
		throw new Error('Indexed root package.json is missing');
	}
	if (inputs.some(entry => !REGULAR_GIT_MODES.has(entry.mode))) {
		throw new Error('Package-manager input is not a regular file');
	}

	const manifests = new Map();
	for (const entry of inputs) {
		const content = readBlob(repoRoot, entry.hash);
		const manifest = JSON.parse(content.toString('utf8'));
		validateLocalDependencyPaths(manifest);
		manifests.set(entry.path, { content, manifest });
	}
	const rootManifest = manifests.get('package.json')?.manifest;
	if (!rootManifest) throw new Error('Indexed root package.json is invalid');
	validateWorkspacePaths(rootManifest);
	const workspaces = Array.isArray(rootManifest.workspaces)
		? rootManifest.workspaces
		: rootManifest.workspaces?.packages || [];
	if (entries.some(entry => ['120000', '160000'].includes(entry.mode) && workspaceContainsEntry(workspaces, entry.path))) {
		throw new Error('Workspace graph contains a symlink or submodule');
	}
	return { inputs, manifests, pinnedVersion: parsePinnedBunVersion(rootManifest) };
}

function createProofWorkspace(proofContainer, repoRoot, proofInputs, baseLock) {
	const proofRoot = resolveContainedPath(proofContainer, 'repo');
	fs.mkdirSync(proofRoot);
	for (const entry of proofInputs.inputs) {
		const content = proofInputs.manifests.get(entry.path)?.content || readBlob(repoRoot, entry.hash);
		writeRegularFile(proofRoot, entry.path, content);
	}
	writeRegularFile(proofRoot, 'bun.lock', baseLock);
	git(proofRoot, ['init', '--quiet']);

	const env = sanitizedEnvironment(proofContainer);
	fs.mkdirSync(env.HOME, { recursive: true });
	fs.mkdirSync(env.APPDATA, { recursive: true });
	fs.mkdirSync(env.BUN_INSTALL_CACHE_DIR, { recursive: true });
	const emptyConfig = resolveContainedPath(proofContainer, 'empty-bunfig.toml');
	fs.writeFileSync(emptyConfig, '');
	return { proofRoot, env, emptyConfig };
}

function runPinnedBunTransition(spawn, workspace, pinnedVersion) {
	const processOptions = {
		cwd: workspace.proofRoot,
		encoding: 'utf8',
		stdio: ['ignore', 'pipe', 'pipe'],
		env: workspace.env,
	};
	const versionResult = spawn('bun', ['--version'], { ...processOptions, timeout: VERSION_TIMEOUT_MS });
	if (!processSucceeded(versionResult)) throw new Error('Bun version check failed');
	const actualVersion = parseBunVersion(versionResult.stdout);
	if (`${actualVersion.major}.${actualVersion.minor}.${actualVersion.patch}` !== pinnedVersion) {
		throw new Error('Installed Bun does not match root packageManager');
	}

	const installResult = spawn(
		'bun',
		['install', `--config=${workspace.emptyConfig}`, '--lockfile-only', '--ignore-scripts'],
		{ ...processOptions, timeout: INSTALL_TIMEOUT_MS },
	);
	if (!processSucceeded(installResult)) throw new Error('Bun lockfile regeneration failed');
}

function assertTransitionResult(repoRoot, transition, proofRoot) {
	if (captureHead(repoRoot).oid !== transition.head.oid) {
		throw new Error('Committed HEAD changed during Bun lockfile proof');
	}
	if (captureIndexTree(repoRoot) !== transition.indexTree) {
		throw new Error('Git index changed during Bun lockfile proof');
	}
	assertNoDirtyInputs(repoRoot);

	const generatedPath = resolveContainedPath(proofRoot, 'bun.lock');
	const generatedStat = fs.lstatSync(generatedPath);
	if (!generatedStat.isFile() || generatedStat.isSymbolicLink()) {
		throw new Error('Regenerated bun.lock is not a regular file');
	}
	if (!fs.readFileSync(generatedPath).equals(transition.proposed)) {
		throw new Error('Regenerated bun.lock does not match the staged content');
	}
}

function verifyBunLockfileRegeneration(projectRoot, options = {}) {
	const spawn = options.spawnSync || defaultSpawnSync;
	let proposed = Buffer.alloc(0);
	let proofContainer = null;

	try {
		const repoRoot = fs.realpathSync(projectRoot);
		assertNoDirtyInputs(repoRoot);
		const transition = readLockTransition(repoRoot);
		proposed = transition.proposed;
		assertLockTransition(transition);
		const proofInputs = readManifestProofInputs(repoRoot, transition.entries);

		proofContainer = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'forge-bun-lock-proof-')));
		const workspace = createProofWorkspace(proofContainer, repoRoot, proofInputs, transition.baseLock);
		runPinnedBunTransition(spawn, workspace, proofInputs.pinnedVersion);
		assertTransitionResult(repoRoot, transition, workspace.proofRoot);
		return allowed(proposed);
	} catch (error) {
		const reason = SAFE_FAILURE_REASONS.has(error.message)
			? error.message
			: 'Bun lockfile proof could not be reconstructed safely';
		return blocked(reason, proposed);
	} finally {
		if (proofContainer) fs.rmSync(proofContainer, { recursive: true, force: true });
	}
}

module.exports = {
	parseBunVersion,
	parsePinnedBunVersion,
	resolveContainedPath,
	verifyBunLockfileRegeneration,
};
