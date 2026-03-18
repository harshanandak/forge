const { detectContractType, extractTaskContracts } = require('./task-parser.js');

function parseContractToken(token) {
	const match = token.match(/^(.*):([A-Za-z_][A-Za-z0-9_]*)(?:\(([^)]+)\))?$/);
	if (!match) {
		return null;
	}

	return {
		contract: token,
		file: match[1],
		symbol: match[2],
		contractType: detectContractType(match[2], match[3]),
	};
}

function parseStoredContractsFromNotes(notes = '') {
	if (!notes || typeof notes !== 'string') {
		return [];
	}

	const matches = Array.from(notes.matchAll(/^contracts@(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z):\s*(.+)$/gm));
	if (matches.length === 0) {
		return [];
	}

	matches.sort((left, right) => left[1].localeCompare(right[1]));
	const latestPayload = matches[matches.length - 1][2];

	return latestPayload
		.split(/\s+/)
		.map((token) => token.trim())
		.filter(Boolean);
}

function mergeEvidence(evidence) {
	const seen = new Set();
	return evidence.filter((item) => {
		const key = `${item.contract}:${item.storedContract}:${item.targetIssueId}`;
		if (seen.has(key)) {
			return false;
		}
		seen.add(key);
		return true;
	});
}

async function scoreContractDependencies(normalizedInput) {
	const currentContracts = extractTaskContracts(normalizedInput.taskContext, {
		repositoryRoot: normalizedInput.repositoryRoot,
	})
		.map(parseContractToken)
		.filter(Boolean);

	if (currentContracts.length === 0) {
		return {
			score: 0,
			findings: [],
			evidence: [],
		};
	}

	const findings = [];
	const evidence = [];

	for (const issue of normalizedInput.openIssues) {
		const issueContracts = Array.from(new Set([
			...issue.contracts,
			...parseStoredContractsFromNotes(issue.notes),
		]))
			.map(parseContractToken)
			.filter(Boolean);

		const issueEvidence = [];
		for (const currentContract of currentContracts) {
			for (const storedContract of issueContracts) {
				if (
					currentContract.file !== storedContract.file
					|| currentContract.symbol !== storedContract.symbol
					|| currentContract.contractType !== storedContract.contractType
				) {
					continue;
				}

				issueEvidence.push({
					type: 'contract',
					sourceIssueId: normalizedInput.currentIssue.id,
					targetIssueId: issue.id,
					contract: currentContract.contract,
					storedContract: storedContract.contract,
					symbol: currentContract.symbol,
					contractType: currentContract.contractType,
					scoreContribution: 1,
				});
			}
		}

		if (issueEvidence.length === 0) {
			continue;
		}

		const mergedEvidence = mergeEvidence(issueEvidence);
		findings.push({
			sourceIssueId: normalizedInput.currentIssue.id,
			targetIssueId: issue.id,
			score: mergedEvidence.length,
			evidence: mergedEvidence,
		});
		evidence.push(...mergedEvidence);
	}

	return {
		score: findings.reduce((total, finding) => total + finding.score, 0),
		findings,
		evidence: mergeEvidence(evidence),
	};
}

module.exports = {
	parseStoredContractsFromNotes,
	scoreContractDependencies,
};
