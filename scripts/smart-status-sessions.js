#!/usr/bin/env node
'use strict';

const fs = require('node:fs');

const {
	applyMergeTreeConflicts,
	computeFileConflicts,
	matchInProgressIssues,
	parseWorktreePorcelain,
} = require('../lib/smart-status/conflicts.js');

function readPayload() {
	const raw = fs.readFileSync(0, 'utf8');
	if (!raw.trim()) {
		return {};
	}

	return JSON.parse(raw);
}

function buildSessions(payload) {
	let sessions = Array.isArray(payload.sessions)
		? payload.sessions
		: matchInProgressIssues(
			parseWorktreePorcelain(payload.worktreePorcelain || '', payload.baseBranch || 'master'),
			Array.isArray(payload.inProgressIssues) ? payload.inProgressIssues : [],
		);

	if (payload.branchFiles) {
		sessions = computeFileConflicts(sessions, payload.branchFiles);
	}

	if (payload.mergeTreeResults) {
		sessions = applyMergeTreeConflicts(sessions, payload.mergeTreeResults);
	}

	return sessions;
}

function main() {
	try {
		const payload = readPayload();
		process.stdout.write(JSON.stringify(buildSessions(payload)));
	} catch (error) {
		console.error(`smart-status-sessions: ${error.message}`);
		process.exit(1);
	}
}

main();
