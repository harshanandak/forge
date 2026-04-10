'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { secureExecFileSync } = require('../shell-utils.js');

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

function getDeveloperIdentity(projectRoot) {
	return {
		email: getGitConfig(projectRoot, 'user.email'),
		name: getGitConfig(projectRoot, 'user.name'),
	};
}

function normalizeEmail(value) {
	return typeof value === 'string' ? value.trim().toLowerCase() : '';
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
		const developerEmail = normalizeEmail(developer.email);
		return developerEmail !== '' && normalizeEmail(issue.owner) === developerEmail;
	}

	return developer.name !== '' && issue.created_by === developer.name;
}

function parseTimestampOrZero(value) {
	if (!value) {
		return 0;
	}

	const parsed = Date.parse(value);
	return Number.isNaN(parsed) ? 0 : parsed;
}

function sortByUpdatedAtDesc(left, right) {
	const leftTime = parseTimestampOrZero(left.updated_at);
	const rightTime = parseTimestampOrZero(right.updated_at);
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
