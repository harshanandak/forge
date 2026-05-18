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

const DEFAULT_STALE_AFTER_DAYS = 14;

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

function hasUnresolvedDependencies(issue) {
	return Number(issue.dependency_count || 0) > 0;
}

function isOpenIssue(issue) {
	return issue.status === 'open' || issue.status === 'in_progress';
}

function isStale(issue, now, staleAfterDays) {
	if (!isOpenIssue(issue)) {
		return false;
	}

	const updatedAt = parseTimestampOrZero(issue.updated_at);
	if (updatedAt === 0) {
		return false;
	}

	const staleMs = staleAfterDays * 24 * 60 * 60 * 1000;
	return now.getTime() - updatedAt >= staleMs;
}

function readBeadsSnapshot(projectRoot, options = {}) {
	const developer = getDeveloperIdentity(projectRoot);
	const issues = readIssues(projectRoot);
	const parsedNow = options.now instanceof Date
		? options.now
		: (typeof options.now === 'string' ? new Date(options.now) : null);
	const now = parsedNow instanceof Date && !Number.isNaN(parsedNow.getTime())
		? parsedNow
		: new Date();
	const parsedStaleAfterDays = Number(options.staleAfterDays);
	const staleAfterDays = Number.isFinite(parsedStaleAfterDays)
		? parsedStaleAfterDays
		: DEFAULT_STALE_AFTER_DAYS;

	return {
		developer,
		issues,
		active: issues.filter(issue => issue.status === 'in_progress').sort(sortByUpdatedAtDesc),
		activeAssigned: issues.filter(issue => issue.status === 'in_progress' && isAssignedToDeveloper(issue, developer)),
		ready: issues.filter(issue => issue.status === 'open' && !hasUnresolvedDependencies(issue)),
		blocked: issues.filter(issue => isOpenIssue(issue) && hasUnresolvedDependencies(issue)).sort(sortByUpdatedAtDesc),
		stale: issues.filter(issue => isStale(issue, now, staleAfterDays)).sort(sortByUpdatedAtDesc),
		recentCompleted: issues.filter(issue => issue.status === 'closed').sort(sortByUpdatedAtDesc),
		limits: [
			'Uses local Beads issues.jsonl only.',
			'Does not read GitHub review, CI, project, or sync freshness state.',
		],
	};
}

module.exports = {
	getDeveloperIdentity,
	isAssignedToDeveloper,
	readBeadsSnapshot,
	hasUnresolvedDependencies,
	isStale,
};
