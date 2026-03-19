const { scoreImportDependencies } = require('./import-detector.js');
const { parseTaskFile } = require('./task-parser.js');
const { scoreContractDependencies } = require('./contract-detector.js');
const { scoreBehavioralDependencies } = require('./behavior-detector.js');
const { aggregateRubricScores, needsUserEscalation } = require('./rubric.js');
const { normalizeRepoPath } = require('./path-utils.js');

const CONFIDENCE_THRESHOLD = 0.7;
const DETECTOR_KEYS = Object.freeze([
	'importCallChain',
	'contractDependencies',
	'behavioralDependencies',
]);
const RUBRIC_WEIGHTS = Object.freeze({
	importCallChain: 3,
	contractDependencies: 3,
	behavioralDependencies: 2,
});

function createZeroedDetectorMap() {
	return DETECTOR_KEYS.reduce((result, key) => {
		result[key] = 0;
		return result;
	}, {});
}

function createEmptyDetectorEvidence() {
	return DETECTOR_KEYS.reduce((result, key) => {
		result[key] = [];
		return result;
	}, {});
}

function normalizeContractToken(contract) {
	if (typeof contract !== 'string') {
		return null;
	}

	const separatorIndex = contract.indexOf(':');
	if (separatorIndex === -1) {
		return contract;
	}

	return `${normalizeRepoPath(contract.slice(0, separatorIndex))}${contract.slice(separatorIndex)}`;
}

function normalizeContractNotes(notes = '') {
	return notes.replace(
		/^(contracts@\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z:\s*)(.+)$/gm,
		(_match, prefix, payload) => `${prefix}${payload.split(/\s+/).map(normalizeContractToken).join(' ')}`,
	);
}

function normalizeIssue(issue, label) {
	if (!issue || typeof issue !== 'object') {
		throw new Error(`${label} is required`);
	}

	if (!issue.id || typeof issue.id !== 'string') {
		throw new Error(`${label} id is required`);
	}

	return {
		id: issue.id,
		title: typeof issue.title === 'string' ? issue.title : '',
		description: typeof issue.description === 'string' ? issue.description : '',
		status: typeof issue.status === 'string' ? issue.status : '',
		contracts: Array.isArray(issue.contracts)
			? issue.contracts.map(normalizeContractToken).filter((contract) => typeof contract === 'string')
			: [],
		files: Array.isArray(issue.files)
			? issue.files
				.filter((file) => typeof file === 'string')
				.map((file) => normalizeRepoPath(file))
			: [],
		notes: typeof issue.notes === 'string' ? normalizeContractNotes(issue.notes) : '',
	};
}

function normalizePhase3Input(input = {}) {
	const currentIssue = normalizeIssue(input.currentIssue, 'Current issue');
	const openIssues = Array.isArray(input.openIssues)
		? input.openIssues.map((issue) => normalizeIssue(issue, 'Open issue'))
		: [];
	const taskContext = input.taskContext ?? parseTaskFile(input.taskFile);

	return {
		currentIssue,
		openIssues,
		taskContext,
		repositoryRoot: typeof input.repositoryRoot === 'string' && input.repositoryRoot
			? input.repositoryRoot
			: process.cwd(),
		thresholds: {
			confidence: CONFIDENCE_THRESHOLD,
		},
	};
}

function createScaffoldResult(normalizedInput) {
	const detectorScores = createZeroedDetectorMap();

	return {
		currentIssue: normalizedInput.currentIssue,
		taskContext: normalizedInput.taskContext,
		issues: [],
		scores: {
			...detectorScores,
			rubric: 0,
		},
		rubric: {
			score: 0,
			threshold: normalizedInput.thresholds.confidence,
			summary: 'No detector findings yet.',
			weights: RUBRIC_WEIGHTS,
			reasons: [],
		},
		detectorEvidence: createEmptyDetectorEvidence(),
		detectorConflicts: [],
		importCallChain: {
			score: 0,
			evidence: [],
			findings: [],
		},
		contractDependencies: {
			score: 0,
			evidence: [],
			findings: [],
		},
		behavioralDependencies: {
			score: 0,
			evidence: [],
			findings: [],
			uncertain: false,
		},
		confidence: {
			score: 1,
			threshold: normalizedInput.thresholds.confidence,
			belowThreshold: false,
			reasons: [],
		},
		proposals: [],
		needsUserDecision: false,
		metadata: {
			analyzerVersion: 'phase3-v1-scaffold',
			parser: '@babel/parser',
		},
	};
}

function inferDetectorType(finding) {
	if (finding.behavioralSignal) {
		return 'behavioralDependencies';
	}

	const firstEvidenceType = finding.evidence?.[0]?.type;
	if (firstEvidenceType === 'contract') {
		return 'contractDependencies';
	}

	return 'importCallChain';
}

function formatDetectorList(detectorTypes) {
	const labels = detectorTypes.map((type) => {
		if (type === 'importCallChain') {
			return 'import/call-chain evidence';
		}
		if (type === 'contractDependencies') {
			return 'contract evidence';
		}
		return 'behavioral evidence';
	});

	return labels.join(', ');
}

function buildDependencyProposals(normalizedInput, findings, rubricResult) {
	if (findings.length === 0) {
		return [];
	}

	const groupedFindings = new Map();
	for (const finding of findings) {
		const entry = groupedFindings.get(finding.targetIssueId) ?? {
			targetIssueId: finding.targetIssueId,
			detectorTypes: new Set(),
			hasBehavioralUncertainty: false,
		};
		entry.detectorTypes.add(inferDetectorType(finding));
		entry.hasBehavioralUncertainty = entry.hasBehavioralUncertainty || Boolean(finding.uncertain);
		groupedFindings.set(finding.targetIssueId, entry);
	}

	return Array.from(groupedFindings.values()).map((entry) => {
		const detectorTypes = Array.from(entry.detectorTypes);
		const reasons = [
			`${entry.targetIssueId} appears to consume or rely on logic being changed in ${normalizedInput.currentIssue.id} through ${formatDetectorList(detectorTypes)}.`,
		];
		const cons = [
			'Adds coordination overhead and may delay the dependent issue.',
		];

		if (entry.hasBehavioralUncertainty) {
			reasons.push('Behavioral evidence is heuristic and should be confirmed before applying the dependency.');
			cons.push('Behavioral evidence is heuristic and may be noisy until a human confirms the dependency.');
		}

		if (rubricResult.confidence.belowThreshold) {
			reasons.push(`Overall confidence ${rubricResult.confidence.score.toFixed(2)} is below the review threshold.`);
		}

		return {
			action: 'add-dependency',
			dependentIssueId: entry.targetIssueId,
			dependsOnIssueId: normalizedInput.currentIssue.id,
			detectorTypes,
			requiresApproval: true,
			confidence: rubricResult.confidence.score,
			reasons,
			pros: [
				'Preserves issue independence claims by sequencing affected work explicitly.',
				'Reduces merge-order surprises for downstream logic consumers.',
			],
			cons,
		};
	});
}

function analyzePhase3Dependencies(input = {}) {
	const normalizedInput = normalizePhase3Input(input);
	const result = createScaffoldResult(normalizedInput);
	const importResult = scoreImportDependencies(normalizedInput);
	const contractResult = scoreContractDependencies(normalizedInput);
	const behavioralResult = scoreBehavioralDependencies(normalizedInput);
	const rubricResult = aggregateRubricScores({
		importCallChain: importResult,
		contractDependencies: contractResult,
		behavioralDependencies: behavioralResult,
	}, {
		confidenceThreshold: normalizedInput.thresholds.confidence,
	});

	result.issues = [
		...importResult.findings,
		...contractResult.findings,
		...behavioralResult.findings,
	];
	result.scores.importCallChain = importResult.score;
	result.scores.contractDependencies = contractResult.score;
	result.scores.behavioralDependencies = behavioralResult.score;
	result.scores.rubric = rubricResult.total;
	result.rubric = rubricResult;
	result.detectorEvidence.importCallChain = importResult.evidence;
	result.detectorEvidence.contractDependencies = contractResult.evidence;
	result.detectorEvidence.behavioralDependencies = behavioralResult.evidence;
	result.detectorConflicts = rubricResult.detectorConflicts;
	result.confidence = rubricResult.confidence;
	result.needsUserDecision = needsUserEscalation(rubricResult);
	result.proposals = buildDependencyProposals(normalizedInput, result.issues, rubricResult);
	result.importCallChain = {
		score: importResult.score,
		evidence: importResult.evidence,
		findings: importResult.findings,
	};
	result.contractDependencies = {
		score: contractResult.score,
		evidence: contractResult.evidence,
		findings: contractResult.findings,
	};
	result.behavioralDependencies = {
		score: behavioralResult.score,
		evidence: behavioralResult.evidence,
		findings: behavioralResult.findings,
		uncertain: behavioralResult.uncertain,
	};

	return result;
}

module.exports = {
	analyzePhase3Dependencies,
	DETECTOR_KEYS,
	normalizePhase3Input,
};
