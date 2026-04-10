'use strict';

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

function getGitConfig(projectRoot, key) {
	try {
		return execFileSync('git', ['config', key], {
			encoding: 'utf8',
			cwd: projectRoot,
			stdio: ['pipe', 'pipe', 'pipe'],
		}).trim();
	} catch (_error) {
		return '';
	}
}

function getDeveloperIdentity(projectRoot) {
	return {
		email: getGitConfig(projectRoot, 'user.email'),
		name: getGitConfig(projectRoot, 'user.name'),
	};
}

function readIssues(projectRoot) {
	const issuesPath = path.join(projectRoot, '.beads', 'issues.jsonl');
	if (!fs.existsSync(issuesPath)) {
		return [];
	}

	const raw = fs.readFileSync(issuesPath, 'utf8');
	const latestById = new Map();

	for (const line of raw.split(/\r?\n/)) {
		if (!line.trim()) {
			continue;
		}

		try {
			const issue = JSON.parse(line);
			if (issue && issue.id) {
				latestById.set(issue.id, issue);
			}
		} catch (_error) {
			// Ignore malformed rows so one bad append does not break status.
		}
	}

	return Array.from(latestById.values());
}

function isAssignedToDeveloper(issue, developer) {
	if (!issue || !developer) {
		return false;
	}

	if (issue.owner) {
		return developer.email !== '' && issue.owner === developer.email;
	}

	return developer.name !== '' && issue.created_by === developer.name;
}

function sortByUpdatedAtDesc(left, right) {
	const leftTime = Date.parse(left.updated_at || 0);
	const rightTime = Date.parse(right.updated_at || 0);
	return rightTime - leftTime;
}

function readBeadsSnapshot(projectRoot) {
	const developer = getDeveloperIdentity(projectRoot);
	const issues = readIssues(projectRoot);

	return {
		developer,
		issues,
		activeAssigned: issues.filter(issue => issue.status === 'in_progress' && isAssignedToDeveloper(issue, developer)),
		ready: issues.filter(issue => issue.status === 'open' && Number(issue.dependency_count || 0) === 0),
		recentCompleted: issues.filter(issue => issue.status === 'closed').sort(sortByUpdatedAtDesc),
	};
}

module.exports = {
	getDeveloperIdentity,
	isAssignedToDeveloper,
	readBeadsSnapshot,
};
