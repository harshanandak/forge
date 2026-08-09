'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {
	DEFAULT_MANIFEST_DIR,
	defaultGetProcessIdentity,
	isValidManifest,
	readProcessManifest,
} = require('../../scripts/process-tree');

function nonEmptyString(value) {
	return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

function positivePid(value) {
	return Number.isInteger(value) && value > 0 ? value : null;
}

function verifiedManifestForClaim(claim, manifest) {
	const sessionId = nonEmptyString(claim?.session_id);
	const worktreeId = nonEmptyString(claim?.worktree_id);
	if (!nonEmptyString(claim?.id) || !nonEmptyString(claim?.issue_id) || !sessionId || !worktreeId) return null;
	if (claim.state != null && claim.state !== 'active') return null;
	if (!isValidManifest(manifest) || manifest.token !== sessionId) return null;

	const owner = manifest.owner;
	const pid = positivePid(owner?.pid);
	const identity = nonEmptyString(owner?.identity);
	const startedAt = nonEmptyString(owner?.startedAt);
	if (!pid || !identity || identity.startsWith('unverified:') || !startedAt || !Array.isArray(manifest.children)) {
		return null;
	}

	return { sessionId, worktreeId, pid, identity, startedAt };
}

function defaultIsProcessAlive(pid) {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return error?.code === 'EPERM';
	}
}

function createManifestReader(options = {}) {
	const fsApi = options.fsApi || fs;
	const processApi = options.processApi || process;
	const manifestDir = options.manifestDir || DEFAULT_MANIFEST_DIR;
	return async (sessionId) => {
		let entries;
		try {
			entries = fsApi.readdirSync(manifestDir, { withFileTypes: true });
		} catch {
			return null;
		}
		const matches = [];
		for (const entry of entries) {
			const name = typeof entry === 'string' ? entry : entry?.name;
			if (!name || !name.endsWith('.json')) continue;
			if (typeof entry !== 'string' && entry.isFile && !entry.isFile()) continue;
			const manifest = readProcessManifest(path.join(manifestDir, name), fsApi, processApi);
			if (manifest?.token === sessionId) matches.push(manifest);
		}
		return matches.length === 1 ? matches[0] : null;
	};
}

function createWorktreeInspector(driver, fsApi = fs) {
	return async (worktreeId, claim) => {
		let rows;
		try {
			rows = await driver.listWorktrees({});
		} catch {
			return null;
		}
		const linked = (Array.isArray(rows) ? rows : []).filter(row => row
			&& row.issue_id === claim.issue_id
			&& row.state === 'active'
			&& (row.id === worktreeId || path.basename(row.path || '') === worktreeId));
		if (linked.length !== 1 || !nonEmptyString(linked[0].path)) return null;
		try {
			if (typeof fsApi.lstatSync === 'function') {
				fsApi.lstatSync(linked[0].path);
				return { exists: true, row: linked[0] };
			}
			return { exists: fsApi.existsSync(linked[0].path), row: linked[0] };
		} catch (error) {
			if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') {
				return { exists: false, row: linked[0] };
			}
			return null;
		}
	};
}

function createMissingPathVerifier(fsApi = fs) {
	return (worktreePath) => {
		try {
			if (typeof fsApi.lstatSync === 'function') fsApi.lstatSync(worktreePath);
			else if (fsApi.existsSync(worktreePath)) return false;
			else return true;
			return false;
		} catch (error) {
			return error?.code === 'ENOENT' || error?.code === 'ENOTDIR';
		}
	};
}

async function reconcileClaims(options = {}) {
	const claims = Array.isArray(options.claims) ? options.claims : [];
	const readManifest = options.readManifest;
	const worktreeExists = options.worktreeExists;
	const isProcessAlive = options.isProcessAlive;
	const getProcessIdentity = options.getProcessIdentity;
	const releaseClaim = options.releaseClaim;
	const released = [];
	const attempted = new Set();

	if (![readManifest, worktreeExists, isProcessAlive, getProcessIdentity, releaseClaim]
		.every(dependency => typeof dependency === 'function')) {
		return { examined: claims.length, released };
	}

	for (const claim of claims) {
		if (!nonEmptyString(claim?.id) || attempted.has(claim.id)) continue;

		let manifest;
		try {
			manifest = await readManifest(claim.session_id, claim);
		} catch {
			continue;
		}
		const verified = verifiedManifestForClaim(claim, manifest);
		if (!verified) continue;

		let worktreeInspection;
		try {
			worktreeInspection = await worktreeExists(verified.worktreeId, claim);
		} catch {
			continue;
		}
		const worktreeMissing = worktreeInspection === false
			|| worktreeInspection?.exists === false;
		if (!worktreeMissing) continue;

		let ownerAlive;
		try {
			ownerAlive = await isProcessAlive(verified.pid);
		} catch {
			continue;
		}
		if (ownerAlive !== false) {
			if (ownerAlive !== true) continue;
			let currentIdentity;
			try {
				currentIdentity = await getProcessIdentity(verified.pid);
			} catch {
				continue;
			}
			// A matching owner is live. A mismatch is PID reuse or otherwise
			// unverifiable; neither authorizes releasing its claim.
			if (currentIdentity !== verified.identity) continue;
			continue;
		}

		attempted.add(claim.id);
		const evidence = Object.freeze({
			claim_id: claim.id,
			issue_id: claim.issue_id,
			session_id: verified.sessionId,
			worktree_id: verified.worktreeId,
			manifest_version: manifest.version,
			manifest_token: manifest.token,
			owner_pid: verified.pid,
			owner_identity: verified.identity,
			owner_started_at: verified.startedAt,
			run_state: 'dead',
			worktree_state: 'missing',
		});

		try {
			if (await releaseClaim(claim, evidence, worktreeInspection)) released.push(claim.id);
		} catch {
			// A failed release is not evidence that authority changed.
		}
	}

	return { examined: claims.length, released };
}

async function reconcileKernelClaims(options = {}) {
	const driver = options.driver;
	if (!driver || typeof driver.listWorktrees !== 'function'
		|| typeof driver.releaseExactClaimIfWorktreeMissing !== 'function') {
		return { examined: 0, released: [] };
	}

	let claims;
	try {
		if (typeof driver.listActiveClaims === 'function') {
			claims = await driver.listActiveClaims();
		} else {
			const response = await driver.issueOperation('claims', [], options.context || {}, options.config || {});
			claims = response?.data?.claims;
		}
	} catch {
		return { examined: 0, released: [] };
	}

	return reconcileClaims({
		claims,
		readManifest: options.readManifest || createManifestReader(options),
		worktreeExists: options.worktreeExists || createWorktreeInspector(driver, options.fsApi || fs),
		isProcessAlive: options.isProcessAlive || defaultIsProcessAlive,
		getProcessIdentity: options.getProcessIdentity || (pid => defaultGetProcessIdentity(pid, options)),
		releaseClaim: async (claim, evidence, inspection) => {
			const released = await driver.releaseExactClaimIfWorktreeMissing(
				claim,
				inspection?.row,
				createMissingPathVerifier(options.fsApi || fs),
				evidence,
				options.config || {},
			);
			if (released && typeof options.onEvidence === 'function') options.onEvidence(evidence);
			return released;
		},
	});
}

module.exports = {
	createManifestReader,
	createWorktreeInspector,
	reconcileClaims,
	reconcileKernelClaims,
	verifiedManifestForClaim,
};
