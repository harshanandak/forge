'use strict';

// `forge setup --remove-claude-pointer`: deletes a root CLAUDE.md that is only the Forge
// `@AGENTS.md` pointer, once the installed Claude Code reads AGENTS.md natively. The deletion
// goes through the protected-state authority: a delete-only capability bound to the exact
// pointer bytes at HEAD, completed only after the file is gone, revoked if anything fails.

const { randomUUID } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { secureExecFileSync } = require('./shell-utils');
const { removeProtectedFile, writeProtectedFile } = require('./protected-state-surfaces');
const {
	completeClaudePointerRemovalAuthorization,
	issueClaudePointerRemovalAuthorization,
	revokeClaudePointerRemovalAuthorization,
} = require('./protected-state-authority');
const { resolveCurrentHead } = require('./bun-workflow-pins');

// First Claude Code release that reads AGENTS.md when no CLAUDE.md exists
// (code.claude.com/docs/en/memory).
const MIN_NATIVE_AGENTS_MD_CLAUDE_VERSION = '2.1.277';

function parseClaudeCodeVersion(output) {
	const match = /(\d+)\.(\d+)\.(\d+)/.exec(String(output || ''));
	return match ? `${match[1]}.${match[2]}.${match[3]}` : null;
}

function isAtLeast(version, minimum) {
	const a = version.split('.').map(Number);
	const b = minimum.split('.').map(Number);
	for (let i = 0; i < 3; i++) {
		if (a[i] !== b[i]) return a[i] > b[i];
	}
	return true;
}

function readInstalledClaudeVersion() {
	return secureExecFileSync('claude', ['--version'], {
		encoding: 'utf8',
		stdio: ['ignore', 'pipe', 'pipe'],
		timeout: 15_000,
		windowsHide: true,
	});
}

function checkClaudeVersion(readClaudeVersion) {
	const requirement = `Removing the CLAUDE.md pointer requires Claude Code >= ${MIN_NATIVE_AGENTS_MD_CLAUDE_VERSION}, which reads AGENTS.md natively; CLAUDE.md was left in place.`;
	let output;
	try {
		output = readClaudeVersion();
	} catch (error) {
		return { success: false, error: `Could not detect Claude Code via \`claude --version\` (${error.message}). ${requirement}` };
	}
	const version = parseClaudeCodeVersion(output);
	if (!version || !isAtLeast(version, MIN_NATIVE_AGENTS_MD_CLAUDE_VERSION)) {
		return { success: false, error: `Installed Claude Code ${version || '(unknown version)'} is too old. ${requirement}` };
	}
	return { success: true, version };
}

function readWorktreeClaude(projectRoot) {
	try {
		const fullPath = path.join(projectRoot, 'CLAUDE.md');
		const stat = fs.lstatSync(fullPath);
		if (!stat.isFile() || stat.isSymbolicLink()) return { success: false, error: 'CLAUDE.md is not a regular file.' };
		return { success: true, content: fs.readFileSync(fullPath) };
	} catch (error) {
		return { success: false, error: `Could not read CLAUDE.md: ${error.message}` };
	}
}

/**
 * Removes the root CLAUDE.md pointer through the protected-state authority.
 *
 * @param {string} projectRoot repository root
 * @param {object} [options] actor/env, kernelDeps, and the readClaudeVersion/resolveHead seams
 * @returns {Promise<{success: boolean, error?: string, removed?: boolean, sourceHead?: string, capabilityId?: string, claudeVersion?: string}>}
 */
async function removeClaudePointer(projectRoot, options = {}) {
	const versionCheck = checkClaudeVersion(options.readClaudeVersion || readInstalledClaudeVersion);
	if (!versionCheck.success) return versionCheck;

	const env = options.env || process.env;
	const actor = options.actor || env.FORGE_PROTECTED_STATE_ACTOR || env.FORGE_ACTOR || env.USER || env.USERNAME || 'unknown';
	let sourceHead;
	try {
		sourceHead = (options.resolveHead || resolveCurrentHead)(projectRoot);
	} catch (error) {
		return { success: false, error: `Could not resolve current HEAD: ${error.message}` };
	}
	const worktree = readWorktreeClaude(projectRoot);
	if (!worktree.success) return worktree;
	const priorContent = worktree.content;
	const capabilityId = (options.createCapabilityId || randomUUID)();
	const authorityOptions = { deps: options.kernelDeps };

	// The authority refuses unless the worktree bytes equal the exact pointer bytes at HEAD.
	let authorization;
	try {
		authorization = await issueClaudePointerRemovalAuthorization(projectRoot, { actor, sourceHead, priorContent }, { ...authorityOptions, capabilityId });
	} catch (error) {
		authorization = { success: false, error: error.message };
	}
	if (!authorization.success || authorization.capabilityId !== capabilityId) {
		return { success: false, error: `Could not authorize removing CLAUDE.md: ${authorization.error || 'authority returned a different capability id.'}` };
	}

	const writeOptions = { actor, viaForgeApi: true, surface: 'generated_harness' };
	// Revoke first; restore only once the capability is provably dead, so a live
	// authorization can never delete a restored file.
	const fail = async (error, restore) => {
		let revocation;
		try {
			revocation = await revokeClaudePointerRemovalAuthorization(projectRoot, { actor, capabilityId }, authorityOptions);
		} catch (revokeError) {
			revocation = { success: false, error: revokeError.message };
		}
		if (!revocation.success) {
			return { success: false, error: `${error} Revocation failed (${revocation.error}); CLAUDE.md left as-is. Rerun once the Kernel is reachable.` };
		}
		if (restore) {
			writeProtectedFile(projectRoot, 'CLAUDE.md', priorContent, { ...writeOptions, operation: 'recover_claude_import', expectedContent: null });
		}
		return { success: false, error };
	};

	let removal;
	try {
		removal = removeProtectedFile(projectRoot, 'CLAUDE.md', { ...writeOptions, operation: 'remove_claude_import', expectedContent: priorContent });
	} catch (error) {
		removal = { allowed: false, reason: error.message };
	}
	if (!removal.allowed) return fail(`Could not remove CLAUDE.md: ${removal.reason}`, false);

	let completion;
	try {
		completion = await completeClaudePointerRemovalAuthorization(projectRoot, {
			actor, sourceHead, capabilityId, priorContent,
		}, authorityOptions);
	} catch (error) {
		completion = { success: false, error: error.message };
	}
	if (!completion.success) return fail(`Could not complete removing CLAUDE.md: ${completion.error}`, true);

	return { success: true, removed: true, sourceHead, capabilityId, claudeVersion: versionCheck.version };
}

module.exports = {
	MIN_NATIVE_AGENTS_MD_CLAUDE_VERSION,
	parseClaudeCodeVersion,
	removeClaudePointer,
};
