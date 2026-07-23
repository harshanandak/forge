'use strict';

const { secureExecFileSync } = require('../shell-utils.js');

// Developer identity for the status read model. Extracted from the retired
// lib/status/beads-snapshot.js: the identity lookup is backend-agnostic (it reads
// git config, never an issue store), so it outlived the Beads reader it shipped in.
// Kept in its own module so lib/status/snapshot.js stays read-model-only.

/**
 * Read a single git config value, or '' when git is unavailable or the key is unset.
 * Never throws — status must render even in a non-git directory.
 *
 * @param {string} projectRoot
 * @param {string} key — git config key (e.g. 'user.email')
 * @returns {string}
 */
function getGitConfig(projectRoot, key) {
	try {
		return secureExecFileSync('git', ['config', key], {
			encoding: 'utf8',
			cwd: projectRoot,
			stdio: ['pipe', 'pipe', 'pipe'],
		}).trim();
	} catch (_error) {
		return '';
	}
}

/**
 * The current developer's git identity, used to match claims to "my" work.
 *
 * @param {string} projectRoot
 * @returns {{ email: string, name: string }}
 */
function getDeveloperIdentity(projectRoot) {
	return {
		email: getGitConfig(projectRoot, 'user.email'),
		name: getGitConfig(projectRoot, 'user.name'),
	};
}

module.exports = {
	getDeveloperIdentity,
	getGitConfig,
};
