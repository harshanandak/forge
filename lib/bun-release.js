'use strict';

/**
 * Resolves the latest stable Bun release from GitHub so the weekly pin job can
 * compare it with the repository pin. Every unreadable or unexpected answer
 * throws: the caller must never pin a version it could not prove is stable.
 */

const BUN_LATEST_RELEASE_URL = 'https://api.github.com/repos/oven-sh/bun/releases/latest';
const STABLE_VERSION = /^(\d+)\.(\d+)\.(\d+)$/;
const STABLE_TAG = /^bun-v(\d+\.\d+\.\d+)$/;

/**
 * @param {unknown} value candidate version
 * @returns {boolean} true only for an exact X.Y.Z version (no prerelease, canary, or `v` prefix)
 */
function isStableBunVersion(value) {
	return typeof value === 'string' && STABLE_VERSION.test(value);
}

/**
 * @param {string} left exact stable version
 * @param {string} right exact stable version
 * @returns {-1|0|1} numeric ordering of the two versions
 */
function compareStableVersions(left, right) {
	const a = STABLE_VERSION.exec(left);
	const b = STABLE_VERSION.exec(right);
	if (!a || !b) throw new Error(`Cannot compare non-stable Bun versions "${left}" and "${right}".`);
	for (let index = 1; index <= 3; index += 1) {
		const delta = Number(a[index]) - Number(b[index]);
		if (delta !== 0) return delta > 0 ? 1 : -1;
	}
	return 0;
}

/**
 * Reads GitHub's latest oven-sh/bun release and returns its stable version.
 *
 * @param {{ fetch?: Function, token?: string }} [options] injected fetch and optional GitHub token
 * @returns {Promise<{ version: string, tag: string, releaseUrl: string }>}
 * @throws {Error} on fetch failure, non-success status, unreadable JSON, a draft or prerelease, or a malformed tag
 */
async function resolveLatestStableBun(options = {}) {
	const fetchImpl = Object.prototype.hasOwnProperty.call(options, 'fetch') ? options.fetch : globalThis.fetch;
	if (typeof fetchImpl !== 'function') throw new Error('A fetch implementation is required to resolve the latest Bun release.');
	const headers = { Accept: 'application/vnd.github+json', 'User-Agent': 'forge-bun-pin' };
	if (options.token) headers.Authorization = `Bearer ${options.token}`;

	const response = await fetchImpl(BUN_LATEST_RELEASE_URL, { headers });
	if (!response || !response.ok) {
		throw new Error(`GitHub latest Bun release request failed with status ${response ? response.status : 'unknown'}.`);
	}
	const release = await response.json();
	if (!release || typeof release !== 'object' || Array.isArray(release)) {
		throw new Error('GitHub latest Bun release response is not a release object.');
	}
	if (release.draft !== false) throw new Error('Latest Bun release is a draft or does not declare draft: false.');
	if (release.prerelease !== false) throw new Error('Latest Bun release is a prerelease or does not declare prerelease: false.');
	const match = typeof release.tag_name === 'string' ? STABLE_TAG.exec(release.tag_name) : null;
	if (!match) throw new Error(`Latest Bun release tag ${JSON.stringify(release.tag_name)} is not a stable bun-vX.Y.Z tag.`);
	return {
		version: match[1],
		tag: release.tag_name,
		releaseUrl: `https://github.com/oven-sh/bun/releases/tag/${release.tag_name}`,
	};
}

/**
 * CLI for the weekly pin job: prints GITHUB_OUTPUT-style `key=value` lines that
 * compare the latest stable Bun with the package.json pin.
 */
async function main() {
	const fs = require('node:fs');
	const path = require('node:path');
	const { readPinnedBunVersion } = require('./bun-workflow-pins');
	const current = readPinnedBunVersion(fs.readFileSync(path.join(process.cwd(), 'package.json')));
	const latest = await resolveLatestStableBun({ token: process.env.GITHUB_TOKEN });
	const newer = compareStableVersions(latest.version, current) > 0;
	process.stdout.write([
		`current=${current}`,
		`latest=${latest.version}`,
		`newer=${newer}`,
		`release_url=${latest.releaseUrl}`,
		'',
	].join('\n'));
}

if (require.main === module) {
	main().catch(error => {
		process.stderr.write(`Could not resolve the latest stable Bun: ${error.message}\n`);
		process.exit(1);
	});
}

module.exports = {
	BUN_LATEST_RELEASE_URL,
	compareStableVersions,
	isStableBunVersion,
	resolveLatestStableBun,
};
