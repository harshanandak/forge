const STOP_WORDS = new Set([
	'the', 'a', 'an', 'and', 'or', 'is', 'in', 'to', 'for', 'of', 'with', 'on',
	'at', 'by', 'from', 'add', 'fix', 'update', 'implement', 'create', 'remove',
	'delete', 'make', 'use', 'get', 'set', 'run', 'test', 'check', 'this', 'that',
	'it', 'be', 'as', 'not', 'no', 'but', 'if', 'do', 'we', 'they', 'are', 'was',
	'were', 'been', 'have', 'has', 'had', 'will', 'would', 'could', 'should',
	'may', 'can', 'each', 'every', 'both', 'also', 'into', 'than', 'then', 'when',
	'where', 'which', 'what', 'how', 'why', 'who', 'its', 'new', 'first', 'last',
	'same', 'other',
]);

const BEHAVIOR_TERMS = new Set([
	'approval', 'behavior', 'confidence', 'default', 'manual', 'ordering',
	'output', 'policy', 'review', 'rules', 'rule', 'threshold', 'validation',
	'workflow', 'state',
]);
const STRONG_SIGNAL_TERMS = new Set([
	'approval',
	'confidence',
	'manual',
	'policy',
	'review',
	'rule',
	'rules',
	'threshold',
]);

function tokenize(text) {
	return Array.from(new Set(
		text
			.toLowerCase()
			.split(/[^a-z0-9]+/)
			.filter((term) => term.length >= 3 && !STOP_WORDS.has(term)),
	));
}

function scoreBehavioralDependencies(normalizedInput) {
	const taskText = normalizedInput.taskContext.tasks
		.map((task) => task.whatToImplement)
		.join(' ');
	const taskTerms = tokenize(taskText).filter((term) => BEHAVIOR_TERMS.has(term));

	if (taskTerms.length === 0) {
		return {
			score: 0,
			findings: [],
			evidence: [],
			uncertain: false,
		};
	}

	const findings = [];
	const evidence = [];

	for (const issue of normalizedInput.openIssues) {
		const issueText = [issue.title, issue.description, issue.notes].filter(Boolean).join(' ');
		const issueTerms = new Set(tokenize(issueText));
		const sharedTerms = taskTerms.filter((term) => issueTerms.has(term));

		if (sharedTerms.length < 2) {
			continue;
		}

		const strongSignalCount = sharedTerms.filter((term) => STRONG_SIGNAL_TERMS.has(term)).length;
		const isUncertain = strongSignalCount < 2 || sharedTerms.length < 3;
		const signal = sharedTerms.some((term) => ['rule', 'rules', 'policy', 'approval'].includes(term))
			? 'rule-change-overlap'
			: 'behavior-change-overlap';
		const issueEvidence = sharedTerms.map((term) => ({
			type: 'behavior',
			targetIssueId: issue.id,
			sharedTerms: sharedTerms,
			term,
			scoreContribution: 1,
		}));

		findings.push({
			sourceIssueId: normalizedInput.currentIssue.id,
			targetIssueId: issue.id,
			score: sharedTerms.length,
			behavioralSignal: signal,
			uncertain: isUncertain,
			evidence: issueEvidence,
		});
		evidence.push(...issueEvidence);
	}

	return {
		score: findings.reduce((total, finding) => total + finding.score, 0),
		findings,
		evidence,
		uncertain: findings.some((finding) => finding.uncertain),
	};
}

module.exports = {
	scoreBehavioralDependencies,
};
