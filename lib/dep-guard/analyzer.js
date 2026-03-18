const { scoreImportDependencies } = require('./import-detector.js');
const { parseTaskFile } = require('./task-parser.js');

const CONFIDENCE_THRESHOLD = 0.7;
const DETECTOR_KEYS = Object.freeze([
	'importCallChain',
	'contractDependencies',
	'behavioralDependencies',
]);

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
		contracts: Array.isArray(issue.contracts) ? issue.contracts : [],
		files: Array.isArray(issue.files) ? issue.files.filter((file) => typeof file === 'string') : [],
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
			weights: detectorScores,
			reasons: [],
		},
		detectorEvidence: createEmptyDetectorEvidence(),
		detectorConflicts: [],
		importCallChain: {
			score: 0,
			evidence: [],
			findings: [],
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

async function analyzePhase3Dependencies(input = {}) {
	const normalizedInput = normalizePhase3Input(input);
	const result = createScaffoldResult(normalizedInput);
	const importResult = await scoreImportDependencies(normalizedInput);

	result.issues = importResult.findings;
	result.scores.importCallChain = importResult.score;
	result.scores.rubric = importResult.score;
	result.rubric.score = importResult.score;
	result.rubric.weights.importCallChain = importResult.score;
	result.detectorEvidence.importCallChain = importResult.evidence;
	result.importCallChain = {
		score: importResult.score,
		evidence: importResult.evidence,
		findings: importResult.findings,
	};

	return result;
}

module.exports = {
	analyzePhase3Dependencies,
	DETECTOR_KEYS,
	normalizePhase3Input,
};
