'use strict';

const STOP_WORDS = new Set([
	'the',
	'a',
	'an',
	'and',
	'or',
	'is',
	'in',
	'to',
	'for',
	'of',
	'with',
	'on',
	'at',
	'by',
	'from',
	'add',
	'fix',
	'update',
	'implement',
	'create',
	'remove',
	'delete',
	'make',
	'use',
	'get',
	'set',
	'run',
	'test',
	'check',
	'all',
	'this',
	'that',
	'it',
	'be',
	'as',
	'not',
	'no',
	'but',
	'if',
	'do',
	'we',
	'they',
	'are',
	'was',
	'were',
	'been',
	'have',
	'has',
	'had',
	'will',
	'would',
	'could',
	'should',
	'may',
	'can',
	'each',
	'every',
	'both',
	'also',
	'into',
	'than',
	'then',
	'when',
	'where',
	'which',
	'what',
	'how',
	'why',
	'who',
	'its',
	'new',
	'first',
	'last',
	'same',
	'other',
]);

function tokenizeMeaningfulTerms(title) {
	return [...new Set(
		String(title ?? '')
			.toLowerCase()
			.split(/[^a-z]+/u)
			.filter((term) => term.length >= 3)
			.filter((term) => !STOP_WORDS.has(term)),
	)].sort();
}

function collectSharedTerms(sourceTerms, candidateTerms) {
	const candidateSet = new Set(candidateTerms);
	return sourceTerms.filter((term) => candidateSet.has(term));
}

function isInProgressLine(line) {
	return line.includes('◐') || line.includes('â—');
}

function parseActiveIssueLines(listOutput) {
	return String(listOutput ?? '')
		.split(/\r?\n/u)
		.map((line) => line.trim())
		.filter(Boolean)
		.map((line) => {
			const idMatch = line.match(/forge-[a-zA-Z0-9]+(?:\.[a-zA-Z0-9]+)*/u);
			if (!idMatch) {
				return null;
			}

			const titleIndex = line.indexOf(' - ');
			const priorityMatch = line.match(/P\d+/u);
			return {
				id: idMatch[0],
				priority: priorityMatch ? priorityMatch[0] : 'P2',
				status: isInProgressLine(line) ? 'in_progress' : 'open',
				title: titleIndex >= 0 ? line.slice(titleIndex + 3).trim() : '',
			};
		})
		.filter(Boolean);
}

function renderKeywordRippleReport({ issueId, sourceTitle, activeIssues }) {
	const sourceTerms = tokenizeMeaningfulTerms(sourceTitle);
	const overlaps = [];

	for (const candidate of activeIssues ?? []) {
		if (!candidate || candidate.id === issueId) {
			continue;
		}

		const sharedTerms = collectSharedTerms(sourceTerms, tokenizeMeaningfulTerms(candidate.title));
		if (sharedTerms.length < 2) {
			continue;
		}

		overlaps.push({
			id: candidate.id,
			priority: candidate.priority || 'P2',
			status: candidate.status || 'open',
			title: candidate.title || '',
			sharedTerms,
		});
	}

	if (overlaps.length === 0) {
		return {
			overlapCount: 0,
			overlaps,
			output: 'No conflicts detected',
		};
	}

	const lines = [`Potential overlap with ${overlaps.length} issue(s):`, ''];
	for (const overlap of overlaps) {
		const renderedSharedTerms = overlap.sharedTerms.map((term) => `"${term}"`).join(', ');
		lines.push(`  ${overlap.id} (${overlap.status}, ${overlap.priority}): "${overlap.title}"`);
		lines.push(`  Overlap: keyword match - ${renderedSharedTerms}`);
		lines.push('  Confidence: LOW (keyword only, no contract data)');
		lines.push('');
		lines.push('  Options:');
		lines.push(`  (a) Add dependency: bd dep add ${issueId} ${overlap.id}`);
		lines.push('  (b) Proceed - no real conflict');
		lines.push(`  (c) Investigate: bd show ${overlap.id}`);
		lines.push('');
	}

	return {
		overlapCount: overlaps.length,
		overlaps,
		output: lines.join('\n').trimEnd(),
	};
}

module.exports = {
	STOP_WORDS,
	collectSharedTerms,
	isInProgressLine,
	parseActiveIssueLines,
	renderKeywordRippleReport,
	tokenizeMeaningfulTerms,
};
