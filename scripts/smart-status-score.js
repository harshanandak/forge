#!/usr/bin/env node
'use strict';

const fs = require('node:fs');

const { scoreIssues } = require('../lib/smart-status/scoring.js');

function readPayload() {
	const raw = fs.readFileSync(0, 'utf8');
	if (!raw.trim()) {
		return { issues: [], epicStats: {} };
	}

	const payload = JSON.parse(raw);
	return {
		issues: Array.isArray(payload.issues) ? payload.issues : [],
		epicStats: payload.epicStats && typeof payload.epicStats === 'object' ? payload.epicStats : {},
	};
}

function main() {
	try {
		const payload = readPayload();
		process.stdout.write(JSON.stringify(scoreIssues(payload.issues, { epicStats: payload.epicStats })));
	} catch (error) {
		console.error(`smart-status-score: ${error.message}`);
		process.exit(1);
	}
}

main();
