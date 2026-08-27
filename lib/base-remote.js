'use strict';

const { execFileSync } = require('node:child_process');

const BASE_REMOTE_CANDIDATES = ['upstream', 'origin'];
const DEFAULT_BRANCH_CANDIDATES = ['main', 'master'];
const GIT_PROBE_TIMEOUT_MS = 120000;

/**
 * Quiet git probe options. `stdio: 'pipe'` keeps failed probes from leaking to
 * the terminal — these are speculative queries, not user-facing commands.
 *
 * @param {string} cwd - Working directory for the probe.
 * @returns {object} execFileSync options.
 */
function getQuietProbeOptions(cwd) {
	return { encoding: 'utf8', cwd, timeout: GIT_PROBE_TIMEOUT_MS, stdio: 'pipe' };
}

/**
 * Resolve `refs/remotes/<remote>/HEAD` to the ref it points at, verifying the
 * target actually exists.
 *
 * @param {Function} [exec] - Injected execFileSync.
 * @param {string} [cwd] - Repository directory.
 * @param {string} remoteName - Remote to probe.
 * @returns {string|null} Fully-qualified ref, or null.
 */
function resolveRemoteHeadTarget(exec = execFileSync, cwd = process.cwd(), remoteName) {
	try {
		const symbolicRef = exec('git', ['symbolic-ref', `refs/remotes/${remoteName}/HEAD`], getQuietProbeOptions(cwd)).trim();
		if (!symbolicRef) {
			return null;
		}
		exec('git', ['rev-parse', '--verify', symbolicRef], getQuietProbeOptions(cwd));
		return symbolicRef;
	} catch (_error) {
		return null;
	}
}

/**
 * True when the remote has fetched tracking refs we can treat as a base:
 * a recorded HEAD, or one of the conventional default branches.
 *
 * @param {Function} [exec] - Injected execFileSync.
 * @param {string} [cwd] - Repository directory.
 * @param {string} remoteName - Remote to probe.
 * @returns {boolean} Whether a usable tracking base exists.
 */
function remoteHasTrackingBase(exec = execFileSync, cwd = process.cwd(), remoteName) {
	if (resolveRemoteHeadTarget(exec, cwd, remoteName)) {
		return true;
	}

	for (const candidate of DEFAULT_BRANCH_CANDIDATES) {
		try {
			exec('git', ['rev-parse', '--verify', `refs/remotes/${remoteName}/${candidate}`], getQuietProbeOptions(cwd));
			return true;
		} catch (_error) {
			// Probe next candidate.
		}
	}

	return false;
}

/**
 * Resolve the remote that owns the integration base. `upstream` wins over
 * `origin` so a fork-style checkout resolves the official repository rather
 * than the contributor's fork.
 *
 * @param {Function} [exec] - Injected execFileSync.
 * @param {string} [cwd] - Repository directory.
 * @returns {string} Remote name ('origin' when nothing else qualifies).
 */
function resolveBaseRemote(exec = execFileSync, cwd = process.cwd()) {
	for (const candidate of BASE_REMOTE_CANDIDATES) {
		try {
			exec('git', ['remote', 'get-url', candidate], getQuietProbeOptions(cwd));
			if (remoteHasTrackingBase(exec, cwd, candidate)) {
				return candidate;
			}
		} catch (_error) {
			// Probe next candidate.
		}
	}

	return 'origin';
}

/**
 * Resolve the base remote's default branch name.
 *
 * @param {Function} [exec] - Injected execFileSync.
 * @param {string} [cwd] - Repository directory.
 * @param {string} [remoteName] - Remote to probe; defaults to the base remote.
 * @returns {string} Branch name ('master' when nothing else resolves).
 */
function resolveBaseBranch(exec = execFileSync, cwd = process.cwd(), remoteName = resolveBaseRemote(exec, cwd)) {
	const symbolicRef = resolveRemoteHeadTarget(exec, cwd, remoteName);
	if (symbolicRef) {
		const match = new RegExp(`^refs/remotes/${remoteName}/(.+)$`).exec(symbolicRef);
		if (match && match[1]) {
			return match[1];
		}
	}

	for (const candidate of DEFAULT_BRANCH_CANDIDATES) {
		try {
			exec('git', ['rev-parse', '--verify', `refs/remotes/${remoteName}/${candidate}`], getQuietProbeOptions(cwd));
			return candidate;
		} catch (_error) {
			// Probe next candidate.
		}
	}

	return 'master';
}

module.exports = {
	BASE_REMOTE_CANDIDATES,
	DEFAULT_BRANCH_CANDIDATES,
	resolveRemoteHeadTarget,
	remoteHasTrackingBase,
	resolveBaseRemote,
	resolveBaseBranch,
};
