const { describe, expect, test } = require('bun:test');
const fs = require('node:fs');
const path = require('node:path');

const { evaluateKernelEvent } = require('../../lib/kernel/evaluators');

const fixturePath = path.join(__dirname, '..', 'fixtures', 'kernel-evaluators', 'cases.json');
const fixtureCases = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));

describe('Kernel evaluator fixtures', () => {
	test('cover the required conflict evaluator release scenarios', () => {
		expect(fixtureCases.map(fixture => fixture.name)).toEqual([
			'import fidelity accepts matching revision',
			'priority ordering dedupes equivalent rank write',
			'dependency correctness quarantines cycle',
			'idempotency returns original accepted event',
			'drift guard quarantines stale revision',
		]);
	});

	for (const fixture of fixtureCases) {
		test(fixture.name, () => {
			const result = evaluateKernelEvent(fixture.input);

			expect(result).toMatchObject(fixture.expected);
			if (fixture.expected.decision === 'quarantine') {
				expect(result.conflict).toMatchObject({
					status: 'quarantined',
					entity_type: fixture.input.event.entity_type,
					entity_id: fixture.input.event.entity_id,
				});
			}
		});
	}
});
