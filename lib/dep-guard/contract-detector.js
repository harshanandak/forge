const { detectContractType, extractTaskContracts } = require('./task-parser.js');
const { normalizeRepoPath } = require('./path-utils.js');

function isIdentifier(name) {
	return typeof name === 'string' && /^[A-Za-z_]\w*$/.test(name);
}

function parseContractToken(token) {
	if (typeof token !== 'string') {
		return null;
	}

	const trimmed = token.trim();
	if (!trimmed) {
		return null;
	}

	let annotation = '';
	let contractTarget = trimmed;
	const openParenIndex = trimmed.lastIndexOf('(');
	if (openParenIndex !== -1 && trimmed.endsWith(')')) {
		annotation = trimmed.slice(openParenIndex + 1, -1);
		contractTarget = trimmed.slice(0, openParenIndex);
	}

	const separatorIndex = contractTarget.lastIndexOf(':');
	if (separatorIndex <= 0 || separatorIndex === contractTarget.length - 1) {
		return null;
	}

	const file = normalizeRepoPath(contractTarget.slice(0, separatorIndex));
	const symbol = contractTarget.slice(separatorIndex + 1);
	if (!isIdentifier(symbol)) {
		return null;
	}

	const contractType = detectContractType(symbol, annotation);
	return {
		contract: `${file}:${symbol}(${contractType})`,
		file,
		symbol,
		contractType,
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
	const latestPayload = matches.at(-1)[2];

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

function scoreContractDependencies(normalizedInput) {
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
