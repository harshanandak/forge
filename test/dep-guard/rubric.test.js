const { describe, expect, test } = require('bun:test');

const {
	aggregateRubricScores,
	needsUserEscalation,
} = require('../../lib/dep-guard/rubric.js');

describe('lib/dep-guard/rubric.js', () => {
	test('aggregateRubricScores treats consistent detector coverage as a pass case', () => {
		const result = aggregateRubricScores({
			importCallChain: { score: 3, findings: [{}], evidence: [{}] },
			contractDependencies: { score: 3, findings: [{}], evidence: [{}] },
			behavioralDependencies: { score: 2, findings: [{}], evidence: [{}], uncertain: false },
		}, { confidenceThreshold: 0.7 });

		expect(result.result).toBe('PASS');
		expect(result.confidence.score).toBeGreaterThanOrEqual(0.7);
		expect(result.weights).toEqual({
			importCallChain: 3,
			contractDependencies: 3,
			behavioralDependencies: 2,
		});
		expect(result.detectorConflicts).toEqual([]);
		expect(needsUserEscalation(result)).toBe(false);
	});

	test('aggregateRubricScores marks detector disagreement and sub-threshold confidence', () => {
		const result = aggregateRubricScores({
			importCallChain: { score: 1, findings: [{}], evidence: [{}] },
			contractDependencies: { score: 4, findings: [{}], evidence: [{}] },
			behavioralDependencies: { score: 1, findings: [{}], evidence: [{}], uncertain: true },
		}, { confidenceThreshold: 0.7 });

		expect(result.detectorConflicts.length).toBeGreaterThan(0);
		expect(result.confidence.score).toBeLessThan(0.7);
		expect(result.detectorConflicts).toEqual(expect.arrayContaining([
			expect.stringMatching(/detector|behavioral|manual review|uncertain/i),
		]));
		expect(result.summary).toMatch(/manual review|confidence|uncertain/i);
		expect(needsUserEscalation(result)).toBe(true);
	});
});
