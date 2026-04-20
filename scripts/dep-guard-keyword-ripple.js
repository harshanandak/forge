#!/usr/bin/env node
'use strict';

const {
	parseActiveIssueLines,
	renderKeywordRippleReport,
} = require('../lib/dep-guard/keyword-ripple.js');

function main() {
	try {
		const report = renderKeywordRippleReport({
			issueId: process.env.ISSUE_ID || '',
			sourceTitle: process.env.SOURCE_TITLE || '',
			activeIssues: parseActiveIssueLines(process.env.LIST_OUTPUT || ''),
		});

		if (report.overlapCount > 0) {
			process.stdout.write(`⚠️  ${report.output}\n`);
			return;
		}

		process.stdout.write(`✅ ${report.output}\n`);
	} catch (error) {
		console.error(`dep-guard-keyword-ripple: ${error.message}`);
		process.exit(1);
	}
}

main();
