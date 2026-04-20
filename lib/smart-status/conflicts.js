'use strict';

function splitLines(value) {
	if (!value) {
		return [];
	}

	return String(value)
		.replaceAll('\r', '')
		.split('\n');
}

function uniqueStrings(values) {
	const result = [];
	const seen = new Set();

	for (const value of values || []) {
		if (typeof value !== 'string') {
			continue;
		}
		const normalized = value.trim();
		if (!normalized || seen.has(normalized)) {
			continue;
		}
		seen.add(normalized);
		result.push(normalized);
	}

	return result;
}

function parseWorktreePorcelain(porcelainText, baseBranch) {
	const worktrees = [];
	let currentPath = '';
	let currentBranch = '';

	for (const line of splitLines(porcelainText)) {
		if (line.startsWith('worktree ')) {
			currentPath = line.slice('worktree '.length);
			continue;
		}

		if (line.startsWith('branch refs/heads/')) {
			currentBranch = line.slice('branch refs/heads/'.length);
			continue;
		}

		if (line !== '') {
			continue;
		}

		if (currentBranch && currentBranch !== baseBranch) {
			worktrees.push({ branch: currentBranch, path: currentPath });
		}
		currentPath = '';
		currentBranch = '';
	}

	if (currentBranch && currentBranch !== baseBranch) {
		worktrees.push({ branch: currentBranch, path: currentPath });
	}

	return worktrees;
}

function branchSlugToSearch(branch) {
	const slug = String(branch || '').includes('/')
		? String(branch).slice(String(branch).lastIndexOf('/') + 1)
		: String(branch || '');
	return slug.replaceAll('-', ' ').toLowerCase();
}

function matchInProgressIssues(worktrees, inProgressIssues) {
	const issues = Array.isArray(inProgressIssues) ? inProgressIssues : [];

	return (Array.isArray(worktrees) ? worktrees : []).map((worktree) => {
		const slug = branchSlugToSearch(worktree.branch);
		const issueIds = issues
			.filter((issue) => typeof issue?.title === 'string' && issue.title.toLowerCase().includes(slug))
			.map((issue) => issue?.id)
			.filter((issueId) => typeof issueId === 'string' && issueId);

		return {
			branch: worktree.branch,
			path: worktree.path,
			issue_ids: issueIds,
			issue_count: issueIds.length,
		};
	});
}

function normalizeBranchFiles(branchFiles) {
	if (Array.isArray(branchFiles)) {
		return branchFiles
			.filter((entry) => entry && typeof entry.branch === 'string')
			.map((entry) => ({
				branch: entry.branch,
				files: uniqueStrings(entry.files),
			}));
	}

	if (branchFiles && typeof branchFiles === 'object') {
		return Object.entries(branchFiles).map(([branch, files]) => ({
			branch,
			files: uniqueStrings(files),
		}));
	}

	return [];
}

function computeFileConflicts(sessions, branchFiles) {
	const branchFileEntries = normalizeBranchFiles(branchFiles);
	const filesByBranch = new Map(branchFileEntries.map((entry) => [entry.branch, entry.files]));

	return (Array.isArray(sessions) ? sessions : []).map((session) => {
		const changedFiles = filesByBranch.get(session.branch) || [];
		const conflicts = [];

		for (const other of branchFileEntries) {
			if (other.branch === session.branch || other.files.length === 0 || changedFiles.length === 0) {
				continue;
			}

			const otherSet = new Set(other.files);
			const overlap = uniqueStrings(changedFiles.filter((file) => otherSet.has(file)));
			if (overlap.length > 0) {
				conflicts.push({ branch: other.branch, files: overlap });
			}
		}

		return {
			...session,
			changed_files: changedFiles,
			conflicts,
		};
	});
}

function parseMergeTreeNameOnly(stdout) {
	const lines = splitLines(stdout).filter((line, index) => index > 0 && line.trim().length > 0);
	return uniqueStrings(lines);
}

function applyMergeTreeConflicts(sessions, mergeTreeResults) {
	const nextSessions = (Array.isArray(sessions) ? sessions : []).map((session) => ({
		...session,
		merge_conflicts: Array.isArray(session.merge_conflicts) ? [...session.merge_conflicts] : [],
	}));
	const sessionIndexes = new Map(nextSessions.map((session, index) => [session.branch, index]));

	for (const result of Array.isArray(mergeTreeResults) ? mergeTreeResults : []) {
		if (!result || typeof result.left !== 'string' || typeof result.right !== 'string') {
			continue;
		}

		if (!result.exitCode) {
			continue;
		}

		const files = parseMergeTreeNameOnly(result.output);
		if (files.length === 0) {
			continue;
		}

		for (const [targetBranch, otherBranch] of [[result.left, result.right], [result.right, result.left]]) {
			const index = sessionIndexes.get(targetBranch);
			if (index === undefined) {
				continue;
			}

			nextSessions[index].merge_conflicts.push({
				branch: otherBranch,
				files,
			});
		}
	}

	return nextSessions.map((session) => {
		if (session.merge_conflicts.length === 0) {
			const nextSession = { ...session };
			delete nextSession.merge_conflicts;
			return nextSession;
		}

		return session;
	});
}

module.exports = {
	applyMergeTreeConflicts,
	computeFileConflicts,
	matchInProgressIssues,
	parseMergeTreeNameOnly,
	parseWorktreePorcelain,
};
