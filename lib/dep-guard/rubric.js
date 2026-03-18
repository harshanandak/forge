const WEIGHTS = {
	importCallChain: 3,
	contractDependencies: 3,
	behavioralDependencies: 2,
};

const CONFLICT_MESSAGES = {
	materialDisagreement: 'Detector scores disagree materially across dependency categories.',
	behavioralUncertainty: 'Behavioral signals are heuristic and need manual review.',
};
const MAX_DETECTOR_STRENGTH = 3;
const MAX_TOTAL = Object.values(WEIGHTS)
	.reduce((sum, weight) => sum + (weight * MAX_DETECTOR_STRENGTH), 0);

function aggregateRubricScores(detectors, options = {}) {
	const confidenceThreshold = options.confidenceThreshold ?? 0.7;
	const dimensions = {};
	let total = 0;
	let hasMaterialDisagreement = false;
	let hasUncertainty = false;

	for (const [name, weight] of Object.entries(WEIGHTS)) {
		const raw = detectors[name]?.score ?? 0;
		const normalized = Math.min(raw, MAX_DETECTOR_STRENGTH);
		const weighted = normalized * weight;
		dimensions[name] = { raw, normalized, weighted };
		total += weighted;
		if (detectors[name]?.uncertain) {
			hasUncertainty = true;
		}
	}

	if (total === 0) {
		return {
			result: 'PASS',
			score: 0,
			total: 0,
			dimensions,
			weights: { ...WEIGHTS },
			confidence: {
				score: 1,
				threshold: confidenceThreshold,
				belowThreshold: false,
				reasons: [],
			},
			detectorConflicts: [],
			summary: 'No detector findings yet.',
			reasons: [],
		};
	}

	const rawScores = Object.values(dimensions).map((dimension) => dimension.raw);
	const nonZeroScores = rawScores.filter((score) => score > 0);
	const detectorConflicts = [];

	if (nonZeroScores.length >= 2 && (Math.max(...nonZeroScores) - Math.min(...nonZeroScores) >= 2)) {
		hasMaterialDisagreement = true;
		detectorConflicts.push(CONFLICT_MESSAGES.materialDisagreement);
	}

	if (hasUncertainty) {
		detectorConflicts.push(CONFLICT_MESSAGES.behavioralUncertainty);
	}

	let confidenceScore = total / MAX_TOTAL;
	if (hasMaterialDisagreement) {
		confidenceScore -= 0.2;
	}
	if (hasUncertainty) {
		confidenceScore -= 0.15;
	}
	confidenceScore = Math.max(0, Math.min(1, confidenceScore));
	const belowThreshold = confidenceScore < confidenceThreshold;

	const reasons = [];
	if (detectorConflicts.length > 0) {
		reasons.push(...detectorConflicts);
	}
	if (belowThreshold) {
		reasons.push(`Confidence ${confidenceScore.toFixed(2)} is below the ${(confidenceThreshold * 100).toFixed(0)}% threshold.`);
	}

	let result = 'PASS';
	if (detectorConflicts.length > 0) {
		result = 'INCONCLUSIVE';
	} else if (belowThreshold) {
		result = 'WEAK';
	}

	return {
		result,
		score: total,
		total,
		dimensions,
		weights: { ...WEIGHTS },
		confidence: {
			score: confidenceScore,
			threshold: confidenceThreshold,
			belowThreshold,
			reasons,
		},
		detectorConflicts,
		summary: reasons.join(' ') || 'Detector findings are consistent.',
		reasons,
	};
}

function needsUserEscalation(rubricResult) {
	return (
		rubricResult.result === 'INCONCLUSIVE'
		|| rubricResult.confidence.belowThreshold
		|| rubricResult.detectorConflicts.length > 0
	);
}

module.exports = {
	aggregateRubricScores,
	needsUserEscalation,
};
