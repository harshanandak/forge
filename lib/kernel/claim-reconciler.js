'use strict';

const PROCESS_MANIFEST_VERSION = 1;

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
	if (!manifest || manifest.version !== PROCESS_MANIFEST_VERSION || manifest.token !== sessionId) return null;

	const owner = manifest.owner;
	const pid = positivePid(owner?.pid);
	const identity = nonEmptyString(owner?.identity);
	const startedAt = nonEmptyString(owner?.startedAt);
	if (!pid || !identity || identity.startsWith('unverified:') || !startedAt || !Array.isArray(manifest.children)) {
		return null;
	}

	return { sessionId, worktreeId, pid, identity, startedAt };
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

		let worktreePresent;
		try {
			worktreePresent = await worktreeExists(verified.worktreeId, claim);
		} catch {
			continue;
		}
		if (worktreePresent !== false) continue;

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
			if (await releaseClaim(claim, evidence)) released.push(claim.id);
		} catch {
			// A failed release is not evidence that authority changed.
		}
	}

	return { examined: claims.length, released };
}

module.exports = {
	reconcileClaims,
	verifiedManifestForClaim,
};
